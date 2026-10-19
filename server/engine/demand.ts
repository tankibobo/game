/**
 * Demand model: a multinomial-logit share model per market segment.
 *
 *   utility(i) = appealW·appeal + qualityW·(quality−70) + satW·(satisfaction−70)
 *              − elasticity·ln(price / segmentRefPrice)
 *              + ln(powertrainPreference[powertrain])
 *              + distribution + marketing   (Asterion products only)
 *   share(i)   = exp(u_i) / (Σ_j exp(u_j) + exp(u_other))
 *   demand(i)  = segmentMarket(date) · share(i) · eventModifier(i)
 *
 * The "other brands" utility is calibrated once at scenario creation so that
 * the starting volumes match the scenario; afterwards it never changes.
 */
import type { PowertrainPref, Segment, VehicleModel, Powertrain } from '../../shared/domain';
import { daysInMonth, diffDays, month, type SimDate } from '../../shared/dates';
import { PARAMS } from './params';
import type { World } from './world';

const START_REF = '2027-01-01';

export function yearsSince(start: SimDate, d: SimDate): number {
  return diffDays(d, start) / 365.25;
}

export function macroDemandFactor(w: World, d: SimDate): number {
  let f = 1 + (w.macro.consumerConfidence - 100) * 0.004;
  for (const s of w.macro.shocks) if (d >= s.start && d <= s.until) f *= 1 + s.demandEffect;
  return f * w.scenarioDemandFactor;
}

export function segmentMarketMonthly(w: World, seg: Segment, d: SimDate): number {
  const t = yearsSince(START_REF, d);
  return seg.baseMonthlyUnits * seg.seasonality[month(d) - 1] * Math.pow(1 + seg.growthPerYear, t) * macroDemandFactor(w, d);
}

/** Powertrain preference weights at a date, including drift and active incentive regulations. */
export function powertrainPref(w: World, seg: Segment, d: SimDate): PowertrainPref {
  const t = Math.max(0, yearsSince(START_REF, d));
  const p: PowertrainPref = {
    ice: seg.powertrainPref.ice + seg.prefDriftPerYear.ice * t,
    hev: seg.powertrainPref.hev + seg.prefDriftPerYear.hev * t,
    phev: seg.powertrainPref.phev + seg.prefDriftPerYear.phev * t,
    bev: seg.powertrainPref.bev + seg.prefDriftPerYear.bev * t,
  };
  for (const r of w.regulations) {
    if (r.kind === 'subsidy' && r.status === 'in_force' && d >= r.effectiveDate && typeof r.params.bevPrefDelta === 'number') {
      p.bev += r.params.bevPrefDelta;
    }
  }
  const keys: (keyof PowertrainPref)[] = ['ice', 'hev', 'phev', 'bev'];
  for (const k of keys) p[k] = Math.max(0.01, p[k]);
  const tot = keys.reduce((a, k) => a + p[k], 0);
  for (const k of keys) p[k] = p[k] / tot;
  return p;
}

export function modelAppeal(m: VehicleModel, d: SimDate): number {
  if (!m.launchDate || d < m.launchDate) return m.baseAppeal;
  const age = yearsSince(m.launchDate, d);
  return m.baseAppeal - m.appealDecayPerYear * Math.max(0, age - 3);
}

export interface UtilityInput {
  priceCents: number;
  appeal: number;
  quality: number;
  satisfaction: number;
  powertrain: Powertrain;
}

export function productUtility(x: UtilityInput, seg: Segment, pref: PowertrainPref, extra = 0): number {
  return (
    PARAMS.appealWeight * x.appeal +
    PARAMS.qualityWeight * (x.quality - 70) +
    PARAMS.satisfactionWeight * (x.satisfaction - 70) -
    seg.priceElasticity * Math.log(x.priceCents / seg.refPriceCents) +
    Math.log(pref[x.powertrain]) +
    extra
  );
}

export function marketingUtility(w: World): number {
  const ratio = Math.max(0.05, (w.meta.marketingMonthlyCents * (w.meta.marketingEfficiency ?? 1)) / PARAMS.marketingBaselineMonthlyCents);
  return PARAMS.marketingElasticity * Math.log(ratio);
}

/** Demand multiplier from targeted campaigns running for this model on date d. */
export function campaignUplift(w: World, modelId: string, d: SimDate): number {
  let k = 1;
  for (const c of w.meta.campaigns ?? []) if (c.modelId === modelId && d >= c.start && d <= c.end) k *= c.uplift;
  return k;
}

/** Uplift a campaign buys: diminishing returns in monthly spend intensity, amplified by marketing efficiency. */
export function campaignUpliftFor(w: World, spendCents: number, days: number): number {
  const intensityM = (spendCents / 1e8) * (30 / Math.max(14, days)) * (w.meta.marketingEfficiency ?? 1);
  return Math.round((1 + 0.07 * Math.log(1 + intensityM / 2)) * 1000) / 1000;
}

/** Euro 7: after the regulation applies, non-compliant models can no longer be registered. */
export function canRegister(w: World, m: VehicleModel, d: SimDate): boolean {
  if (m.euro7Compliant) return true;
  const euro7 = w.regulations.find((r) => r.kind === 'type_approval' && r.params.allNewCarsDate);
  if (!euro7) return true;
  return d < String(euro7.params.allNewCarsDate);
}

export interface ShareRow {
  kind: 'asterion' | 'competitor' | 'other';
  id: string;
  name: string;
  powertrain: Powertrain | null;
  priceCents: number | null;
  utility: number;
  share: number;
  monthlyUnits: number;
}

export function asterionUtility(w: World, m: VehicleModel, seg: Segment, pref: PowertrainPref, d: SimDate): number {
  return productUtility(
    { priceCents: m.netPriceCents, appeal: modelAppeal(m, d), quality: m.quality, satisfaction: m.satisfaction, powertrain: m.powertrain },
    seg,
    pref,
    w.meta.distributionUtility + marketingUtility(w),
  );
}

export function segmentShares(w: World, segId: string, d: SimDate, opts: { includeModelIds?: string[] } = {}): ShareRow[] {
  const seg = w.segments.find((s) => s.id === segId);
  if (!seg) return [];
  const pref = powertrainPref(w, seg, d);
  const rows: ShareRow[] = [];
  for (const m of w.models) {
    if (m.segmentId !== segId) continue;
    const onSale = m.status === 'in_production' && canRegister(w, m, d);
    if (!onSale && !opts.includeModelIds?.includes(m.id)) continue;
    rows.push({ kind: 'asterion', id: m.id, name: m.name, powertrain: m.powertrain, priceCents: m.netPriceCents, utility: asterionUtility(w, m, seg, pref, d), share: 0, monthlyUnits: 0 });
  }
  for (const p of w.competitorProducts) {
    if (p.segmentId !== segId || p.status !== 'on_sale') continue;
    rows.push({
      kind: 'competitor',
      id: p.id,
      name: p.name,
      powertrain: p.powertrain,
      priceCents: p.priceCents,
      utility: productUtility({ priceCents: p.priceCents, appeal: p.appeal, quality: p.quality, satisfaction: 75, powertrain: p.powertrain }, seg, pref),
      share: 0,
      monthlyUnits: 0,
    });
  }
  rows.push({ kind: 'other', id: `${segId}:other`, name: 'Other brands', powertrain: null, priceCents: null, utility: seg.otherUtility, share: 0, monthlyUnits: 0 });
  const max = Math.max(...rows.map((r) => r.utility));
  const denom = rows.reduce((a, r) => a + Math.exp(r.utility - max), 0);
  const market = segmentMarketMonthly(w, seg, d);
  for (const r of rows) {
    r.share = Math.exp(r.utility - max) / denom;
    r.monthlyUnits = r.share * market;
  }
  return rows;
}

/** Expected monthly retail demand for one Asterion model at date d. */
export function modelMonthlyDemand(w: World, m: VehicleModel, d: SimDate): number {
  if (m.status !== 'in_production' || !canRegister(w, m, d)) return 0;
  const rows = segmentShares(w, m.segmentId, d);
  const row = rows.find((r) => r.id === m.id);
  if (!row) return 0;
  const mod = m.demandModifierUntil && d <= m.demandModifierUntil ? m.demandModifier : 1;
  return row.monthlyUnits * mod * campaignUplift(w, m.id, d);
}

export function expectedDailyDemand(w: World, m: VehicleModel, d: SimDate): number {
  return modelMonthlyDemand(w, m, d) / daysInMonth(d);
}

/**
 * Calibrate a segment's "other brands" utility so that `model` captures
 * `targetShare` of the segment. Used once when building the scenario.
 */
export function calibrateOtherUtility(w: World, segId: string, modelId: string, targetShare: number, d: SimDate): number {
  const seg = w.segments.find((s) => s.id === segId)!;
  seg.otherUtility = -50; // effectively absent while measuring the others
  const rows = segmentShares(w, segId, d).filter((r) => r.kind !== 'other');
  const target = rows.find((r) => r.id === modelId);
  if (!target) throw new Error(`calibration target ${modelId} not on sale`);
  const sumExp = rows.reduce((a, r) => a + Math.exp(r.utility), 0);
  const otherExp = Math.exp(target.utility) / targetShare - sumExp;
  if (otherExp <= 0) throw new Error(`cannot calibrate segment ${segId}: target share too high`);
  seg.otherUtility = Math.log(otherExp);
  return seg.otherUtility;
}

/** Cars a month still owed on firm fleet orders for a model (spread over their remaining delivery period). */
export function fleetMonthlyNeed(w: World, modelId: string, d: SimDate): number {
  let need = 0;
  for (const k of w.contracts) {
    if (k.status !== 'active' || !k.templateKey?.startsWith('fleet_') || k.terms.modelId !== modelId) continue;
    const left = Number(k.terms.units ?? 0) - Number(k.terms.delivered ?? 0);
    const months = Math.max(1, k.endDate ? diffDays(k.endDate, d) / 30.4 : 1);
    need += Math.max(0, left) / months;
  }
  return need;
}
