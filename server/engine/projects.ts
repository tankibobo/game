/**
 * Project progress model.
 *
 * Work is measured in effective FTE-days. Daily capacity on working days:
 *   capacity = effectiveFTE × productivity × moraleFactor
 *   effectiveFTE = fte (fte ≤ base) or base·(fte/base)^0.72 (Brooks's law)
 * Open issues linked to the project absorb `drag` share of capacity while
 * they are worked off. Remaining capacity flows to milestones in sequence
 * (work can run ahead on later milestones), but a milestone only completes
 * when its work is done, all earlier milestones are complete and its gates
 * (issue resolved, supply capacity secured, not-before dates) are satisfied.
 */
import type { Gate, Issue, Milestone, Project, ProjectEffect } from '../../shared/domain';
import { addDays, diffDays, isWorkingDay, type SimDate } from '../../shared/dates';
import { scale, type Cents } from '../../shared/money';
import { engineeringFreeFte } from './metrics';
import { groupCapacity } from './operations';
import { PARAMS } from './params';
import { adjustTrust, byId, emit, inbox, recordHistory, remember, type World } from './world';

export const ACTIVE_STATUSES = new Set(['active', 'delayed', 'blocked']);

export function effectiveFte(p: Project): number {
  if (p.staffingFte <= p.baseFte) return p.staffingFte;
  return p.baseFte * Math.pow(p.staffingFte / p.baseFte, PARAMS.staffingExponent);
}

export function moraleFactor(w: World, p: Project): number {
  const dep = byId(w.departments, p.departmentId);
  return dep ? 0.85 + 0.3 * (dep.morale / 100) : 1;
}

/** Scale factor if engineering headcount fell below committed staffing (attrition). */
export function staffingCoverage(w: World): number {
  const free = engineeringFreeFte(w);
  if (free >= 0) return 1;
  const used = w.projects.filter((p) => ACTIVE_STATUSES.has(p.status)).reduce((a, p) => a + p.staffingFte, 0);
  return used > 0 ? Math.max(0.3, (used + free) / used) : 1;
}

export function dailyCapacity(w: World, p: Project): number {
  return effectiveFte(p) * p.productivity * moraleFactor(w, p) * staffingCoverage(w);
}

export function projectIssues(w: World, p: Project): Issue[] {
  return w.issues.filter((i) => i.projectId === p.id && !['resolved', 'closed'].includes(i.status) && i.resolutionWorkTotal > 0);
}

export function milestonesOf(w: World, projectId: string): Milestone[] {
  return w.milestones.filter((m) => m.projectId === projectId).sort((a, b) => a.seq - b.seq);
}

export function gateStatus(w: World, g: Gate, d: SimDate, asOfCapacity?: SimDate): { ok: boolean; text: string } {
  switch (g.type) {
    case 'issue_resolved': {
      const iss = byId(w.issues, g.issueId);
      const ok = !iss || ['resolved', 'closed'].includes(iss.status);
      return { ok, text: ok ? `${iss?.title ?? g.issueId}: resolved` : `Waiting for issue: ${iss?.title}` };
    }
    case 'supply_capacity': {
      const cap = groupCapacity(w, g.supplyIds, asOfCapacity);
      const ok = cap >= g.minDaily;
      return { ok, text: ok ? `Supply capacity ${cap}/day ≥ ${g.minDaily}` : `Supply capacity ${cap}/day < required ${g.minDaily}/day` };
    }
    case 'not_before': {
      const ok = d >= g.date;
      return { ok, text: ok ? `${g.reason}: available` : `${g.reason}: not before ${g.date}` };
    }
  }
}

function costPerFteDay(w: World, p: Project): Cents {
  const dep = byId(w.departments, p.departmentId);
  return Math.round(((dep?.annualCostPerHeadCents ?? 8_000_000) * w.meta.wageIndex) / 365);
}

export function progressProjects(w: World): void {
  const d = w.meta.currentDate;
  const working = isWorkingDay(d);
  for (const p of w.projects) {
    if (!ACTIVE_STATUSES.has(p.status)) continue;
    // Internal labour cost is a management-accounting allocation of payroll (memo only).
    const internal = Math.round(p.staffingFte * costPerFteDay(w, p));
    p.internalCostCents += internal;
    p.spentCents += internal;
    if (!working) continue;

    let cap = dailyCapacity(w, p);
    // Issues absorb part of the capacity.
    for (const iss of projectIssues(w, p)) {
      const share = cap * iss.drag;
      iss.resolutionWorkDone = Math.min(iss.resolutionWorkTotal, iss.resolutionWorkDone + share);
      if (iss.resolutionWorkDone >= iss.resolutionWorkTotal - 1e-6) resolveIssue(w, iss, 'Engineering work completed.');
    }
    const drag = Math.min(0.6, projectIssues(w, p).reduce((a, i) => a + i.drag, 0));
    cap = cap * (1 - drag);

    // Flow work through milestones in sequence.
    let left = cap;
    for (const m of milestonesOf(w, p.id)) {
      if (left <= 0) break;
      if (m.status === 'completed' || m.status === 'skipped') continue;
      const room = m.workTotal - m.workDone;
      if (room <= 0) continue;
      const take = Math.min(room, left);
      m.workDone += take;
      left -= take;
      if (m.status === 'pending') m.status = 'in_progress';
      if (m.externalCostCents > 0 && m.workTotal > 0) {
        const ext = scale(m.externalCostCents, take / m.workTotal);
        p.externalAccrualCents += ext;
        p.externalSpentCents += ext;
        p.spentCents += ext;
      }
    }
    checkMilestones(w, p);
  }
}

export function checkMilestones(w: World, p: Project): void {
  const d = w.meta.currentDate;
  const ms = milestonesOf(w, p.id);
  for (const m of ms) {
    if (m.status === 'completed' || m.status === 'skipped') continue;
    const workDone = m.workDone >= m.workTotal - 1e-6;
    const gates = m.gates.map((g) => gateStatus(w, g, d));
    const blockedBy = gates.filter((g) => !g.ok);
    if (workDone && blockedBy.length === 0) {
      m.status = 'completed';
      m.completedDate = d;
      m.workDone = m.workTotal;
      recordHistory(w, { projectId: p.id, field: `milestone:${m.id}`, oldValue: 'open', newValue: 'completed', reason: `${m.name} completed`, actionId: null });
      emit(w, { type: 'milestone_completed', category: 'project', severity: 'notice', title: `${p.name}: “${m.name}” completed`, description: d > m.plannedDate ? `Completed ${diffDays(d, m.plannedDate)} days after the plan (${m.plannedDate}).` : `Completed on or ahead of plan (${m.plannedDate}).`, causeKind: 'causal', cause: { text: 'Work completed and all gates satisfied.', refs: [{ type: 'milestone', id: m.id }] }, entities: [{ type: 'project', id: p.id }, { type: 'milestone', id: m.id }] });
      continue; // next milestone may complete the same day
    }
    if (workDone && blockedBy.length > 0 && m.status !== 'blocked') {
      m.status = 'blocked';
      emit(w, { type: 'milestone_blocked', category: 'project', severity: 'warning', title: `${p.name}: “${m.name}” blocked`, description: `Work is complete but the milestone cannot close: ${blockedBy.map((g) => g.text).join('; ')}.`, causeKind: 'causal', cause: { text: 'Milestone gate not satisfied.', refs: [{ type: 'milestone', id: m.id }] }, entities: [{ type: 'project', id: p.id }, { type: 'milestone', id: m.id }] });
    }
    if (!m.lateFlagged && d > m.plannedDate) {
      m.lateFlagged = 1;
      emit(w, { type: 'milestone_overdue', category: 'project', severity: 'warning', title: `${p.name}: “${m.name}” overdue`, description: `Planned for ${m.plannedDate}; ${Math.round((m.workDone / Math.max(1, m.workTotal)) * 100)}% of the work is done${blockedBy.length ? `; blocked by: ${blockedBy.map((g) => g.text).join('; ')}` : ''}.`, causeKind: 'causal', entities: [{ type: 'project', id: p.id }, { type: 'milestone', id: m.id }] });
    }
    break; // milestones complete strictly in order
  }
  if (ms.length > 0 && ms.every((m) => m.status === 'completed' || m.status === 'skipped')) completeProject(w, p);
  else {
    const blocked = ms.some((m) => m.status === 'blocked');
    const newStatus = blocked ? 'blocked' : p.forecastDate && p.forecastDate > p.targetDate ? 'delayed' : d > p.targetDate ? 'delayed' : 'active';
    if (newStatus !== p.status) {
      recordHistory(w, { projectId: p.id, field: 'status', oldValue: p.status, newValue: newStatus, reason: blocked ? 'A milestone is blocked by an unmet gate.' : newStatus === 'delayed' ? 'Forecast completion is later than the target date.' : 'Back on track.', actionId: null });
      p.status = newStatus;
    }
  }
}

export function completeProject(w: World, p: Project): void {
  const d = w.meta.currentDate;
  const old = p.status;
  p.status = 'completed';
  p.completedDate = d;
  recordHistory(w, { projectId: p.id, field: 'status', oldValue: old, newValue: 'completed', reason: 'All milestones completed.', actionId: null });
  const effects = applyProjectEffects(w, p.completionEffects);
  emit(w, { type: 'project_completed', category: 'project', severity: 'notice', title: `${p.name} completed`, description: `${d <= p.targetDate ? 'On time' : `${diffDays(d, p.targetDate)} days late`}. ${effects.join(' ')}`, causeKind: 'causal', entities: [{ type: 'project', id: p.id }], consequences: effects.map((text) => ({ text })) });
  adjustTrust(w, p.managerId, 3);
  adjustTrust(w, p.sponsorId, 2);
}

export function applyProjectEffects(w: World, effects: ProjectEffect[]): string[] {
  const d = w.meta.currentDate;
  const out: string[] = [];
  for (const e of effects) {
    switch (e.type) {
      case 'model_appeal': {
        const m = byId(w.models, e.modelId);
        if (m) {
          m.baseAppeal += e.delta;
          out.push(`${m.name} appeal ${e.delta > 0 ? '+' : ''}${e.delta}.`);
        }
        break;
      }
      case 'model_quality': {
        for (const m of w.models) if (e.modelId === '*' || m.id === e.modelId) m.quality = Math.min(100, m.quality + e.delta);
        out.push(`Quality ${e.delta > 0 ? '+' : ''}${e.delta} (${e.modelId === '*' ? 'all models' : byId(w.models, e.modelId)?.name}).`);
        break;
      }
      case 'model_cost': {
        const m = byId(w.models, e.modelId);
        if (m) {
          m.otherMaterialCostCents += e.deltaCents;
          out.push(`${m.name} unit cost ${e.deltaCents > 0 ? '+' : '−'}€${Math.abs(e.deltaCents / 100).toLocaleString('en-GB')}.`);
        }
        break;
      }
      case 'model_co2': {
        const m = byId(w.models, e.modelId);
        if (m) {
          m.co2Gkm = e.gkm;
          out.push(`${m.name} CO₂ now ${e.gkm} g/km.`);
        }
        break;
      }
      case 'model_euro7': {
        const m = byId(w.models, e.modelId);
        if (m) {
          m.euro7Compliant = 1;
          out.push(`${m.name} certified to Euro 7.`);
        }
        break;
      }
      case 'model_launch': {
        const m = byId(w.models, e.modelId);
        if (m) {
          m.status = 'in_production';
          m.lifecycle = 'launch';
          m.launchDate = d;
          for (const l of w.lines.filter((x) => x.modelId === m.id)) {
            l.status = 'ramp_up';
            l.rampStartDate = d;
          }
          // Development cost starts amortising at SOP.
          const proj = byId(w.projects, m.projectId ?? '');
          if (proj?.capitalizeExternal) w.meta.amortizingDevCents += proj.externalSpentCents;
          out.push(`${m.name} enters series production (ramp-up over ${w.lines.find((x) => x.modelId === m.id)?.rampDays ?? 60} days).`);
          inbox(w, { kind: 'report', fromId: 'CHR-FERRER', subject: `${m.name}: start of production`, body: `The first series ${m.name} left the Brno line today. Ramp-up to the planned rate will take about ten weeks, subject to battery-pack deliveries and the Brno crew.`, priority: 'high', linked: [{ type: 'model', id: m.id }] });
        }
        break;
      }
      case 'factory_overhead_pct': {
        const f = byId(w.factories, e.factoryId);
        if (f) {
          f.fixedOverheadMonthlyCents = scale(f.fixedOverheadMonthlyCents, 1 + e.pct);
          out.push(`${f.name} overhead ${(e.pct * 100).toFixed(0)}%.`);
        }
        break;
      }
      case 'factory_crew_pct': {
        const f = byId(w.factories, e.factoryId);
        if (f) {
          f.crewPerDailyUnit = Math.round(f.crewPerDailyUnit * (1 + e.pct) * 100) / 100;
          out.push(`${f.name} crew requirement ${(e.pct * 100).toFixed(0)}%.`);
        }
        break;
      }
      case 'line_capacity': {
        const l = byId(w.lines, e.lineId);
        if (l) {
          l.maxDailyRate += e.delta;
          out.push(`${l.name} capacity +${e.delta}/day.`);
        }
        break;
      }
      case 'supply_capacity': {
        const s = byId(w.supplies, e.supplyId);
        if (s) {
          s.dailyCapacity = Math.max(s.dailyCapacity, e.dailyCapacity);
          out.push(`${s.component} capacity ${e.dailyCapacity}/day.`);
        }
        break;
      }
      case 'segment_ref_price_pct': {
        const m = byId(w.models, e.modelId);
        if (m) {
          m.baseAppeal += e.pct * 100 * 0.8;
          out.push(`${m.name} positioned upmarket (appeal supports ~${(e.pct * 100).toFixed(0)}% higher price).`);
        }
        break;
      }
      case 'warranty_pct': {
        for (const m of w.models) m.warrantyPerUnitCents = scale(m.warrantyPerUnitCents, 1 + e.pct);
        out.push(`Warranty cost ${(e.pct * 100).toFixed(0)}% on all models.`);
        break;
      }
      case 'distribution': {
        w.meta.distributionUtility += e.delta;
        out.push(`Distribution reach improved.`);
        break;
      }
    }
  }
  return out;
}

export function resolveIssue(w: World, iss: Issue, note: string): void {
  if (['resolved', 'closed'].includes(iss.status)) return;
  iss.status = 'resolved';
  iss.resolvedDate = w.meta.currentDate;
  iss.resolutionNote = note;
  iss.resolutionWorkDone = iss.resolutionWorkTotal;
  emit(w, { type: 'issue_resolved', category: 'project', severity: 'notice', title: `Resolved: ${iss.title}`, description: note, causeKind: 'causal', entities: [{ type: 'issue', id: iss.id }, ...iss.linked] });
  if (iss.ownerId) {
    adjustTrust(w, iss.ownerId, 2);
    remember(w, { characterId: iss.ownerId, kind: 'observation', summary: `Issue resolved: ${iss.title}. ${note}`, importance: 3, sentiment: 1, sourceType: 'issue', sourceId: iss.id, entityRefs: [{ type: 'issue', id: iss.id }] });
  }
}

// ---------------------------------------------------------------- forecasting a single project

export interface ProjectForecast {
  p50: SimDate | null;
  p80: SimDate | null;
  blockedBy: string[];
  milestoneDates: Record<string, SimDate | null>;
}

/**
 * Deterministic projection of a project's completion: replays the progress
 * model day by day on copies of the milestone/issue state, assuming current
 * staffing, no new problems, and gates opening on their known dates. Supply
 * gates only open if contracted capacity (incl. signed pending increases)
 * meets the requirement. P80 adds a risk buffer for open issues.
 */
export function forecastProject(w: World, p: Project, maxDays = 1100, opts: { assumeSupply?: boolean } = {}): ProjectForecast {
  const ms = milestonesOf(w, p.id).map((m) => ({ ...m }));
  const issues = projectIssues(w, p).map((i) => ({ ...i }));
  const out: ProjectForecast = { p50: null, p80: null, blockedBy: [], milestoneDates: {} };
  for (const m of ms) if (m.status === 'completed') out.milestoneDates[m.id] = m.completedDate;
  const capBase = dailyCapacity(w, p);
  let d = w.meta.currentDate;
  for (let i = 0; i < maxDays; i++) {
    if (isWorkingDay(d)) {
      let cap = capBase;
      let drag = 0;
      for (const iss of issues) {
        if (iss.resolutionWorkDone >= iss.resolutionWorkTotal) continue;
        iss.resolutionWorkDone += cap * iss.drag;
        drag += iss.drag;
      }
      cap *= 1 - Math.min(0.6, drag);
      for (const m of ms) {
        if (cap <= 0) break;
        if (m.status === 'completed') continue;
        const take = Math.min(cap, m.workTotal - m.workDone);
        if (take > 0) {
          m.workDone += take;
          cap -= take;
        }
      }
    }
    for (const m of ms) {
      if (m.status === 'completed') continue;
      if (m.workDone < m.workTotal - 1e-6) break;
      const gatesOk = m.gates.every((g) => {
        if (g.type === 'issue_resolved') {
          const fi = issues.find((x) => x.id === g.issueId);
          if (fi) return fi.resolutionWorkDone >= fi.resolutionWorkTotal - 1e-6;
          return gateStatus(w, g, d).ok;
        }
        if (g.type === 'supply_capacity') return opts.assumeSupply || gateStatus(w, g, d, d).ok;
        return gateStatus(w, g, d).ok;
      });
      if (!gatesOk) break;
      m.status = 'completed';
      out.milestoneDates[m.id] = d;
    }
    if (ms.every((m) => m.status === 'completed')) {
      out.p50 = d;
      break;
    }
    d = addDays(d, 1);
  }
  if (!out.p50) {
    const stuck = ms.find((m) => m.status !== 'completed');
    if (stuck) {
      const gs = stuck.gates.map((g) => gateStatus(w, g, addDays(w.meta.currentDate, maxDays), addDays(w.meta.currentDate, maxDays))).filter((g) => !g.ok);
      out.blockedBy = gs.length ? gs.map((g) => g.text) : [`${stuck.name}: not completable within the forecast horizon`];
    }
    return out;
  }
  const remaining = diffDays(out.p50, w.meta.currentDate);
  const openRisk = projectIssues(w, p).reduce((a, i) => a + (i.severity === 'critical' ? 25 : i.severity === 'high' ? 15 : 7) * Number(i.data.riskFactor ?? 1), 0);
  out.p80 = addDays(out.p50, Math.round(remaining * 0.12 + openRisk));
  return out;
}

export function updateProjectForecasts(w: World): void {
  for (const p of w.projects) {
    if (!ACTIVE_STATUSES.has(p.status)) continue;
    const f = forecastProject(w, p);
    p.forecastDate = f.p50;
    p.forecastP80Date = f.p80;
  }
}
