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
import { groupCapacity, steadyStateCrew } from './operations';
import { modelMonthlyDemand } from './demand';
import { templateByKey, type Reaction } from '../actions/templates';
import { PARAMS } from './params';
import { adjustTrust, byId, emit, inbox, recordHistory, remember, rngFor, type World } from './world';

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
  // Projects the CEO designed deliver a share of the expected effect (drawn once, deterministic per seed).
  let effects = p.completionEffects;
  if (p.custom) {
    if (p.custom.outcome === null) p.custom.outcome = Math.round((0.6 + 0.6 * rngFor(w).u(d, 'custom-outcome', p.id)) * 100) / 100;
    effects = effects.map((e) => scaleEffect(e, p.custom!.outcome!));
  }
  const lines = applyProjectEffects(w, effects);
  p.impact = lines;
  const t = p.templateKey ? templateByKey(p.templateKey) : undefined;
  const outcomeNote = p.custom ? ` The result came in at ${Math.round((p.custom.outcome ?? 1) * 100)}% of what was expected.` : '';
  emit(w, { type: 'project_completed', category: 'project', severity: 'notice', title: `${p.name} completed`, description: `${d <= p.targetDate ? 'On time' : `${diffDays(d, p.targetDate)} days late`}.${outcomeNote} ${lines.join(' ')}`, causeKind: 'causal', entities: [{ type: 'project', id: p.id }], consequences: lines.map((text) => ({ text })) });
  adjustTrust(w, p.managerId, 3);
  adjustTrust(w, p.sponsorId, 2);
  // The project manager reports what changed — and what still has to be done to realise it.
  inbox(w, {
    kind: 'report',
    fromId: p.managerId,
    subject: `Completed: ${p.name}`,
    body: [`${p.name} is complete${d <= p.targetDate ? ', on time' : `, ${diffDays(d, p.targetDate)} days after target`}. Budget used: €${Math.round(p.spentCents / 1e8)}m of €${Math.round(p.budgetCents / 1e8)}m.${outcomeNote}`, '', 'What changed:', ...lines.map((l) => `• ${l}`), ...(t?.followUp ? ['', `Next: ${t.followUp}`] : [])].join('\n'),
    priority: 'high',
    linked: [{ type: 'project', id: p.id }],
  });
  for (const r of t?.reactions?.onComplete ?? []) applyReaction(w, r, p.id);
}

/** A stakeholder reacts to a project: trust, morale and a message to the CEO. */
export function applyReaction(w: World, r: Reaction, projectId: string): void {
  const c = byId(w.characters, r.characterId);
  if (!c || !c.active) return;
  if (r.trust) adjustTrust(w, c.id, r.trust);
  if (r.morale) {
    const dep = byId(w.departments, r.morale.departmentId);
    if (dep) dep.morale = Math.max(0, Math.min(100, dep.morale + r.morale.delta));
  }
  remember(w, { characterId: c.id, kind: r.trust < 0 ? 'grievance' : 'observation', summary: `${r.subject}: ${r.body.slice(0, 220)}`, importance: 3, sentiment: r.trust < 0 ? -1 : r.trust > 0 ? 1 : 0, sourceType: 'project', sourceId: projectId, entityRefs: [{ type: 'project', id: projectId }] });
  inbox(w, { kind: 'letter', fromId: c.id, subject: r.subject, body: r.body, priority: r.trust < -2 ? 'high' : 'normal', linked: [{ type: 'project', id: projectId }, { type: 'character', id: c.id }] });
  emit(w, { type: r.trust < 0 ? 'stakeholder_objection' : 'stakeholder_reaction', category: 'people', severity: r.trust < -2 ? 'warning' : 'info', title: `${c.name}: ${r.subject}`, description: r.body.slice(0, 240), causeKind: 'causal', entities: [{ type: 'character', id: c.id }, { type: 'project', id: projectId }] });
}

function scaleEffect(e: ProjectEffect, k: number): ProjectEffect {
  switch (e.type) {
    case 'model_appeal':
    case 'model_quality':
    case 'morale':
    case 'absenteeism':
    case 'trust':
      return { ...e, delta: Math.round(e.delta * k * 10) / 10 };
    case 'line_capacity':
      return { ...e, delta: Math.round((e.delta * k) / 5) * 5 };
    case 'model_cost':
      return { ...e, deltaCents: Math.round(e.deltaCents * k) };
    case 'factory_overhead_pct':
    case 'factory_crew_pct':
    case 'warranty_pct':
    case 'material_pct':
    case 'marketing_efficiency':
      return { ...e, pct: Math.round(e.pct * k * 1000) / 1000 };
    case 'distribution':
      return { ...e, delta: Math.round(e.delta * k * 1000) / 1000 };
    default:
      return e;
  }
}

const eu = (c: number) => `€${Math.round(c / 100).toLocaleString('en-GB')}`;
const em = (c: number) => `€${(c / 1e8).toFixed(1)}m`;
const n0 = (x: number) => Math.round(x).toLocaleString('en-GB');
const onSale = (w: World) => w.models.filter((m) => m.status === 'in_production');
const demandOf = (w: World, ids?: string[]) => onSale(w).filter((m) => !ids || ids.includes(m.id)).reduce((a, m) => a + modelMonthlyDemand(w, m, w.meta.currentDate), 0);
const unitsOf = (w: World, m: World['models'][number]) => m.retailLastMonth || modelMonthlyDemand(w, m, w.meta.currentDate);

/**
 * Apply completion effects and describe each one as measured: before → after,
 * with its value at today's volumes, so the player can see what changed.
 */
export function applyProjectEffects(w: World, effects: ProjectEffect[]): string[] {
  const d = w.meta.currentDate;
  const out: string[] = [];
  for (const e of effects) {
    switch (e.type) {
      case 'model_appeal': {
        const m = byId(w.models, e.modelId);
        if (m) {
          const before = demandOf(w, [m.id]);
          m.baseAppeal += e.delta;
          const after = demandOf(w, [m.id]);
          out.push(`${m.name} is more attractive (appeal ${e.delta > 0 ? '+' : ''}${e.delta}): demand ${n0(before)} → ${n0(after)} cars a month (${pctChange(before, after)}).`);
        }
        break;
      }
      case 'model_quality': {
        const ids = w.models.filter((m) => e.modelId === '*' || m.id === e.modelId).map((m) => m.id);
        const before = demandOf(w, ids);
        for (const m of w.models) if (ids.includes(m.id)) m.quality = Math.min(100, m.quality + e.delta);
        const after = demandOf(w, ids);
        out.push(`Build quality ${e.delta > 0 ? '+' : ''}${e.delta} (${e.modelId === '*' ? 'all models' : byId(w.models, e.modelId)?.name}): demand ${pctChange(before, after)} (${n0(after - before)} cars a month).`);
        break;
      }
      case 'model_cost': {
        const m = byId(w.models, e.modelId);
        if (m) {
          const before = m.otherMaterialCostCents;
          m.otherMaterialCostCents += e.deltaCents;
          const yearly = e.deltaCents * unitsOf(w, m) * 12;
          out.push(`${m.name} material cost ${eu(before)} → ${eu(m.otherMaterialCostCents)} of parts per car (${e.deltaCents < 0 ? 'saves' : 'costs'} ≈${em(Math.abs(yearly))} a year at current volumes).`);
        }
        break;
      }
      case 'material_pct': {
        let yearly = 0;
        for (const m of w.models) {
          if (e.modelId !== '*' && m.id !== e.modelId) continue;
          const delta = Math.round(m.otherMaterialCostCents * e.pct);
          m.otherMaterialCostCents += delta;
          if (m.status === 'in_production') yearly += delta * unitsOf(w, m) * 12;
        }
        out.push(`Material cost ${(e.pct * 100).toFixed(1)}% on ${e.modelId === '*' ? 'every model' : byId(w.models, e.modelId)?.name} (${yearly < 0 ? 'saves' : 'costs'} ≈${em(Math.abs(yearly))} a year at current volumes).`);
        break;
      }
      case 'model_co2': {
        const m = byId(w.models, e.modelId);
        if (m) {
          const before = m.co2Gkm;
          m.co2Gkm = e.gkm;
          out.push(`${m.name} CO₂ ${before} → ${e.gkm} g/km (≈${eu(Math.round((before - e.gkm) * PARAMS.co2PenaltyPerGramPerVehicleCents))} less penalty per car while the fleet is above target).`);
        }
        break;
      }
      case 'model_euro7': {
        const m = byId(w.models, e.modelId);
        if (m) {
          m.euro7Compliant = 1;
          out.push(`${m.name} certified to Euro 7 — it can still be sold after the cut-off.`);
        }
        break;
      }
      case 'model_feature': {
        for (const m of w.models) {
          if (e.modelId !== '*' && m.id !== e.modelId) continue;
          if (!m.features.includes(e.feature)) m.features = [...m.features.filter((f) => !(e.feature.startsWith('Order online') && f === 'Sold through dealers') && !(e.feature.startsWith('48V') && f.startsWith('1.2-litre'))), e.feature];
        }
        out.push(`New on ${e.modelId === '*' ? 'every model' : byId(w.models, e.modelId)?.name}: ${e.feature}.`);
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
          const before = f.fixedOverheadMonthlyCents;
          f.fixedOverheadMonthlyCents = scale(f.fixedOverheadMonthlyCents, 1 + e.pct);
          out.push(`${f.name} overhead ${em(before)} → ${em(f.fixedOverheadMonthlyCents)} a month (${e.pct < 0 ? 'saves' : 'costs'} ≈${em(Math.abs((f.fixedOverheadMonthlyCents - before) * 12))} a year).`);
        }
        break;
      }
      case 'factory_crew_pct': {
        const f = byId(w.factories, e.factoryId);
        if (f) {
          const before = steadyStateCrew(w, f);
          const per0 = f.crewPerDailyUnit;
          f.crewPerDailyUnit = Math.round(f.crewPerDailyUnit * (1 + e.pct) * 100) / 100;
          const after = steadyStateCrew(w, f);
          const dep = byId(w.departments, f.departmentId);
          const surplus = dep ? dep.headcount - Math.round(after / (1 - f.absenteeismPct / 100)) : 0;
          const crewLine = before - after >= 1 ? `${f.name} needs ${n0(before - after)} fewer people at the planned rate (${n0(before)} → ${n0(after)} on the lines).` : `${f.name} needs ${Math.round(-e.pct * 100)}% fewer people per car built (${per0.toFixed(2)} → ${f.crewPerDailyUnit.toFixed(2)} per car a day); its lines are barely running now, so the saving shows when output rises.`;
          out.push(`${crewLine}${surplus > 50 && dep ? ` It now has about ${n0(surplus)} more people than it needs — ≈${em(Math.round(surplus * dep.annualCostPerHeadCents * w.meta.wageIndex))} a year of payroll until headcount comes down.` : ''}`);
        }
        break;
      }
      case 'line_capacity': {
        const l = byId(w.lines, e.lineId);
        if (l) {
          const before = l.maxDailyRate;
          l.maxDailyRate += e.delta;
          out.push(`${l.name} capacity ${before} → ${l.maxDailyRate} cars a day (the planned rate stays ${l.plannedDailyRate} until you raise it).`);
        }
        break;
      }
      case 'supply_capacity': {
        const s = byId(w.supplies, e.supplyId);
        if (s) {
          const before = s.dailyCapacity;
          s.dailyCapacity = Math.max(s.dailyCapacity, e.dailyCapacity);
          out.push(`${s.component} capacity ${before} → ${s.dailyCapacity} a day.`);
        }
        break;
      }
      case 'segment_ref_price_pct': {
        const m = byId(w.models, e.modelId);
        if (m) {
          const before = demandOf(w, [m.id]);
          m.baseAppeal += e.pct * 100 * 0.8;
          const after = demandOf(w, [m.id]);
          out.push(`${m.name} positioned upmarket: at today’s price demand ${n0(before)} → ${n0(after)} a month; it can carry a price about ${(e.pct * 100).toFixed(0)}% higher for the same demand.`);
        }
        break;
      }
      case 'warranty_pct': {
        let yearly = 0;
        for (const m of w.models) {
          const before = m.warrantyPerUnitCents;
          m.warrantyPerUnitCents = scale(m.warrantyPerUnitCents, 1 + e.pct);
          if (m.status === 'in_production') yearly += (m.warrantyPerUnitCents - before) * unitsOf(w, m) * 12;
        }
        out.push(`Warranty cost ${(e.pct * 100).toFixed(0)}% on every car (${yearly < 0 ? 'saves' : 'costs'} ≈${em(Math.abs(yearly))} a year).`);
        break;
      }
      case 'distribution': {
        const before = demandOf(w);
        w.meta.distributionUtility += e.delta;
        const after = demandOf(w);
        out.push(`Sales reach widened: demand for Asterion cars ${pctChange(before, after)} (≈${n0(after - before)} more buyers a month at today’s prices).`);
        break;
      }
      case 'marketing_efficiency': {
        const before = demandOf(w);
        const eff0 = w.meta.marketingEfficiency;
        w.meta.marketingEfficiency = Math.round(w.meta.marketingEfficiency * (1 + e.pct) * 100) / 100;
        const after = demandOf(w);
        out.push(`Each marketing euro now works ${Math.round(e.pct * 100)}% harder (efficiency ${eff0.toFixed(2)} → ${w.meta.marketingEfficiency.toFixed(2)}): at today’s budget demand ${pctChange(before, after)} (≈${n0(after - before)} cars a month).`);
        break;
      }
      case 'morale': {
        for (const dep of w.departments) if (e.departmentId === '*' || dep.id === e.departmentId) dep.morale = Math.max(0, Math.min(100, dep.morale + e.delta));
        out.push(`Morale ${e.delta > 0 ? '+' : ''}${e.delta} ${e.departmentId === '*' ? 'across the company' : `at ${byId(w.departments, e.departmentId)?.name}`}.`);
        break;
      }
      case 'absenteeism': {
        for (const f of w.factories) if (e.factoryId === '*' || f.id === e.factoryId) f.absenteeismPct = Math.max(2, Math.round((f.absenteeismPct + e.delta) * 10) / 10);
        out.push(`Absenteeism ${e.delta > 0 ? '+' : ''}${e.delta} point${Math.abs(e.delta) === 1 ? '' : 's'} at ${e.factoryId === '*' ? 'every plant' : byId(w.factories, e.factoryId)?.name} — more output from the same crews.`);
        break;
      }
      case 'trust': {
        const c = byId(w.characters, e.characterId);
        if (c) {
          adjustTrust(w, c.id, e.delta);
          out.push(`${c.name} (${c.orgName}) ${e.delta > 0 ? 'appreciates it' : 'resents it'} (trust ${e.delta > 0 ? '+' : ''}${e.delta}).`);
        }
        break;
      }
    }
  }
  return out;
}

function pctChange(before: number, after: number): string {
  if (before <= 0) return 'n/a';
  const x = (after / before - 1) * 100;
  return `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
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
