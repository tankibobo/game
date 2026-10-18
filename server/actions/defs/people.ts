import { z } from 'zod';
import type { CommitmentCheck } from '../../../shared/domain';
import { addDays, isSimDate } from '../../../shared/dates';
import { fmtEur, times } from '../../../shared/money';
import { post } from '../../engine/ledger';
import { PARAMS, RULES } from '../../engine/params';
import { resolveCommitment } from '../../engine/commitments';
import { liquidityTightness } from '../../engine/board';
import { availableCrew, steadyStateCrew } from '../../engine/operations';
import { adjustTrust, byId, clamp, emit, nextId, remember, type World } from '../../engine/world';
import { ok, type ActionDef } from '../types';

export const hireStaff: ActionDef<{ departmentId: string; headcount: number; reason?: string }> = {
  type: 'hire_staff',
  label: 'Hire staff',
  description: 'Recruit employees into a department. They arrive after a recruiting lead time (plants 45 days, engineering 90 days).',
  llmProposable: true,
  affectsForecast: true,
  amountCents: (w, p) => {
    const d = byId(w.departments, p.departmentId);
    return d ? times(PARAMS.recruitingCostPerHeadCents, p.headcount) + times(d.annualCostPerHeadCents, p.headcount) : 0;
  },
  schema: z.object({ departmentId: z.string(), headcount: z.number().int().min(1).max(3000), reason: z.string().max(300).optional() }),
  validate: (w, p) => {
    const v = ok();
    const d = byId(w.departments, p.departmentId);
    if (!d) return { errors: [`Unknown department ${p.departmentId}.`], warnings: [] };
    if (p.headcount > d.headcount * 0.6) v.errors.push(`Recruiting ${p.headcount} people (more than 60% of current headcount) at once is not feasible.`);
    if (d.leaving.length > 0) v.warnings.push(`${d.name} has announced job cuts; hiring at the same time will anger the union.`);
    return v;
  },
  preview: (w, p) => {
    const d = byId(w.departments, p.departmentId)!;
    const lead = PARAMS.hiringLeadDays[d.kind] ?? 60;
    const approvals = p.headcount > RULES.ceoHiringLimit ? [{ approver: 'board' as const, reason: `Hiring more than ${RULES.ceoHiringLimit} people requires board approval.` }] : [];
    return {
      summary: `Hire ${p.headcount} for ${d.name}`,
      consequences: [
        { label: `Recruiting cost`, amountCents: -times(PARAMS.recruitingCostPerHeadCents, p.headcount), timing: 'now (paid in 30 days)', kind: 'cash' },
        { label: `Payroll increase from ${addDays(w.meta.currentDate, lead)}`, amountCents: -Math.round((times(d.annualCostPerHeadCents, p.headcount) * w.meta.wageIndex) / 12), timing: 'per month', kind: 'pnl' },
        { label: `${d.name}: ${d.headcount.toLocaleString('en-GB')} → ${(d.headcount + p.headcount).toLocaleString('en-GB')} employees after ~${lead} days`, kind: 'people' },
      ],
      approvals,
    };
  },
  boardAnalysis: (w, p) => {
    const d = byId(w.departments, p.departmentId)!;
    const annual = Math.round(times(d.annualCostPerHeadCents, p.headcount) * w.meta.wageIndex);
    const recruiting = times(PARAMS.recruitingCostPerHeadCents, p.headcount);
    const need = staffingNeed(w, d.id);
    const necessity = need > 0 ? clamp(Math.min(need, p.headcount) / p.headcount, 0, 1) * 0.9 : 0;
    // Hiring that closes a crew shortage pays for itself through output; surplus hiring is pure cost.
    const covered = need > 0 ? Math.min(need, p.headcount) / p.headcount : 0;
    return { cashImpactCents: -recruiting, minLiquidityAfterCents: 0, leverageAfter: 0, annualProfitImpactCents: Math.round(-annual * (1 - covered)), jobsImpact: p.headcount, ev: d.id === 'DEP-BRNO' || d.id === 'DEP-BEC' ? 0.3 : 0, growth: 0.3, dilutionPct: 0, risk: 0.15, cfoSupport: need > 0 ? 0.3 : liquidityTightness(w) > 0.3 ? -0.4 : 0, necessity };
  },
  commit: (w, p, ctx) => {
    const d = byId(w.departments, p.departmentId)!;
    const lead = PARAMS.hiringLeadDays[d.kind] ?? 60;
    const arrival = addDays(w.meta.currentDate, lead);
    d.hiring.push({ count: p.headcount, arrivalDate: arrival, actionId: ctx.actionId });
    const cost = times(PARAMS.recruitingCostPerHeadCents, p.headcount);
    post(w, { description: `Recruiting costs — ${p.headcount} for ${d.name}`, sourceType: 'action', sourceId: ctx.actionId, lines: [{ account: d.expenseAccount, amountCents: cost }, { account: '2000', amountCents: -cost }] });
    w.payables.push({ id: nextId(w, 'AP'), counterpartyId: 'RECRUITERS', category: 'other', amountCents: cost, issueDate: w.meta.currentDate, dueDate: addDays(w.meta.currentDate, 30), status: 'open', paidDate: null, sourceId: ctx.actionId, liabilityAccount: '2000' });
    emit(w, { type: 'hiring_started', category: 'people', severity: 'info', title: `Recruiting ${p.headcount} for ${d.name}`, description: `Expected to join by ${arrival}. Recruiting cost ${fmtEur(cost)}.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'department', id: d.id }] });
    return { summary: `Hiring ${p.headcount}`, details: [`Arrival ${arrival}`] };
  },
};

export const restructureWorkforce: ActionDef<{ departmentId: string; reduction: number; mode: 'voluntary' | 'compulsory'; severancePerHeadCents?: number; reason?: string }> = {
  type: 'restructure_workforce',
  label: 'Restructure workforce',
  description: 'Reduce headcount in a department via a voluntary departure programme or compulsory redundancies, after a 60-day consultation with employee representatives. Severance is provisioned on announcement.',
  llmProposable: true,
  affectsForecast: true,
  amountCents: (w, p) => times(p.severancePerHeadCents ?? (p.mode === 'voluntary' ? PARAMS.severanceDefaultPerHeadCents * 1.3 : PARAMS.severanceDefaultPerHeadCents), p.reduction),
  schema: z.object({ departmentId: z.string(), reduction: z.number().int().min(1).max(5000), mode: z.enum(['voluntary', 'compulsory']), severancePerHeadCents: z.number().int().min(0).optional(), reason: z.string().max(500).optional() }),
  validate: (w, p) => {
    const v = ok();
    const d = byId(w.departments, p.departmentId);
    if (!d) return { errors: [`Unknown department ${p.departmentId}.`], warnings: [] };
    if (p.reduction > d.headcount * 0.4) v.errors.push(`Cutting more than 40% of ${d.name} in one programme is not legally or practically feasible.`);
    const sev = p.severancePerHeadCents ?? PARAMS.severanceDefaultPerHeadCents;
    if (sev < PARAMS.severanceDefaultPerHeadCents * 0.6) v.errors.push(`Severance below ${fmtEur(Math.round(PARAMS.severanceDefaultPerHeadCents * 0.6))} per head is below statutory minimums.`);
    const guarantee = w.commitments.find((c) => c.status === 'open' && c.check.type === 'no_headcount_reduction' && c.check.departmentIds.includes(p.departmentId));
    if (guarantee && p.mode === 'compulsory') v.warnings.push(`This BREAKS the job guarantee given to ${byId(w.characters, guarantee.promiseeId)?.name ?? guarantee.promiseeId} (“${guarantee.description}”). Expect strikes and a collapse of union trust.`);
    if (d.kind === 'plant') v.warnings.push('The union will treat plant job cuts as a major escalation.');
    return v;
  },
  preview: (w, p) => {
    const d = byId(w.departments, p.departmentId)!;
    const sevPer = p.severancePerHeadCents ?? Math.round(p.mode === 'voluntary' ? PARAMS.severanceDefaultPerHeadCents * 1.3 : PARAMS.severanceDefaultPerHeadCents);
    const total = times(sevPer, p.reduction);
    const effective = addDays(w.meta.currentDate, PARAMS.consultationDays);
    const saving = Math.round((times(d.annualCostPerHeadCents, p.reduction) * w.meta.wageIndex) / 12);
    const approvals = [
      { approver: 'works_council' as const, reason: `Mandatory ${PARAMS.consultationDays}-day information & consultation process (effective ${effective}).`, informational: true },
      ...(p.reduction > RULES.boardRestructuringHeadcount ? [{ approver: 'board' as const, reason: `Restructuring of more than ${RULES.boardRestructuringHeadcount} positions requires board approval.` }] : []),
    ];
    return {
      summary: `${p.mode === 'voluntary' ? 'Voluntary departure programme' : 'Compulsory redundancies'}: −${p.reduction} at ${d.name}`,
      consequences: [
        { label: 'Restructuring provision (expense now, cash when people leave)', amountCents: -total, timing: `expense now; paid ${effective}`, kind: 'pnl' },
        { label: 'Payroll saving from the effective date', amountCents: saving, timing: 'per month', kind: 'pnl' },
        { label: `Morale in ${d.name} −${p.mode === 'compulsory' ? 12 : 6}; union trust −${p.mode === 'compulsory' ? 15 : 6}`, kind: 'people' },
        { label: d.kind === 'plant' ? 'Strike risk rises sharply' : 'Attrition risk among remaining staff', kind: 'risk' },
      ],
      approvals,
    };
  },
  boardAnalysis: (w, p) => {
    const d = byId(w.departments, p.departmentId)!;
    const sev = times(p.severancePerHeadCents ?? Math.round(p.mode === 'voluntary' ? PARAMS.severanceDefaultPerHeadCents * 1.3 : PARAMS.severanceDefaultPerHeadCents), p.reduction);
    const saving = Math.round(times(d.annualCostPerHeadCents, p.reduction) * w.meta.wageIndex);
    const surplus = -staffingNeed(w, d.id); // people beyond what the plan needs
    const cutsIntoNeeded = surplus < p.reduction && d.kind === 'plant';
    return {
      cashImpactCents: -sev,
      minLiquidityAfterCents: 0,
      leverageAfter: 0,
      // Cutting below the crew the production plan needs costs output.
      annualProfitImpactCents: cutsIntoNeeded ? Math.round(saving * Math.max(0, surplus) / p.reduction) - Math.round(saving * 0.5 * (p.reduction - Math.max(0, surplus)) / p.reduction) : saving,
      jobsImpact: -p.reduction,
      ev: 0,
      growth: -0.1,
      dilutionPct: 0,
      risk: (d.kind === 'plant' ? 0.45 : 0.25) + (p.mode === 'compulsory' ? 0.15 : 0),
      cfoSupport: cutsIntoNeeded ? 0 : 0.6,
      necessity: surplus > 0 ? clamp(Math.min(surplus, p.reduction) / p.reduction, 0, 1) * 0.4 : 0,
    };
  },
  commit: (w, p, ctx) => {
    const d = byId(w.departments, p.departmentId)!;
    const sevPer = p.severancePerHeadCents ?? Math.round(p.mode === 'voluntary' ? PARAMS.severanceDefaultPerHeadCents * 1.3 : PARAMS.severanceDefaultPerHeadCents);
    const total = times(sevPer, p.reduction);
    const effective = addDays(w.meta.currentDate, PARAMS.consultationDays);
    post(w, { description: `Restructuring provision — ${d.name} (${p.reduction})`, sourceType: 'action', sourceId: ctx.actionId, lines: [{ account: '6600', amountCents: total }, { account: '2400', amountCents: -total }] });
    d.leaving.push({ count: p.reduction, date: effective, reason: `${p.mode === 'compulsory' ? 'Compulsory redundancies' : 'Voluntary departure programme'}${p.reason ? ` — ${p.reason}` : ''}`, severancePerHeadCents: sevPer, actionId: ctx.actionId });
    d.morale = clamp(d.morale - (p.mode === 'compulsory' ? 12 : 6), 0, 100);
    for (const o of w.departments) if (o.id !== d.id && o.kind === d.kind) o.morale = clamp(o.morale - 3, 0, 100);
    adjustTrust(w, 'CHR-NOVAK', p.mode === 'compulsory' ? -15 : -6);
    adjustTrust(w, 'CHR-PETIT', p.mode === 'compulsory' ? -10 : -4);
    adjustTrust(w, 'CHR-DUVAL', p.mode === 'compulsory' ? -6 : -2);
    adjustTrust(w, 'CHR-HOLM', 2);
    for (const id of ['CHR-NOVAK', 'CHR-PETIT', 'CHR-OKAFOR']) remember(w, { characterId: id, kind: id === 'CHR-OKAFOR' ? 'decision' : 'grievance', summary: `The CEO announced ${p.mode} job cuts of ${p.reduction} at ${d.name} (effective ${effective}).`, importance: 5, sentiment: id === 'CHR-OKAFOR' ? 0 : -2, sourceType: 'action', sourceId: ctx.actionId, entityRefs: [{ type: 'department', id: d.id }] });
    emit(w, { type: 'restructuring_announced', category: 'people', severity: 'warning', title: `${p.reduction} job cuts announced at ${d.name}`, description: `${p.mode === 'compulsory' ? 'Compulsory redundancies' : 'Voluntary departure programme'}; consultation until ${effective}. Provision ${fmtEur(total)}.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'department', id: d.id }, { type: 'character', id: 'CHR-NOVAK' }] });
    return { summary: 'Restructuring announced', details: [`Effective ${effective}`, `Provision ${fmtEur(total)}`] };
  },
};

const checkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('freeform') }),
  z.object({ type: z.literal('milestone_completed_by'), milestoneId: z.string() }),
  z.object({ type: z.literal('project_completed_by'), projectId: z.string() }),
  z.object({ type: z.literal('no_headcount_reduction'), departmentIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('min_liquidity'), amountCents: z.number().int().positive() }),
  z.object({ type: z.literal('price_floor'), modelId: z.string(), minNetPriceCents: z.number().int().positive() }),
  z.object({ type: z.literal('deliver_plan'), topic: z.string() }),
]);

export const makePromise: ActionDef<{ promiseeId: string; description: string; dueDate?: string | null; conditions?: string; check?: CommitmentCheck; importance?: number }> = {
  type: 'make_promise',
  label: 'Record a commitment',
  description: 'Record a promise made by the CEO to someone. Machine-checkable promises are verified by the simulation; others must be reported fulfilled or broken.',
  llmProposable: true,
  schema: z.object({ promiseeId: z.string(), description: z.string().min(5).max(400), dueDate: z.string().nullable().optional(), conditions: z.string().max(300).optional(), check: checkSchema.optional(), importance: z.number().int().min(1).max(5).optional() }),
  validate: (w, p) => {
    const v = ok();
    if (!byId(w.characters, p.promiseeId) && !['EIB', 'BANKS', 'EMPLOYEES'].includes(p.promiseeId)) v.errors.push(`Unknown promisee ${p.promiseeId}.`);
    if (p.dueDate && !isSimDate(p.dueDate)) v.errors.push('Due date must be YYYY-MM-DD.');
    if (p.dueDate && p.dueDate < w.meta.currentDate) v.errors.push('Due date is in the past.');
    const c = p.check;
    if (c?.type === 'milestone_completed_by' && !byId(w.milestones, c.milestoneId)) v.errors.push('Unknown milestone.');
    if (c?.type === 'project_completed_by' && !byId(w.projects, c.projectId)) v.errors.push('Unknown project.');
    if (c?.type === 'price_floor' && !byId(w.models, c.modelId)) v.errors.push('Unknown model.');
    return v;
  },
  preview: (w, p) => ({ summary: `Promise to ${byId(w.characters, p.promiseeId)?.name ?? p.promiseeId}: ${p.description}`, consequences: [{ label: `Tracked as a commitment${p.dueDate ? ` due ${p.dueDate}` : ''}. Keeping it builds trust; breaking it costs more.`, kind: 'people' }], approvals: [] }),
  commit: (w, p, ctx) => {
    const id = nextId(w, 'COM');
    w.commitments.push({ id, promisorId: 'ceo', promiseeId: p.promiseeId, description: p.description, dueDate: p.dueDate ?? null, conditions: p.conditions ?? '', status: 'open', createdDate: w.meta.currentDate, source: ctx.actorId === 'ceo' ? 'action' : 'conversation', sourceId: ctx.actionId, check: p.check ?? { type: 'freeform' }, resolvedDate: null, notifiedUpcoming: 0, importance: p.importance ?? 3 });
    if (byId(w.characters, p.promiseeId)) {
      remember(w, { characterId: p.promiseeId, kind: 'promise', summary: `The CEO promised: "${p.description}"${p.dueDate ? ` by ${p.dueDate}` : ''}.`, importance: p.importance ?? 3, sentiment: 1, sourceType: 'commitment', sourceId: id, entityRefs: [{ type: 'commitment', id }] });
      adjustTrust(w, p.promiseeId, 1);
    }
    emit(w, { type: 'commitment_made', category: 'people', severity: 'info', title: `Commitment to ${byId(w.characters, p.promiseeId)?.name ?? p.promiseeId}`, description: `${p.description}${p.dueDate ? ` (due ${p.dueDate})` : ''}`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'commitment', id }] });
    return { summary: 'Commitment recorded', details: [id], result: { commitmentId: id } };
  },
};

export const resolveCommitmentAction: ActionDef<{ commitmentId: string; outcome: 'fulfilled' | 'broken' | 'cancelled'; note?: string }> = {
  type: 'resolve_commitment',
  label: 'Report on a commitment',
  description: 'Mark a free-form commitment as fulfilled, broken or withdrawn. Verifiable commitments are resolved by the simulation.',
  llmProposable: false,
  schema: z.object({ commitmentId: z.string(), outcome: z.enum(['fulfilled', 'broken', 'cancelled']), note: z.string().max(400).optional() }),
  validate: (w, p) => {
    const c = byId(w.commitments, p.commitmentId);
    if (!c) return { errors: ['Unknown commitment.'], warnings: [] };
    if (!['open', 'due'].includes(c.status)) return { errors: [`Commitment is already ${c.status}.`], warnings: [] };
    if (c.check.type !== 'freeform') return { errors: ['This commitment is verified automatically by the simulation; it cannot be self-reported.'], warnings: [] };
    if (c.promisorId !== 'ceo') return { errors: ['Only the CEO’s own commitments can be reported here.'], warnings: [] };
    return { errors: [], warnings: p.outcome === 'cancelled' ? ['Withdrawing a promise costs some trust.'] : [] };
  },
  preview: (w, p) => {
    const c = byId(w.commitments, p.commitmentId)!;
    return { summary: `Mark “${c.description}” as ${p.outcome}`, consequences: [{ label: `${byId(w.characters, c.promiseeId)?.name ?? c.promiseeId}'s trust will change accordingly`, kind: 'people' }], approvals: [] };
  },
  commit: (w, p) => {
    const c = byId(w.commitments, p.commitmentId)!;
    resolveCommitment(w, c, p.outcome, p.note ?? 'Reported by the CEO.');
    return { summary: `Commitment ${p.outcome}`, details: [] };
  },
};

/**
 * People a department is short of (positive) or has beyond what the current
 * plans need (negative). Plants: crew for the planned line rates at full ramp.
 * Engineering: not modelled as a shortfall (free engineers are visible on the
 * Projects page), so 0.
 */
export function staffingNeed(w: World, departmentId: string): number {
  const d = byId(w.departments, departmentId);
  if (!d) return 0;
  const f = d.factoryId ? byId(w.factories, d.factoryId) : undefined;
  if (d.kind !== 'plant' || !f) return 0;
  const incoming = d.hiring.reduce((a, h) => a + h.count, 0) - d.leaving.reduce((a, l) => a + l.count, 0);
  const have = availableCrew(w, f) + incoming * (1 - f.absenteeismPct / 100);
  const needed = steadyStateCrew(w, f);
  return Math.round((needed - have) / (1 - f.absenteeismPct / 100));
}

export function ceoCanPromise(_w: World): boolean {
  return true;
}
