import { z } from 'zod';
import { addDays, diffDays, isSimDate, workingDaysBetween } from '../../../shared/dates';
import { fmtEur, mEur, times } from '../../../shared/money';
import { marketingUtility, modelMonthlyDemand, segmentShares } from '../../engine/demand';
import { availableCrew, requiredCrew } from '../../engine/operations';
import { unitMaterialCost } from '../../scenario/initial';
import { byId, clamp, emit, type World } from '../../engine/world';
import { ok, type ActionDef } from '../types';
import type { Consequence } from '../../../shared/domain';

const money = z.number().int();

function contributionPerUnit(w: World, modelId: string, price: number): number {
  const m = byId(w.models, modelId)!;
  return price - unitMaterialCost(w, m) - m.logisticsPerUnitCents - m.warrantyPerUnitCents;
}

export const changePrice: ActionDef<{ modelId: string; netPriceCents: number; reason?: string }> = {
  type: 'change_price',
  label: 'Change vehicle price',
  description: 'Set the net (dealer-invoice) price of a model. Affects demand through the price elasticity of its segment; competitors may respond to cuts.',
  llmProposable: true,
  affectsForecast: true,
  schema: z.object({ modelId: z.string(), netPriceCents: money.positive(), reason: z.string().max(500).optional() }),
  validate: (w, p) => {
    const v = ok();
    const m = byId(w.models, p.modelId);
    if (!m) return { errors: [`Unknown model ${p.modelId}.`], warnings: [] };
    if (m.status === 'discontinued') v.errors.push(`${m.name} is discontinued.`);
    const ratio = p.netPriceCents / m.netPriceCents;
    if (ratio < 0.6 || ratio > 1.5) v.errors.push(`A change of ${((ratio - 1) * 100).toFixed(0)}% is outside the plausible range (−40% … +50%).`);
    if (Math.abs(ratio - 1) > 0.1) v.warnings.push(`Large price move (${((ratio - 1) * 100).toFixed(1)}%) — dealers and residual values will react.`);
    if (p.netPriceCents === m.netPriceCents) v.errors.push('The price is unchanged.');
    if (contributionPerUnit(w, m.id, p.netPriceCents) < 0) v.warnings.push('At this price each vehicle sold loses money on a variable-cost basis.');
    return v;
  },
  preview: (w, p) => {
    const m = byId(w.models, p.modelId)!;
    const before = modelMonthlyDemand(w, m, w.meta.currentDate);
    const old = m.netPriceCents;
    m.netPriceCents = p.netPriceCents;
    const after = modelMonthlyDemand(w, m, w.meta.currentDate);
    m.netPriceCents = old;
    const cBefore = contributionPerUnit(w, m.id, old) * before;
    const cAfter = contributionPerUnit(w, m.id, p.netPriceCents) * after;
    const pct = ((p.netPriceCents - old) / old) * 100;
    const cons: Consequence[] = [
      { label: `Net price ${fmtEur(old)} → ${fmtEur(p.netPriceCents)} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`, kind: 'info' as const },
      { label: `Estimated retail demand ${Math.round(before).toLocaleString('en-GB')} → ${Math.round(after).toLocaleString('en-GB')} units/month (estimate)`, kind: 'operational' as const },
      { label: 'Estimated monthly contribution change (estimate)', amountCents: Math.round(cAfter - cBefore), timing: 'per month', kind: 'pnl' as const },
    ];
    if (pct <= -3) cons.push({ label: 'Aggressive competitors may match the cut within weeks (Marivaux, Shenlong, Volkner).', kind: 'risk' as const });
    return { summary: `Change ${m.name} net price to ${fmtEur(p.netPriceCents)}`, consequences: cons, approvals: [] };
  },
  commit: (w, p, ctx) => {
    const m = byId(w.models, p.modelId)!;
    const old = m.netPriceCents;
    m.netPriceCents = p.netPriceCents;
    m.listPriceCents = Math.round((m.listPriceCents * p.netPriceCents) / old / 100) * 100;
    if (p.netPriceCents > old * 1.03) {
      const bellini = byId(w.characters, 'CHR-BELLINI');
      if (bellini) bellini.trustInCeo = clamp(bellini.trustInCeo - 1, 0, 100);
    }
    emit(w, { type: 'price_change', category: 'market', severity: 'notice', title: `${m.name} net price set to ${fmtEur(p.netPriceCents)}`, description: `Previously ${fmtEur(old)}. ${p.reason ?? ''}`.trim(), causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'model', id: m.id }] });
    return { summary: `${m.name} price changed`, details: [`${fmtEur(old)} → ${fmtEur(p.netPriceCents)}`] };
  },
};

export const adjustProduction: ActionDef<{ lineId: string; plannedDailyRate: number; reason?: string }> = {
  type: 'adjust_production',
  label: 'Adjust production rate',
  description: 'Set the planned daily output of a production line (vehicles per working day).',
  llmProposable: true,
  affectsForecast: true,
  schema: z.object({ lineId: z.string(), plannedDailyRate: z.number().int().min(0).max(2000), reason: z.string().max(500).optional() }),
  validate: (w, p) => {
    const v = ok();
    const l = byId(w.lines, p.lineId);
    if (!l) return { errors: [`Unknown production line ${p.lineId}.`], warnings: [] };
    if (p.plannedDailyRate > l.maxDailyRate) v.errors.push(`${l.name} can build at most ${l.maxDailyRate}/day (installed capacity). More capacity requires an industrial project.`);
    if (l.plannedDailyRate === p.plannedDailyRate) v.errors.push('The rate is unchanged.');
    if (l.status === 'not_ready') v.warnings.push(`${l.name} is not ready; the rate applies once it starts production.`);
    const f = byId(w.factories, l.factoryId)!;
    const old = l.plannedDailyRate;
    l.plannedDailyRate = p.plannedDailyRate;
    const need = requiredCrew(w, f, w.meta.currentDate);
    l.plannedDailyRate = old;
    const have = availableCrew(w, f);
    if (need > have * 1.0001 && l.status !== 'not_ready') v.warnings.push(`${f.name} needs ~${Math.round(need).toLocaleString('en-GB')} people present at this rate but has ~${Math.round(have).toLocaleString('en-GB')} (after absenteeism). Output will be capped unless you hire.`);
    return v;
  },
  preview: (w, p) => {
    const l = byId(w.lines, p.lineId)!;
    const m = byId(w.models, l.modelId)!;
    const wd = workingDaysBetween(w.meta.currentDate, addDays(w.meta.currentDate, 29));
    const delta = (p.plannedDailyRate - l.plannedDailyRate) * wd;
    const demand = modelMonthlyDemand(w, m, w.meta.currentDate);
    const allLines = w.lines.filter((x) => x.modelId === m.id).reduce((a, x) => a + (x.id === l.id ? p.plannedDailyRate : x.plannedDailyRate), 0);
    const cons: Consequence[] = [
      { label: `${l.name}: ${l.plannedDailyRate} → ${p.plannedDailyRate} vehicles/day`, kind: 'info' as const },
      { label: `≈${delta > 0 ? '+' : ''}${delta.toLocaleString('en-GB')} vehicles over the next 30 days (${wd} working days)`, kind: 'operational' as const },
      { label: `Material purchases change (paid at supplier terms)`, amountCents: -times(unitMaterialCost(w, m), delta), timing: 'next 30 days, paid ~60 days later', kind: 'cash' as const },
      { label: `${m.name}: planned output ≈${Math.round(allLines * wd).toLocaleString('en-GB')}/month vs estimated retail demand ≈${Math.round(demand).toLocaleString('en-GB')}/month (estimate)`, kind: 'operational' as const },
    ];
    if (p.plannedDailyRate < l.plannedDailyRate * 0.85) cons.push({ label: 'Lower utilisation: fixed labour and overhead are unchanged unless headcount is adjusted; plant morale may fall.', kind: 'people' as const });
    return { summary: `Set ${l.name} to ${p.plannedDailyRate}/day`, consequences: cons, approvals: [] };
  },
  commit: (w, p, ctx) => {
    const l = byId(w.lines, p.lineId)!;
    const old = l.plannedDailyRate;
    l.plannedDailyRate = p.plannedDailyRate;
    if (l.status === 'idle' && p.plannedDailyRate > 0) l.status = 'running';
    if (l.status === 'running' && p.plannedDailyRate === 0) l.status = 'idle';
    const f = byId(w.factories, l.factoryId)!;
    const dep = byId(w.departments, f.departmentId);
    if (dep && p.plannedDailyRate < old * 0.85) dep.morale = clamp(dep.morale - 2, 0, 100);
    emit(w, { type: 'production_change', category: 'operations', severity: 'info', title: `${l.name}: ${old} → ${p.plannedDailyRate} per day`, description: p.reason ?? 'Production plan updated.', causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'line', id: l.id }, { type: 'factory', id: f.id }] });
    return { summary: 'Production plan updated', details: [`${l.name}: ${old} → ${p.plannedDailyRate}/day`] };
  },
};

export const scheduleDowntime: ActionDef<{ factoryId: string; startDate: string; endDate: string; reason: string }> = {
  type: 'schedule_downtime',
  label: 'Schedule plant downtime',
  description: 'Plan a production stop (e.g. to cut inventory or for maintenance).',
  llmProposable: true,
  affectsForecast: true,
  schema: z.object({ factoryId: z.string(), startDate: z.string(), endDate: z.string(), reason: z.string().min(3).max(300) }),
  validate: (w, p) => {
    const v = ok();
    if (!byId(w.factories, p.factoryId)) v.errors.push(`Unknown factory ${p.factoryId}.`);
    if (!isSimDate(p.startDate) || !isSimDate(p.endDate)) v.errors.push('Dates must be YYYY-MM-DD.');
    else {
      if (p.startDate < addDays(w.meta.currentDate, 3)) v.errors.push('Downtime needs at least 3 days’ notice to suppliers and staff.');
      if (p.endDate < p.startDate) v.errors.push('End date is before start date.');
      if (diffDays(p.endDate, p.startDate) > 60) v.errors.push('Downtime longer than 60 days requires a restructuring decision.');
    }
    return v;
  },
  preview: (w, p) => {
    const f = byId(w.factories, p.factoryId)!;
    const wd = isSimDate(p.startDate) && isSimDate(p.endDate) ? workingDaysBetween(p.startDate, p.endDate) : 0;
    const daily = w.lines.filter((l) => l.factoryId === f.id).reduce((a, l) => a + (l.status === 'running' || l.status === 'ramp_up' ? l.plannedDailyRate : 0), 0);
    return { summary: `${f.name} down ${p.startDate} → ${p.endDate}`, consequences: [{ label: `≈${(wd * daily).toLocaleString('en-GB')} vehicles not built (${wd} working days)`, kind: 'operational' }, { label: 'Labour and overhead costs continue (no short-time-work scheme modelled)', kind: 'pnl' }], approvals: [] };
  },
  commit: (w, p, ctx) => {
    const f = byId(w.factories, p.factoryId)!;
    f.downtime.push({ start: p.startDate, end: p.endDate, reason: p.reason, kind: 'planned' });
    emit(w, { type: 'downtime_scheduled', category: 'operations', severity: 'info', title: `${f.name}: downtime ${p.startDate} → ${p.endDate}`, description: p.reason, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'factory', id: f.id }] });
    return { summary: 'Downtime scheduled', details: [`${f.name}: ${p.startDate} → ${p.endDate}`] };
  },
};

export const setMarketingBudget: ActionDef<{ monthlyCents: number; reason?: string }> = {
  type: 'set_marketing_budget',
  label: 'Set marketing budget',
  description: 'Monthly brand and product marketing spend (affects demand for all models with diminishing returns).',
  llmProposable: true,
  affectsForecast: true,
  amountCents: (w, p) => Math.max(0, (p.monthlyCents - w.meta.marketingMonthlyCents) * 12),
  schema: z.object({ monthlyCents: money.min(0).max(mEur(40)), reason: z.string().max(300).optional() }),
  validate: (w, p) => (p.monthlyCents === w.meta.marketingMonthlyCents ? { errors: ['Budget unchanged.'], warnings: [] } : ok()),
  preview: (w, p) => {
    const before = marketingUtility(w);
    const old = w.meta.marketingMonthlyCents;
    w.meta.marketingMonthlyCents = p.monthlyCents;
    const after = marketingUtility(w);
    const demandAfter = w.models.filter((m) => m.status === 'in_production').reduce((a, m) => a + modelMonthlyDemand(w, m, w.meta.currentDate), 0);
    w.meta.marketingMonthlyCents = old;
    const demandBefore = w.models.filter((m) => m.status === 'in_production').reduce((a, m) => a + modelMonthlyDemand(w, m, w.meta.currentDate), 0);
    return {
      summary: `Marketing ${fmtEur(old)}/month → ${fmtEur(p.monthlyCents)}/month`,
      consequences: [
        { label: 'Marketing expense change', amountCents: -(p.monthlyCents - old), timing: 'per month', kind: 'pnl' },
        { label: `Estimated demand ${Math.round(demandBefore).toLocaleString('en-GB')} → ${Math.round(demandAfter).toLocaleString('en-GB')} units/month (utility ${before.toFixed(3)} → ${after.toFixed(3)}; estimate)`, kind: 'operational' },
      ],
      approvals: [],
    };
  },
  commit: (w, p, ctx) => {
    const old = w.meta.marketingMonthlyCents;
    w.meta.marketingMonthlyCents = p.monthlyCents;
    emit(w, { type: 'marketing_budget', category: 'market', severity: 'info', title: `Marketing budget set to ${fmtEur(p.monthlyCents)}/month`, description: `Previously ${fmtEur(old)}/month.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId });
    return { summary: 'Marketing budget updated', details: [] };
  },
};

export { segmentShares };
