import { z } from 'zod';
import type { Project } from '../../../shared/domain';
import { addDays, diffDays, isSimDate } from '../../../shared/dates';
import { fmtEur, mEur, scale } from '../../../shared/money';
import { bal, post } from '../../engine/ledger';
import { engineeringFreeFte, liquidity } from '../../engine/metrics';
import { RULES } from '../../engine/params';
import { applyProjectEffects, applyReaction, effectiveFte, forecastProject, milestonesOf, resolveIssue } from '../../engine/projects';
import { adjustTrust, byId, clamp, emit, inbox, nextId, recordHistory, remember, type World } from '../../engine/world';
import { PROJECT_TEMPLATES, buildProject, templateByKey } from '../templates';
import { CUSTOM_KINDS, CUSTOM_KIND_BY_KEY, customTemplate, validateCustom, type CustomSize } from '../custom';
import { describeEffect } from '../../reports/catalog';
import { meetingForSubmission } from '../../engine/board';
import { ok, type ActionDef } from '../types';

function remainingBudget(p: Project): number {
  return p.budgetCents - p.spentCents;
}

export const approveProject: ActionDef<{ projectId: string }> = {
  type: 'approve_project',
  label: 'Approve a proposed project',
  description: 'Approve a project that is awaiting a decision (status “proposed”), allocating its budget and staff.',
  llmProposable: true,
  affectsForecast: true,
  amountCents: (w, p) => byId(w.projects, p.projectId)?.budgetCents ?? 0,
  schema: z.object({ projectId: z.string() }),
  validate: (w, p) => {
    const pr = byId(w.projects, p.projectId);
    if (!pr) return { errors: ['Unknown project.'], warnings: [] };
    if (pr.status !== 'proposed') return { errors: [`Project is ${pr.status}, not awaiting approval.`], warnings: [] };
    const v = ok();
    const replacement = w.projects.find((x) => x.id !== pr.id && !['cancelled', 'completed', 'proposed'].includes(x.status) && x.templateKey && templateByKey(x.templateKey)?.supersedes?.includes(pr.templateKey ?? ''));
    if (replacement) v.errors.push(`${replacement.name} (${replacement.id}) already covers this work; approving both would duplicate it.`);
    const free = engineeringFreeFte(w);
    if (pr.staffingFte > free) v.errors.push(`Needs ${pr.staffingFte} engineers; only ${Math.floor(free)} are free. Hire engineers or reduce staffing on another project first.`);
    return v;
  },
  preview: (w, p) => {
    const pr = byId(w.projects, p.projectId)!;
    const f = forecastProject(w, { ...pr, status: 'active' });
    return {
      summary: `Approve ${pr.name} (${fmtEur(pr.budgetCents)}, ${pr.staffingFte} FTE)`,
      consequences: [
        { label: 'Budget committed', amountCents: -pr.budgetCents, timing: `spent as work progresses to ~${pr.targetDate}`, kind: 'cash' },
        { label: `Forecast completion ${f.p50 ?? 'n/a'} (P80 ${f.p80 ?? 'n/a'}) vs target ${pr.targetDate} (estimate)`, kind: 'operational' },
        { label: `${pr.staffingFte} engineers allocated (free afterwards: ${Math.floor(engineeringFreeFte(w) - pr.staffingFte)})`, kind: 'people' },
      ],
      approvals: pr.budgetCents > RULES.ceoSpendLimitCents ? [{ approver: 'board', reason: `Budget above the CEO limit of ${fmtEur(RULES.ceoSpendLimitCents)}.` }] : [],
    };
  },
  boardAnalysis: (w, p) => projectAnalysis(w, byId(w.projects, p.projectId)!.budgetCents, byId(w.projects, p.projectId)!),
  commit: (w, p, ctx) => {
    const pr = byId(w.projects, p.projectId)!;
    pr.status = 'active';
    pr.startDate = w.meta.currentDate;
    pr.lastDecision = `Approved by the CEO on ${w.meta.currentDate}.`;
    const first = milestonesOf(w, pr.id)[0];
    if (first && first.status === 'pending') first.status = 'in_progress';
    recordHistory(w, { projectId: pr.id, field: 'status', oldValue: 'proposed', newValue: 'active', reason: 'Approved', actionId: ctx.actionId });
    adjustTrust(w, pr.sponsorId, 3);
    for (const r of (pr.templateKey ? templateByKey(pr.templateKey)?.reactions?.onStart : undefined) ?? []) applyReaction(w, r, pr.id);
    emit(w, { type: 'project_approved', category: 'project', severity: 'notice', title: `${pr.name} approved`, description: `Budget ${fmtEur(pr.budgetCents)}, ${pr.staffingFte} FTE, target ${pr.targetDate}.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'project', id: pr.id }] });
    return { summary: 'Project approved', details: [] };
  },
};

/** Is a project unavoidable? Euro 7 compliance for a model that cannot otherwise be sold, or work that unblocks the Eon. */
export function projectNecessity(w: World, p: { templateKey?: string | null; linkedModelId?: string | null; effects?: { type: string; modelId?: string }[]; id?: string; kind?: string; priority?: string }): number {
  const euro7 = (p.effects ?? []).some((e) => e.type === 'model_euro7' && !byId(w.models, e.modelId ?? '')?.euro7Compliant) || p.templateKey === 'vela_euro7';
  if (euro7) return 0.85;
  const eonBlockedBySupply = w.issues.some((i) => i.id === 'ISS-VOLTARIS' && !['resolved', 'closed'].includes(i.status));
  if (p.templateKey === 'second_battery_source' && eonBlockedBySupply) return 0.6;
  if (p.id === 'PRJ-EON') return 0.6;
  if (p.priority === 'critical') return 0.5;
  return 0;
}

function projectAnalysis(w: World, budget: number, p?: Partial<Project> & { effects?: { type: string; modelId?: string }[] }) {
  const kind = p?.kind;
  // Expected recurring benefit once delivered (rough yearly payback the directors assume).
  const payback = kind === 'industrial' || kind === 'cost' ? 0.3 : kind === 'quality' ? 0.4 : kind === 'vehicle_program' ? 0.22 : kind === 'commercial' ? 0.2 : 0.1;
  return {
    cashImpactCents: -budget,
    minLiquidityAfterCents: (w.meta.lastForecastSummary?.minLiquidityCents ?? liquidity(w)) - budget,
    leverageAfter: 0,
    annualProfitImpactCents: Math.round(budget * payback),
    jobsImpact: 0,
    ev: p?.linkedModelId === 'MDL-EON' || p?.templateKey === 'compact_ev' || p?.templateKey === 'second_battery_source' || p?.templateKey === 'brno_eon_expansion' ? 0.8 : p?.templateKey === 'vela_hybrid_refresh' ? 0.3 : 0,
    growth: kind === 'vehicle_program' || kind === 'commercial' ? 0.5 : 0.1,
    dilutionPct: 0,
    risk: budget > mEur(500) ? 0.7 : budget > mEur(100) ? 0.35 : 0.2,
    cfoSupport: budget > liquidity(w) * 0.3 ? -0.8 : budget > mEur(150) ? -0.2 : 0.3,
    necessity: p ? projectNecessity(w, p) : 0,
  };
}

export const startProject: ActionDef<{ templateKey: string }> = {
  type: 'start_project',
  label: 'Start a new project',
  description: `Start a project from the catalogue: ${PROJECT_TEMPLATES.map((t) => `${t.key} (${t.name})`).join('; ')}.`,
  llmProposable: true,
  affectsForecast: true,
  amountCents: (_w, p) => templateByKey(p.templateKey)?.budgetCents ?? 0,
  schema: z.object({ templateKey: z.string() }),
  validate: (w, p) => {
    const t = templateByKey(p.templateKey);
    if (!t) return { errors: [`Unknown project template "${p.templateKey}".`], warnings: [] };
    const v = ok();
    const underWay = (key: string) => w.projects.some((x) => x.templateKey === key && !['cancelled', 'completed', 'proposed'].includes(x.status));
    const done = w.projects.find((x) => x.templateKey === t.key && x.status === 'completed');
    if (done && !t.repeatable) v.errors.push(`${t.name} was completed on ${done.completedDate}; its effects are already in place.`);
    if (w.projects.some((x) => x.templateKey === t.key && !['cancelled', 'completed'].includes(x.status))) v.errors.push(`${t.name} is already ${w.projects.find((x) => x.templateKey === t.key && !['cancelled', 'completed'].includes(x.status))?.status === 'proposed' ? 'proposed — approve it on the Projects page' : 'under way'}.`);
    const why = t.available?.({ hasActive: underWay, modelStatus: (id) => byId(w.models, id)?.status });
    if (why) v.errors.push(why);
    for (const old of supersededProposals(w, t.key)) v.warnings.push(`This replaces the proposed project “${old.name}” (${old.id}), which will be withdrawn when this one starts.`);
    const free = engineeringFreeFte(w);
    if (t.fte > free) v.errors.push(`Needs ${t.fte} engineers; only ${Math.max(0, Math.floor(free))} are free. Hire engineers (≈90 days) or release staff from another project.`);
    if (t.budgetCents > liquidity(w) * 0.5) v.warnings.push('This budget is large relative to current liquidity.');
    return v;
  },
  preview: (w, p) => {
    const t = templateByKey(p.templateKey)!;
    const viaBoard = t.budgetCents > RULES.ceoSpendLimitCents;
    const raw = templateForecast(w, t);
    // A board decision starts on the meeting day: shift the forecast by the wait.
    const wait = viaBoard ? Math.max(0, diffDays(meetingForSubmission(w), w.meta.currentDate)) : 0;
    const fc = { p50: raw.p50 ? addDays(raw.p50, wait) : null, p80: raw.p80 ? addDays(raw.p80, wait) : null };
    const startNote = viaBoard ? ` if it starts on the board meeting day (${meetingForSubmission(w)})` : '';
    const euro7 = t.effects.some((e) => e.type === 'model_euro7') ? byId(w.regulations, 'REG-EURO7') : undefined;
    const cutoff = euro7 ? String(euro7.params.allNewCarsDate ?? '') : '';
    return {
      summary: `Start ${t.name}`,
      consequences: [
        { label: `Forecast completion ${fc.p50 ?? 'cannot be forecast'}${fc.p80 ? ` (P80 ${fc.p80})` : ''}${startNote} — estimate`, kind: 'operational' },
        ...(cutoff && fc.p50 && fc.p50 > cutoff ? [{ label: `Forecast completion is after the Euro 7 cut-off (${cutoff}): the ${byId(w.models, t.linkedModelId ?? '')?.name ?? 'model'} could not be registered from ${cutoff} until it is certified. Adding engineers (Re-plan) or the plain compliance project would avoid the gap.`, kind: 'risk' as const }] : cutoff && fc.p80 && fc.p80 > cutoff ? [{ label: `Tight: the pessimistic forecast (P80 ${fc.p80}) is after the Euro 7 cut-off (${cutoff}).`, kind: 'risk' as const }] : []),
        { label: 'Budget (external spend as work progresses; engineers are existing payroll)', amountCents: -t.budgetCents, timing: `over ~${Math.round(t.durationDays / 30)} months`, kind: 'cash' },
        { label: `${t.fte} engineers allocated`, kind: 'people' },
        { label: `Strategy: ${t.strategy}. ${t.tradeoffs}`, kind: 'info' },
        ...t.risks.map((r) => ({ label: r.text, kind: 'risk' as const })),
      ],
      approvals: t.budgetCents > RULES.ceoSpendLimitCents ? [{ approver: 'board', reason: `Budget ${fmtEur(t.budgetCents)} exceeds the CEO limit of ${fmtEur(RULES.ceoSpendLimitCents)}.` }] : [],
    };
  },
  boardAnalysis: (w, p) => {
    const t = templateByKey(p.templateKey)!;
    return projectAnalysis(w, t.budgetCents, { kind: t.kind, linkedModelId: t.linkedModelId, templateKey: t.key, effects: t.effects, priority: t.priority });
  },
  commit: (w, p, ctx) => {
    const t = templateByKey(p.templateKey)!;
    for (const old of supersededProposals(w, t.key)) {
      old.status = 'cancelled';
      old.lastDecision = `${w.meta.currentDate}: withdrawn — replaced by ${t.name}.`;
      recordHistory(w, { projectId: old.id, field: 'status', oldValue: 'proposed', newValue: 'cancelled', reason: `Replaced by ${t.name}`, actionId: ctx.actionId });
      emit(w, { type: 'project_withdrawn', category: 'project', severity: 'info', title: `${old.name} withdrawn`, description: `Replaced by ${t.name}, which covers the same work.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'project', id: old.id }] });
    }
    const id = nextId(w, 'PRJ');
    const { project, milestones } = buildProject(t, id, w.meta.currentDate, t.milestones.map(() => nextId(w, 'MS')));
    w.projects.push(project);
    w.milestones.push(...milestones);
    planToForecast(w, project);
    recordHistory(w, { projectId: id, field: 'status', oldValue: null, newValue: 'active', reason: `Started from template ${t.key}`, actionId: ctx.actionId });
    adjustTrust(w, t.sponsorId, 2);
    for (const r of t.reactions?.onStart ?? []) applyReaction(w, r, id);
    emit(w, { type: 'project_started', category: 'project', severity: 'notice', title: `${t.name} started`, description: `Budget ${fmtEur(t.budgetCents)}, ${t.fte} FTE, target ${project.targetDate}.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'project', id }] });
    return { summary: 'Project started', details: [id], result: { projectId: id } };
  },
};

type CustomPayload = { name: string; kind: string; targetId?: string | null; size: CustomSize; reason?: string };

export const startCustomProject: ActionDef<CustomPayload> = {
  type: 'start_custom_project',
  label: 'Start your own project',
  description: `Design a project: kind (${CUSTOM_KINDS.map((k) => k.key).join(', ')}), target (plant, line or model where needed) and size (small/medium/large). The engine sizes budget, engineers and duration and sets the expected effect; the actual result is 60–120% of it.`,
  llmProposable: true,
  affectsForecast: true,
  amountCents: (w, p) => (CUSTOM_KIND_BY_KEY.get(p.kind) ? customTemplate(w, { ...p, targetId: p.targetId ?? null }).budgetCents : 0),
  schema: z.object({ name: z.string().max(80).default(''), kind: z.string(), targetId: z.string().nullable().optional(), size: z.enum(['small', 'medium', 'large']), reason: z.string().max(300).optional() }),
  validate: (w, p) => {
    const errs = validateCustom(w, { ...p, targetId: p.targetId ?? null });
    if (errs.length) return { errors: errs, warnings: [] };
    const t = customTemplate(w, { ...p, targetId: p.targetId ?? null });
    const v = ok();
    const free = engineeringFreeFte(w);
    if (t.fte > free) v.errors.push(`Needs ${t.fte} engineers; only ${Math.max(0, Math.floor(free))} are free. Choose a smaller size, hire engineers (≈90 days) or release staff from another project.`);
    return v;
  },
  preview: (w, p) => {
    const t = customTemplate(w, { ...p, targetId: p.targetId ?? null });
    const viaBoard = t.budgetCents > RULES.ceoSpendLimitCents;
    const fc = templateForecast(w, t);
    return {
      summary: `Start your project: ${t.name}`,
      consequences: [
        { label: `Forecast completion ${fc.p50 ?? 'n/a'} (estimate)`, kind: 'operational' },
        { label: 'Budget', amountCents: -t.budgetCents, timing: `over ~${Math.round(t.durationDays / 30)} months`, kind: 'cash' },
        { label: `${t.fte} engineers allocated`, kind: 'people' },
        ...t.effects.map((e) => ({ label: `Expected: ${describeEffect(w, e)}`, kind: 'info' as const })),
        ...t.risks.map((r) => ({ label: r.text, kind: 'risk' as const })),
      ],
      approvals: viaBoard ? [{ approver: 'board', reason: `Budget ${fmtEur(t.budgetCents)} exceeds the CEO limit of ${fmtEur(RULES.ceoSpendLimitCents)}.` }] : [],
    };
  },
  boardAnalysis: (w, p) => {
    const t = customTemplate(w, { ...p, targetId: p.targetId ?? null });
    return projectAnalysis(w, t.budgetCents, { kind: t.kind, linkedModelId: t.linkedModelId, templateKey: t.key, effects: t.effects, priority: t.priority });
  },
  commit: (w, p, ctx) => {
    const spec = { ...p, targetId: p.targetId ?? null };
    const t = customTemplate(w, spec);
    const id = nextId(w, 'PRJ');
    const { project, milestones } = buildProject(t, id, w.meta.currentDate, t.milestones.map(() => nextId(w, 'MS')));
    project.custom = { kind: p.kind, targetId: spec.targetId, size: p.size, outcome: null };
    w.projects.push(project);
    w.milestones.push(...milestones);
    planToForecast(w, project);
    recordHistory(w, { projectId: id, field: 'status', oldValue: null, newValue: 'active', reason: `Your own project (${p.kind}, ${p.size})`, actionId: ctx.actionId });
    adjustTrust(w, t.sponsorId, 2);
    emit(w, { type: 'project_started', category: 'project', severity: 'notice', title: `${t.name} started`, description: `Your own project. Budget ${fmtEur(t.budgetCents)}, ${t.fte} FTE, target ${project.targetDate}.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'project', id }] });
    return { summary: 'Project started', details: [id], result: { projectId: id } };
  },
};

/** The engine's completion forecast for a catalogue project started today. */
export function templateForecast(w: World, t: NonNullable<ReturnType<typeof templateByKey>>, start = w.meta.currentDate): { p50: string | null; p80: string | null } {
  const { project, milestones } = buildProject(t, 'PRJ-PREVIEW', start, t.milestones.map((_, i) => `MS-PREVIEW-${i}`));
  return forecastProject({ ...w, projects: [...w.projects, project], milestones: [...w.milestones, ...milestones] }, project);
}

/** New projects are planned to the engine's own forecast, so a fresh project is never "late" on day one. */
function planToForecast(w: World, pr: Project): void {
  const f = forecastProject(w, pr);
  if (!f.p50 || f.p50 <= pr.targetDate || !pr.startDate) return;
  const days = diffDays(f.p50, pr.startDate);
  const ms = milestonesOf(w, pr.id);
  const total = ms.reduce((a, m) => a + m.workTotal, 0);
  let cum = 0;
  for (const m of ms) {
    cum += m.workTotal;
    m.plannedDate = addDays(pr.startDate, Math.round((days * cum) / Math.max(1, total)));
    m.originalPlannedDate = m.plannedDate;
  }
  pr.targetDate = f.p50;
  pr.originalTargetDate = f.p50;
  pr.forecastDate = f.p50;
  pr.forecastP80Date = f.p80;
}

/** Proposed (never approved) projects that a template replaces. */
export function supersededProposals(w: World, templateKey: string): Project[] {
  const t = templateByKey(templateKey);
  return w.projects.filter((x) => x.status === 'proposed' && !!x.templateKey && (t?.supersedes ?? []).includes(x.templateKey));
}

/** Staffing needed for a project to finish by a date (binary search on the forecast model). */
export function staffingForDate(w: World, pr: Project, date: string): number {
  let lo = Math.max(10, Math.round(pr.baseFte * 0.4));
  let hi = Math.round(pr.baseFte * 1.5);
  const fits = (fte: number) => {
    const f = forecastProject(w, { ...pr, staffingFte: fte }, 1100, { assumeSupply: true });
    return !!f.p50 && f.p50 <= date;
  };
  if (!fits(hi)) return hi;
  if (fits(lo)) return lo;
  while (hi - lo > 10) {
    const mid = Math.round((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface ScopeChange {
  projectId: string;
  newTargetDate?: string;
  staffingDelta?: number;
  budgetDeltaCents?: number;
  descopePct?: number;
  replan?: boolean;
  reason: string;
}

function plannedScope(w: World, pr: Project, p: ScopeChange): { staffing: number; target: string; budget: number } {
  let staffing = pr.staffingFte + (p.staffingDelta ?? 0);
  const target = p.newTargetDate ?? pr.targetDate;
  if (p.newTargetDate && p.newTargetDate > pr.targetDate && p.replan !== false && p.staffingDelta === undefined) {
    // Re-plan to the later date: release staff the slower schedule no longer needs.
    staffing = Math.min(pr.staffingFte, staffingForDate(w, pr, target));
  }
  return { staffing, target, budget: pr.budgetCents + (p.budgetDeltaCents ?? 0) };
}

export const changeProjectScope: ActionDef<ScopeChange> = {
  type: 'change_project_scope',
  label: 'Change project scope, staffing, budget or target date',
  description: 'Re-plan a project: move its target date (a later date releases staff and stretches spend), add/remove engineers (with diminishing returns), change budget, or descope remaining work (lowers the linked model’s quality).',
  llmProposable: true,
  affectsForecast: true,
  amountCents: (_w, p) => Math.max(0, p.budgetDeltaCents ?? 0),
  schema: z.object({
    projectId: z.string(),
    newTargetDate: z.string().optional(),
    staffingDelta: z.number().int().min(-2000).max(2000).optional(),
    budgetDeltaCents: z.number().int().optional(),
    descopePct: z.number().min(0).max(0.3).optional(),
    replan: z.boolean().optional(),
    reason: z.string().min(3).max(600),
  }),
  validate: (w, p) => {
    const pr = byId(w.projects, p.projectId);
    if (!pr) return { errors: [`Unknown project ${p.projectId}.`], warnings: [] };
    const v = ok();
    if (!['active', 'delayed', 'blocked', 'approved', 'proposed'].includes(pr.status)) v.errors.push(`Project is ${pr.status}; it cannot be re-planned.`);
    if (p.newTargetDate === undefined && p.staffingDelta === undefined && p.budgetDeltaCents === undefined && p.descopePct === undefined) v.errors.push('No change specified.');
    if (p.newTargetDate !== undefined) {
      if (!isSimDate(p.newTargetDate)) v.errors.push('Target date must be YYYY-MM-DD.');
      else if (p.newTargetDate <= w.meta.currentDate) v.errors.push('Target date must be in the future.');
      else if (p.newTargetDate === pr.targetDate) v.errors.push('Target date unchanged.');
    }
    if (p.staffingDelta) {
      const free = engineeringFreeFte(w);
      if (p.staffingDelta > free) v.errors.push(`Only ${Math.max(0, Math.floor(free))} engineers are free; adding ${p.staffingDelta} requires hiring (≈90 days) or taking them from another project.`);
      if (Math.abs(p.staffingDelta) > 400) v.errors.push('Staffing can change by at most 400 FTE at once (onboarding limits).');
      if (pr.staffingFte + p.staffingDelta < 10) v.errors.push('Staffing cannot fall below 10 FTE; cancel the project instead.');
    }
    if (p.budgetDeltaCents !== undefined && pr.budgetCents + p.budgetDeltaCents < pr.spentCents) v.errors.push('Budget cannot be cut below what has already been spent.');
    if (p.descopePct && pr.linkedModelId) v.warnings.push('Descoping lowers the quality of the linked vehicle.');
    if (p.newTargetDate && isSimDate(p.newTargetDate) && p.newTargetDate < pr.targetDate) {
      const f = forecastProject(w, { ...pr, staffingFte: plannedScope(w, pr, p).staffing });
      if (!f.p50 || f.p50 > p.newTargetDate) v.warnings.push(`At the planned staffing, the forecast completion (${f.p50 ?? 'blocked'}) is later than the requested date. A date alone does not make work go faster.`);
    }
    return v;
  },
  preview: (w, p) => {
    const pr = byId(w.projects, p.projectId)!;
    const plan = plannedScope(w, pr, p);
    const before = forecastProject(w, pr);
    const ms = milestonesOf(w, pr.id).map((m) => ({ ...m }));
    if (p.descopePct) for (const m of ms) if (m.status !== 'completed') m.workTotal = m.workDone + (m.workTotal - m.workDone) * (1 - p.descopePct);
    const sim: World = { ...w, milestones: [...w.milestones.filter((m) => m.projectId !== pr.id), ...ms] };
    const after = forecastProject(sim, { ...pr, staffingFte: plan.staffing });
    const cons = [
      { label: `Forecast completion ${before.p50 ?? 'blocked'} → ${after.p50 ?? 'blocked'} (P80 ${after.p80 ?? 'n/a'}; estimate)`, kind: 'operational' as const },
      ...(plan.staffing !== pr.staffingFte ? [{ label: `Staffing ${Math.round(pr.staffingFte)} → ${Math.round(plan.staffing)} FTE (effective capacity ${Math.round(effectiveFte(pr))} → ${Math.round(effectiveFte({ ...pr, staffingFte: plan.staffing }))})`, kind: 'people' as const }] : []),
      ...(plan.target !== pr.targetDate ? [{ label: `Target date ${pr.targetDate} → ${plan.target} (original target ${pr.originalTargetDate} stays on record)`, kind: 'info' as const }] : []),
      ...(p.budgetDeltaCents ? [{ label: 'Budget change', amountCents: -p.budgetDeltaCents, kind: 'cash' as const }] : []),
      ...(p.descopePct ? [{ label: `Remaining work −${Math.round(p.descopePct * 100)}%; linked model quality −${Math.round(p.descopePct * 20)}`, kind: 'risk' as const }] : []),
    ];
    if (pr.id === 'PRJ-EON' && plan.target > w.meta.boardPlan.eonSopDate) cons.push({ label: `Eon SOP moves beyond the board plan (${w.meta.boardPlan.eonSopDate}); the board will react to the revised forecast. Later SOP → less Eon revenue and higher CO₂ cost.`, kind: 'risk' as const });
    if (pr.id === 'PRJ-EON' && plan.target > '2028-03-31') cons.push({ label: 'Beyond 31 March 2028 the EIB may demand prepayment of its €400m loan.', kind: 'risk' as const });
    const approvals = (p.budgetDeltaCents ?? 0) > RULES.ceoSpendLimitCents ? [{ approver: 'board' as const, reason: `Budget increase above ${fmtEur(RULES.ceoSpendLimitCents)} requires board approval.` }] : [];
    return { summary: `Re-plan ${pr.name}`, consequences: cons, approvals };
  },
  boardAnalysis: (w, p) => projectAnalysis(w, Math.max(0, p.budgetDeltaCents ?? 0), byId(w.projects, p.projectId)),
  commit: (w, p, ctx) => {
    const pr = byId(w.projects, p.projectId)!;
    const plan = plannedScope(w, pr, p);
    const details: string[] = [];
    if (plan.target !== pr.targetDate) {
      recordHistory(w, { projectId: pr.id, field: 'targetDate', oldValue: pr.targetDate, newValue: plan.target, reason: p.reason, actionId: ctx.actionId });
      const shift = diffDays(plan.target, pr.targetDate);
      for (const m of milestonesOf(w, pr.id)) {
        if (m.status === 'completed') continue;
        const newPlanned = addDays(m.plannedDate, Math.round(shift * Math.min(1, Math.max(0, diffDays(m.plannedDate, w.meta.currentDate)) / Math.max(1, diffDays(pr.targetDate, w.meta.currentDate)))));
        if (newPlanned !== m.plannedDate) {
          recordHistory(w, { projectId: pr.id, field: `milestone:${m.id}:plannedDate`, oldValue: m.plannedDate, newValue: newPlanned, reason: p.reason, actionId: ctx.actionId });
          m.plannedDate = newPlanned;
          if (newPlanned > w.meta.currentDate) m.lateFlagged = 0;
        }
      }
      details.push(`Target ${pr.targetDate} → ${plan.target}`);
      pr.targetDate = plan.target;
    }
    if (plan.staffing !== pr.staffingFte) {
      recordHistory(w, { projectId: pr.id, field: 'staffingFte', oldValue: String(Math.round(pr.staffingFte)), newValue: String(Math.round(plan.staffing)), reason: p.reason, actionId: ctx.actionId });
      details.push(`Staffing ${Math.round(pr.staffingFte)} → ${Math.round(plan.staffing)} FTE`);
      if (plan.staffing > pr.staffingFte) {
        const dep = byId(w.departments, pr.departmentId);
        if (dep) dep.morale = clamp(dep.morale + 2, 0, 100);
      }
      pr.staffingFte = plan.staffing;
    }
    if (p.budgetDeltaCents) {
      recordHistory(w, { projectId: pr.id, field: 'budgetCents', oldValue: String(pr.budgetCents), newValue: String(plan.budget), reason: p.reason, actionId: ctx.actionId });
      details.push(`Budget ${fmtEur(pr.budgetCents)} → ${fmtEur(plan.budget)}`);
      pr.budgetCents = plan.budget;
    }
    if (p.descopePct) {
      for (const m of milestonesOf(w, pr.id)) if (m.status !== 'completed') m.workTotal = m.workDone + (m.workTotal - m.workDone) * (1 - p.descopePct);
      const model = byId(w.models, pr.linkedModelId ?? '');
      if (model) model.quality = clamp(model.quality - Math.round(p.descopePct * 20), 0, 100);
      recordHistory(w, { projectId: pr.id, field: 'scope', oldValue: '100%', newValue: `${Math.round((1 - p.descopePct) * 100)}% of remaining work`, reason: p.reason, actionId: ctx.actionId });
      details.push(`Descoped remaining work by ${Math.round(p.descopePct * 100)}%`);
    }
    pr.lastDecision = `${w.meta.currentDate}: ${details.join('; ')} — ${p.reason}`;
    const f = forecastProject(w, pr);
    pr.forecastDate = f.p50;
    pr.forecastP80Date = f.p80;
    remember(w, { characterId: pr.managerId, kind: 'decision', summary: `The CEO re-planned ${pr.name}: ${details.join('; ')}. Reason given: ${p.reason}`, importance: 4, sentiment: 0, sourceType: 'action', sourceId: ctx.actionId, entityRefs: [{ type: 'project', id: pr.id }] });
    emit(w, { type: 'project_replanned', category: 'project', severity: 'notice', title: `${pr.name} re-planned`, description: `${details.join('; ')}. Reason: ${p.reason}. Forecast completion now ${f.p50 ?? 'blocked'}.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'project', id: pr.id }] });
    return { summary: 'Project re-planned', details };
  },
};

export const proposeBudget: ActionDef<{ projectId: string; amountCents: number; reason: string }> = {
  type: 'propose_budget',
  label: 'Budget increase for a project',
  description: 'Request additional budget for a project. Must be approved by someone with sufficient authority (CFO ≤ €10m, CEO ≤ €50m, board above).',
  llmProposable: true,
  affectsForecast: false,
  amountCents: (_w, p) => p.amountCents,
  schema: z.object({ projectId: z.string(), amountCents: z.number().int().positive(), reason: z.string().min(3).max(600) }),
  validate: (w, p) => {
    const pr = byId(w.projects, p.projectId);
    if (!pr) return { errors: ['Unknown project.'], warnings: [] };
    if (['completed', 'cancelled'].includes(pr.status)) return { errors: [`Project is ${pr.status}.`], warnings: [] };
    return remainingBudget(pr) > p.amountCents * 3 ? { errors: [], warnings: ['The project still has substantial unspent budget.'] } : ok();
  },
  preview: (w, p) => {
    const pr = byId(w.projects, p.projectId)!;
    return { summary: `Increase ${pr.name} budget by ${fmtEur(p.amountCents)}`, consequences: [{ label: 'Additional approved budget', amountCents: -p.amountCents, kind: 'cash' }], approvals: p.amountCents > RULES.ceoSpendLimitCents ? [{ approver: 'board', reason: `Above the CEO limit of ${fmtEur(RULES.ceoSpendLimitCents)}.` }] : [] };
  },
  boardAnalysis: (w, p) => projectAnalysis(w, p.amountCents, byId(w.projects, p.projectId)),
  commit: (w, p, ctx) => {
    const pr = byId(w.projects, p.projectId)!;
    recordHistory(w, { projectId: pr.id, field: 'budgetCents', oldValue: String(pr.budgetCents), newValue: String(pr.budgetCents + p.amountCents), reason: p.reason, actionId: ctx.actionId });
    pr.budgetCents += p.amountCents;
    emit(w, { type: 'budget_increase', category: 'project', severity: 'notice', title: `${pr.name}: budget +${fmtEur(p.amountCents)}`, description: p.reason, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'project', id: pr.id }] });
    return { summary: 'Budget increased', details: [] };
  },
};

export const cancelProject: ActionDef<{ projectId: string; reason: string }> = {
  type: 'cancel_project',
  label: 'Cancel a project',
  description: 'Stop a project. Capitalised spend is written off; staff return to the engineering pool. Cancelling a vehicle programme needs board approval.',
  llmProposable: true,
  affectsForecast: true,
  schema: z.object({ projectId: z.string(), reason: z.string().min(3).max(600) }),
  validate: (w, p) => {
    const pr = byId(w.projects, p.projectId);
    if (!pr) return { errors: ['Unknown project.'], warnings: [] };
    if (['completed', 'cancelled'].includes(pr.status)) return { errors: [`Project is already ${pr.status}.`], warnings: [] };
    const v = ok();
    if (pr.id === 'PRJ-EON') v.warnings.push('Cancelling the Eon triggers EIB loan prepayment (€400m), writes off >€600m of capitalised development and leaves Brno without a product.');
    return v;
  },
  preview: (w, p) => {
    const pr = byId(w.projects, p.projectId)!;
    const writeOff = pr.capitalizeExternal && pr.status !== 'proposed' ? Math.min(pr.externalSpentCents, Math.max(0, bal(w, pr.kind === 'vehicle_program' ? '1600' : '1500'))) : 0;
    return {
      summary: `Cancel ${pr.name}`,
      consequences: [
        { label: 'Write-off of capitalised spend (non-cash)', amountCents: -writeOff, kind: 'pnl' },
        { label: `Remaining budget not spent`, amountCents: Math.max(0, remainingBudget(pr)), kind: 'cash' },
        { label: `${Math.round(pr.staffingFte)} engineers return to the pool`, kind: 'people' },
      ],
      approvals: pr.kind === 'vehicle_program' || pr.spentCents > RULES.ceoSpendLimitCents ? [{ approver: 'board', reason: 'Cancelling a vehicle programme or a project with >€50m spent requires board approval.' }] : [],
    };
  },
  boardAnalysis: (w, p) => {
    const pr = byId(w.projects, p.projectId)!;
    return { cashImpactCents: Math.max(0, remainingBudget(pr)), minLiquidityAfterCents: liquidity(w), leverageAfter: 0, annualProfitImpactCents: -pr.externalSpentCents / 4, jobsImpact: 0, ev: pr.linkedModelId === 'MDL-EON' ? -1 : 0, growth: -0.6, dilutionPct: 0, risk: 0.6, cfoSupport: 0.2 };
  },
  commit: (w, p, ctx) => {
    const pr = byId(w.projects, p.projectId)!;
    const old = pr.status;
    pr.status = 'cancelled';
    const acct = pr.kind === 'vehicle_program' ? '1600' : '1500';
    const writeOff = pr.capitalizeExternal && old !== 'proposed' ? Math.min(pr.externalSpentCents, Math.max(0, bal(w, acct))) : 0;
    if (writeOff > 0) post(w, { description: `Write-off: ${pr.name} cancelled`, sourceType: 'impairment', sourceId: ctx.actionId, lines: [{ account: '6850', amountCents: writeOff }, { account: acct, amountCents: -writeOff }] });
    recordHistory(w, { projectId: pr.id, field: 'status', oldValue: old, newValue: 'cancelled', reason: p.reason, actionId: ctx.actionId });
    adjustTrust(w, pr.managerId, old === 'proposed' ? -2 : -6);
    adjustTrust(w, pr.sponsorId, old === 'proposed' ? -1 : -4);
    const dep = byId(w.departments, pr.departmentId);
    if (dep && old !== 'proposed') dep.morale = clamp(dep.morale - 5, 0, 100);
    const mgr = byId(w.characters, pr.managerId);
    if (mgr && mgr.active) {
      const done = pr.budgetCents > 0 ? Math.round((pr.spentCents / pr.budgetCents) * 100) : 0;
      remember(w, { characterId: mgr.id, kind: 'grievance', summary: `The CEO cancelled ${pr.name}${old === 'proposed' ? ' before it started' : ` after ${fmtEur(pr.spentCents)} had been spent`}. Reason given: ${p.reason.slice(0, 160)}`, importance: old === 'proposed' ? 2 : 4, sentiment: -1, sourceType: 'project', sourceId: pr.id, entityRefs: [{ type: 'project', id: pr.id }] });
      inbox(w, { kind: 'letter', fromId: mgr.id, subject: `${pr.name} cancelled`, body: old === 'proposed' ? `Understood — we will not pursue ${pr.name}. For the record, the team thought it was worth doing; if circumstances change I would like to bring it back.` : `I have told the team that ${pr.name} is stopped. ${Math.round(pr.staffingFte)} engineers go back to the pool and ${fmtEur(pr.spentCents)} (${done}% of the budget) has been spent for nothing we can use${writeOff ? ` — ${fmtEur(writeOff)} is written off` : ''}. People put a lot into this; morale in ${dep?.name ?? 'the team'} will take a knock. I hope the reason is worth it.`, priority: 'normal', linked: [{ type: 'project', id: pr.id }] });
    }
    if (pr.linkedModelId) {
      const m = byId(w.models, pr.linkedModelId);
      if (m && m.status === 'development') m.status = 'discontinued';
    }
    emit(w, { type: 'project_cancelled', category: 'project', severity: 'warning', title: `${pr.name} cancelled`, description: `${p.reason}. Write-off ${fmtEur(writeOff)}.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'project', id: pr.id }] });
    return { summary: 'Project cancelled', details: [`Write-off ${fmtEur(writeOff)}`] };
  },
};

export const addressIssue: ActionDef<{ issueId: string; optionKey: string }> = {
  type: 'address_issue',
  label: 'Act on an issue',
  description: 'Choose one of the documented response options for an open issue.',
  llmProposable: true,
  affectsForecast: true,
  amountCents: (w, p) => byId(w.issues, p.issueId)?.options.find((o) => o.key === p.optionKey)?.costCents ?? 0,
  schema: z.object({ issueId: z.string(), optionKey: z.string() }),
  validate: (w, p) => {
    const iss = byId(w.issues, p.issueId);
    if (!iss) return { errors: ['Unknown issue.'], warnings: [] };
    if (['resolved', 'closed'].includes(iss.status)) return { errors: ['Issue is already resolved.'], warnings: [] };
    const opt = iss.options.find((o) => o.key === p.optionKey);
    if (!opt) return { errors: [`"${p.optionKey}" is not an available option for this issue. Options: ${iss.options.map((o) => o.key).join(', ') || 'none — handled through other actions'}.`], warnings: [] };
    if (iss.chosenOptions.includes(opt.key)) return { errors: ['This option has already been implemented.'], warnings: [] };
    return { errors: [], warnings: opt.tradeoffs ? [opt.tradeoffs] : [] };
  },
  preview: (w, p) => {
    const iss = byId(w.issues, p.issueId)!;
    const opt = iss.options.find((o) => o.key === p.optionKey)!;
    const cons = [{ label: opt.description, kind: 'info' as const }, ...(opt.costCents ? [{ label: 'Cost', amountCents: -opt.costCents, kind: 'cash' as const }] : [])];
    if (iss.projectId) {
      const pr = byId(w.projects, iss.projectId);
      if (pr) {
        const before = forecastProject(w, pr);
        const red = opt.effects.find((e) => e.type === 'reduce_work');
        const resolves = opt.effects.some((e) => e.type === 'resolve');
        const issues = w.issues.map((i) => (i.id === iss.id ? { ...i, resolutionWorkTotal: resolves ? i.resolutionWorkDone : red && red.type === 'reduce_work' ? i.resolutionWorkDone + (i.resolutionWorkTotal - i.resolutionWorkDone) * (1 - red.pct) : i.resolutionWorkTotal, status: resolves ? ('resolved' as const) : i.status } : i));
        const after = forecastProject({ ...w, issues }, pr);
        cons.push({ label: `${pr.name} forecast ${before.p50 ?? 'blocked'} → ${after.p50 ?? 'blocked'} (estimate)`, kind: 'info' as const });
      }
    }
    return { summary: `${iss.title}: ${opt.label}`, consequences: cons, approvals: opt.costCents > RULES.ceoSpendLimitCents ? [{ approver: 'board', reason: 'Cost above the CEO limit.' }] : [] };
  },
  boardAnalysis: (w, p) => {
    const iss = byId(w.issues, p.issueId)!;
    const opt = iss.options.find((o) => o.key === p.optionKey)!;
    const sev = iss.severity === 'critical' ? 0.7 : iss.severity === 'high' ? 0.5 : 0.2;
    return { cashImpactCents: -opt.costCents, minLiquidityAfterCents: 0, leverageAfter: 0, annualProfitImpactCents: 0, jobsImpact: 0, ev: iss.projectId === 'PRJ-EON' ? 0.4 : 0, growth: 0.1, dilutionPct: 0, risk: 0.2, cfoSupport: 0.2, necessity: sev };
  },
  commit: (w, p, ctx) => {
    const iss = byId(w.issues, p.issueId)!;
    const opt = iss.options.find((o) => o.key === p.optionKey)!;
    iss.chosenOptions.push(opt.key);
    const out: string[] = [];
    for (const e of opt.effects) {
      switch (e.type) {
        case 'spend': {
          post(w, { description: `${iss.title}: ${opt.label}`, sourceType: 'action', sourceId: ctx.actionId, lines: [{ account: e.account, amountCents: e.amountCents }, { account: '2000', amountCents: -e.amountCents }] });
          w.payables.push({ id: nextId(w, 'AP'), counterpartyId: 'VARIOUS', category: e.capitalize ? 'capex' : 'project', amountCents: e.amountCents, issueDate: w.meta.currentDate, dueDate: addDays(w.meta.currentDate, 30), status: 'open', paidDate: null, sourceId: ctx.actionId, liabilityAccount: '2000' });
          out.push(`Spend ${fmtEur(e.amountCents)}`);
          break;
        }
        case 'reduce_work': {
          const left = iss.resolutionWorkTotal - iss.resolutionWorkDone;
          iss.resolutionWorkTotal = iss.resolutionWorkDone + left * (1 - e.pct);
          out.push(`Remaining work −${Math.round(e.pct * 100)}%`);
          break;
        }
        case 'add_fte': {
          const pr = byId(w.projects, iss.projectId ?? '');
          if (pr) pr.staffingFte += e.fte;
          break;
        }
        case 'quality': {
          const m = byId(w.models, e.modelId);
          if (m) m.quality = clamp(m.quality + e.delta, 0, 100);
          out.push(`${m?.name} quality ${e.delta > 0 ? '+' : ''}${e.delta}`);
          break;
        }
        case 'provision': {
          post(w, { description: e.label, sourceType: 'action', sourceId: ctx.actionId, lines: [{ account: '6800', amountCents: e.amountCents }, { account: e.account, amountCents: -e.amountCents }] });
          iss.data.campaignCostCents = Number(iss.data.campaignCostCents ?? 0) + e.amountCents;
          out.push(`Provision ${fmtEur(e.amountCents)}`);
          break;
        }
        case 'demand': {
          const m = byId(w.models, e.modelId);
          if (m) {
            m.demandModifier = e.factor;
            m.demandModifierUntil = addDays(w.meta.currentDate, e.days);
          }
          break;
        }
        case 'resolve':
          resolveIssue(w, iss, `${opt.label}.`);
          break;
        case 'set_status':
          if (!['resolved', 'closed'].includes(iss.status)) iss.status = e.status;
          if (e.status === 'open') iss.data.monitoredSince = w.meta.currentDate;
          break;
        case 'trust':
          adjustTrust(w, e.characterId, e.delta);
          break;
        case 'absenteeism': {
          const f = byId(w.factories, e.factoryId);
          if (f) f.absenteeismPct = Math.max(1, f.absenteeismPct + e.delta);
          break;
        }
        case 'risk_factor':
          iss.data.riskFactor = e.factor;
          out.push(`Residual risk factor ${e.factor}`);
          break;
        case 'model_cost':
          applyProjectEffects(w, [{ type: 'model_cost', modelId: e.modelId, deltaCents: e.deltaCents }]);
          break;
        case 'investigate':
          iss.data.workPerDay = e.workPerDay;
          if (iss.resolutionWorkTotal <= 0) iss.resolutionWorkTotal = e.workPerDay * 40;
          iss.resolutionWorkDone = 0;
          out.push(`Investigation ≈${Math.round(iss.resolutionWorkTotal / e.workPerDay)} working days`);
          break;
      }
    }
    if (iss.ownerId) remember(w, { characterId: iss.ownerId, kind: 'decision', summary: `The CEO chose "${opt.label}" for: ${iss.title}.`, importance: 3, sentiment: 0, sourceType: 'action', sourceId: ctx.actionId, entityRefs: [{ type: 'issue', id: iss.id }] });
    emit(w, { type: 'issue_action', category: 'project', severity: 'notice', title: `${iss.title}: ${opt.label}`, description: out.join('; ') || opt.description, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'issue', id: iss.id }, ...iss.linked] });
    return { summary: opt.label, details: out };
  },
};

export { scale };
