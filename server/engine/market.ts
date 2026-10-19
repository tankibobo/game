/**
 * A living market around the company:
 *  - the share price follows results, liquidity, the Eon and the board's
 *    confidence (monthly), and matters: a rights issue is priced off it;
 *  - competitors run promotions, suffer recalls and can get into trouble,
 *    which moves demand for Asterion's cars (through the same demand model).
 * Everything is deterministic for a seed; magnitudes are bounded.
 */
import { addDays, diffDays, type SimDate } from '../../shared/dates';
import { segmentShares } from './demand';
import { byId, clamp, emit, rngFor, type World } from './world';

function st(w: World, key: string) {
  let s = w.eventStates.find((x) => x.key === key);
  if (!s) {
    s = { key, lastFired: null, count: 0, activeUntil: null, data: {} };
    w.eventStates.push(s);
  }
  return s;
}

/** Share of a segment Asterion would have with and without a change applied (for "effect on us" lines). */
function ourShare(w: World, segId: string, d: SimDate): number {
  return segmentShares(w, segId, d).filter((r) => r.kind === 'asterion').reduce((a, r) => a + r.share, 0);
}

/** Asterion's share of each segment it sells in (for the monthly market report). */
export function ourSegmentShares(w: World): Record<string, number> {
  const d = w.meta.currentDate;
  const segs = new Set(w.models.filter((m) => m.status === 'in_production').map((m) => m.segmentId));
  return Object.fromEntries([...segs].map((sg) => [sg, Math.round(ourShare(w, sg, d) * 10000) / 10000]));
}

/**
 * Month end: move the share price toward what results justify. The market
 * already priced in the situation the CEO inherited, so the price reacts to
 * how the outlook changes from there: forecast margin, liquidity, the Eon
 * and the board's confidence.
 */
export function updateSharePrice(w: World): void {
  const s = st(w, 'share_price');
  const fc = w.meta.lastForecastSummary;
  const rev = Math.max(1, fc?.fyRevenueCents ?? 1);
  const margin = fc ? fc.fyEbitCents / rev : 0.02;
  const low = fc?.minLiquidity12mCents ?? 0;
  const eonState = fc?.eonSopForecast && diffDays(fc.eonSopForecast, w.meta.boardPlan.eonSopDate) <= 60 ? 1.05 : !fc?.eonSopForecast ? 0.95 : 1;
  if (s.data.anchor === undefined) Object.assign(s.data, { anchor: w.meta.sharePriceCents, baseMargin: margin, baseLowOk: low >= 40_000_000_000 ? 1 : 0, baseConf: w.meta.boardConfidence, baseEon: eonState });
  const anchor = Number(s.data.anchor);
  let target = anchor * clamp(1 + 6 * (margin - Number(s.data.baseMargin)), 0.4, 1.9);
  if (low < 40_000_000_000 && Number(s.data.baseLowOk)) target *= 0.85;
  else if (low >= 40_000_000_000 && !Number(s.data.baseLowOk)) target *= 1.1;
  target *= 1 + 0.004 * (w.meta.boardConfidence - Number(s.data.baseConf));
  target *= eonState / Number(s.data.baseEon);
  const rng = rngFor(w);
  const noise = 1 + 0.035 * rng.n(w.meta.currentDate, 'share');
  const before = w.meta.sharePriceCents;
  const after = Math.max(100, Math.round(((before + (target - before) * 0.35) * noise) / 10) * 10);
  w.meta.sharePriceCents = after;
  const chg = after / before - 1;
  if (Math.abs(chg) >= 0.08) {
    const dm = margin - Number(s.data.baseMargin);
    const why = chg > 0 ? (dm > 0.005 ? 'a better profit outlook' : eonState > 1 ? 'the Eon being on track' : 'a steadier outlook') : low < 40_000_000_000 ? 'liquidity worries' : dm < -0.005 ? 'a weaker profit outlook' : eonState < 1 ? 'doubts about the Eon' : 'a weaker outlook';
    emit(w, { type: 'share_price_move', category: 'market', severity: chg < 0 ? 'warning' : 'notice', title: `Asterion shares ${chg > 0 ? 'jump' : 'fall'} ${Math.abs(chg * 100).toFixed(0)}% this month`, description: `€${(before / 100).toFixed(2)} → €${(after / 100).toFixed(2)}. Analysts point to ${why}. A rights issue would now be priced off €${(after / 100).toFixed(2)}.`, causeKind: 'causal', cause: { text: 'Monthly market reaction to results and outlook.', refs: [] } });
  }
}

/** Daily: competitor promotions start and end, recalls fade, a weak competitor may fail. */
export function competitorDynamics(w: World): void {
  const d = w.meta.currentDate;
  const rng = rngFor(w);
  // End running promotions and recalls.
  for (const s of w.eventStates.filter((x) => (x.key.startsWith('promo:') || x.key.startsWith('recall:')) && x.activeUntil && x.activeUntil < d && !x.data.ended)) {
    const p = byId(w.competitorProducts, String(s.data.productId));
    if (p) {
      if (s.key.startsWith('promo:')) p.priceCents = Number(s.data.oldPrice);
      else p.appeal = Number(s.data.oldAppeal);
    }
    s.data.ended = 1;
    emit(w, { type: s.key.startsWith('promo:') ? 'competitor_promotion_end' : 'competitor_recall_end', category: 'market', severity: 'info', title: s.key.startsWith('promo:') ? `${p?.name ?? 'Competitor'} promotion ends` : `${p?.name ?? 'Competitor'} recovers from its recall`, description: s.key.startsWith('promo:') ? 'Prices back to normal.' : 'Buyers have forgotten the recall.', causeKind: 'scheduled', entities: p ? [{ type: 'competitor_product', id: p.id }] : [] });
  }
  if (!d.endsWith('-01') || w.mode !== 'live') return;
  const ourSegments = new Set(w.models.filter((m) => m.status === 'in_production').map((m) => m.segmentId));
  for (const comp of w.competitors) {
    const products = w.competitorProducts.filter((p) => p.competitorId === comp.id && p.status === 'on_sale' && ourSegments.has(p.segmentId));
    if (!products.length) continue;
    // Promotions: aggressive competitors more often, especially when Asterion gains share.
    const promoKey = `promo:${comp.id}`;
    const ps = w.eventStates.find((x) => x.key === promoKey);
    if (!(ps?.activeUntil && ps.activeUntil >= d) && !(ps?.lastFired && diffDays(d, ps.lastFired) < 150) && rng.chance(0.06 + 0.12 * comp.aggressiveness, d, 'promo', comp.id)) {
      const p = products[Math.floor(rng.u(d, 'promo-pick', comp.id) * products.length)];
      const cut = Math.round(rng.range(0.04, 0.08, d, 'promo-cut', comp.id) * 100) / 100;
      const before = ourShare(w, p.segmentId, d);
      const s = st(w, promoKey);
      s.data = { productId: p.id, oldPrice: p.priceCents };
      p.priceCents = Math.round((p.priceCents * (1 - cut)) / 100) * 100;
      const after = ourShare(w, p.segmentId, d);
      s.lastFired = d;
      s.activeUntil = addDays(d, 60);
      s.count += 1;
      emit(w, { type: 'competitor_promotion', category: 'market', severity: 'notice', title: `${comp.name} cuts the ${p.name} price ${Math.round(cut * 100)}% for two months`, description: `A spring-to-summer offensive by ${comp.name}. Effect on us: our share of the ${w.segments.find((x) => x.id === p.segmentId)?.name ?? 'segment'} ${((after / Math.max(1e-9, before) - 1) * 100).toFixed(1)}% while it lasts.`, causeKind: 'random_shock', cause: { text: `${comp.name} strategy: ${comp.strategy}`, refs: [{ type: 'competitor', id: comp.id }] }, entities: [{ type: 'competitor', id: comp.id }, { type: 'competitor_product', id: p.id }] });
    }
    // Recalls: rare, hurt the competitor's appeal for four months.
    const recallKey = `recall:${comp.id}`;
    const rs = w.eventStates.find((x) => x.key === recallKey);
    if (!(rs?.activeUntil && rs.activeUntil >= d) && rng.chance(0.025, d, 'comp-recall', comp.id)) {
      const p = products[Math.floor(rng.u(d, 'recall-pick', comp.id) * products.length)];
      const before = ourShare(w, p.segmentId, d);
      const s = st(w, recallKey);
      s.data = { productId: p.id, oldAppeal: p.appeal };
      p.appeal = Math.max(0, p.appeal - 7);
      const after = ourShare(w, p.segmentId, d);
      s.lastFired = d;
      s.activeUntil = addDays(d, 120);
      s.count += 1;
      emit(w, { type: 'competitor_recall', category: 'market', severity: 'notice', title: `${comp.name} recalls the ${p.name}`, description: `A safety recall dents buyers’ confidence in the ${p.name}. Effect on us: our segment share +${((after / Math.max(1e-9, before) - 1) * 100).toFixed(1)}% for about four months.`, causeKind: 'random_shock', cause: { text: 'Random shock: competitor quality problem.', refs: [] }, entities: [{ type: 'competitor', id: comp.id }, { type: 'competitor_product', id: p.id }] });
    }
  }
  // A cash-burning competitor drifts toward failure; if it fails its cars leave the market.
  for (const comp of w.competitors.filter((c) => c.financialHealth < 45)) {
    comp.financialHealth = clamp(Math.round((comp.financialHealth - rng.range(0, 2.2, d, 'health', comp.id)) * 10) / 10, 0, 100);
    const s = st(w, `distress:${comp.id}`);
    if (comp.financialHealth < 30 && !s.data.warned) {
      s.data.warned = 1;
      emit(w, { type: 'competitor_distress', category: 'market', severity: 'notice', title: `${comp.name} looks for a rescuer`, description: `${comp.name} is running out of cash and has hired advisers to find a buyer. If it fails, its customers will be looking for another car.`, causeKind: 'causal', cause: { text: 'Sustained losses.', refs: [{ type: 'competitor', id: comp.id }] }, entities: [{ type: 'competitor', id: comp.id }] });
    }
    if (comp.financialHealth < 18 && !s.data.failed) {
      s.data.failed = 1;
      const gone = w.competitorProducts.filter((p) => p.competitorId === comp.id && p.status === 'on_sale');
      const segs = [...new Set(gone.map((p) => p.segmentId))];
      const before = segs.map((sg) => ourShare(w, sg, d));
      for (const p of gone) p.status = 'withdrawn';
      const after = segs.map((sg) => ourShare(w, sg, d));
      emit(w, { type: 'competitor_failure', category: 'market', severity: 'notice', title: `${comp.name} stops production`, description: `${comp.name} has filed for insolvency and withdrawn ${gone.map((p) => p.name).join(', ')}. Effect on us: ${segs.map((sg, i) => `${w.segments.find((x) => x.id === sg)?.name}: share +${((after[i] / Math.max(1e-9, before[i]) - 1) * 100).toFixed(1)}%`).join('; ') || 'none in our segments'}.`, causeKind: 'causal', cause: { text: 'Insolvency.', refs: [{ type: 'competitor', id: comp.id }] }, entities: [{ type: 'competitor', id: comp.id }] });
    }
  }
}
