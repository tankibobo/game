/**
 * Daily retail and wholesale.
 *
 * Retail: customers buy from dealer stock. Expected daily retail comes from
 * the demand model; realised retail adds seeded noise. Unserved demand
 * partially waits as backlog (orders), the rest is lost.
 *
 * Wholesale: dealers order to cover retail plus a correction toward a target
 * stock (45 days of sales), capped when their stock is excessive. Orders are
 * shipped from company finished-goods stock. Revenue is recognised when
 * vehicles are invoiced/delivered to dealers (wholesale), together with the
 * cost of goods sold (weighted-average cost), warranty provision and outbound
 * logistics. Dealers pay after 30 days.
 */
import { addDays, type SimDate } from '../../shared/dates';
import { scale, times, type Cents } from '../../shared/money';
import { campaignUplift, canRegister, expectedDailyDemand } from './demand';
import { post } from './ledger';
import { PARAMS } from './params';
import { nextId, rngFor, type World } from './world';

export interface SalesResult {
  retail: Record<string, number>;
  wholesale: Record<string, number>;
  revenueCents: Cents;
}

export function warrantyRate(quality: number): number {
  // Each quality point below 75 adds 2% to warranty cost; above 75 saves 1.5% per point.
  return quality >= 75 ? 1 - (quality - 75) * 0.015 : 1 + (75 - quality) * 0.02;
}

export function runSales(w: World): SalesResult {
  const d: SimDate = w.meta.currentDate;
  const rng = rngFor(w);
  const res: SalesResult = { retail: {}, wholesale: {}, revenueCents: 0 };
  let revenue = 0;
  let cogs = 0;
  let warranty = 0;
  let logistics = 0;

  for (const m of w.models) {
    if (m.status !== 'in_production' && m.dealerStock <= 0 && m.fgUnits <= 0) continue;
    const registrable = canRegister(w, m, d);
    // --- retail
    const expected = m.status === 'in_production' && registrable ? expectedDailyDemand(w, m, d) : 0;
    const noise = 1 + PARAMS.retailNoiseSd * rng.n(d, 'retail', m.id);
    const newDemand = Math.max(0, Math.round(expected * Math.max(0, noise)));
    m.backlog = Math.max(0, Math.round(m.backlog * (1 - PARAMS.backlogDailyCancellation)));
    if (!registrable) m.backlog = 0;
    const wanting = m.backlog + newDemand;
    const sold = Math.min(m.dealerStock, wanting);
    const remaining = wanting - sold;
    const fromOld = Math.min(remaining, m.backlog);
    const fromNew = remaining - fromOld;
    const waits = Math.round(fromNew * PARAMS.backlogShareOfUnmet);
    m.backlog = fromOld + waits;
    m.lostSalesMtd += fromNew - waits;
    m.dealerStock -= sold;
    m.retailMtd += sold;
    m.cumulativeRetail += sold;
    res.retail[m.id] = sold;
    // Campaign attribution: the share of today's sales the running campaign(s) added.
    const uplift = campaignUplift(w, m.id, d);
    if (uplift > 1 && sold > 0 && w.mode === 'live') {
      const extra = sold * (1 - 1 / uplift);
      const unitCost = m.fgUnits > 0 ? m.fgValueCents / m.fgUnits : m.otherMaterialCostCents;
      const perCar = m.netPriceCents - unitCost - m.warrantyPerUnitCents - m.logisticsPerUnitCents;
      const running = (w.meta.campaigns ?? []).filter((c) => c.modelId === m.id && d >= c.start && d <= c.end);
      for (const c of running) {
        const share = Math.log(c.uplift) / Math.log(uplift);
        c.extraUnits = Math.round((c.extraUnits + extra * share) * 10) / 10;
        c.extraContributionCents += Math.round(extra * share * perCar);
      }
    }
    // CO₂ fleet accounting is based on registrations (retail).
    w.meta.co2UnitsYtd += sold;
    w.meta.co2GramsYtd += sold * m.co2Gkm;

    // --- dealer orders (wholesale)
    if (!registrable) continue;
    // Dealers size stock on deseasonalised demand, and order the seasonal flow.
    const dailyRetail = expected;
    const seg = w.segments.find((s) => s.id === m.segmentId);
    const season = seg ? seg.seasonality[Number(d.slice(5, 7)) - 1] : 1;
    const baseDaily = expected / Math.max(0.5, season);
    const targetStock = baseDaily * PARAMS.dealerTargetStockDays;
    const maxStock = baseDaily * PARAMS.dealerMaxStockDays;
    let order = 0;
    if (m.dealerStock < maxStock) {
      order = Math.round(dailyRetail + (targetStock - m.dealerStock) / PARAMS.dealerStockAdjustmentDays + m.backlog / PARAMS.dealerStockAdjustmentDays);
      order = Math.max(0, order);
    }
    const shipped = Math.min(order, m.fgUnits);
    if (shipped <= 0) continue;
    const unitCost = Math.round(m.fgValueCents / m.fgUnits);
    const costOut = shipped === m.fgUnits ? m.fgValueCents : times(unitCost, shipped);
    m.fgUnits -= shipped;
    m.fgValueCents -= costOut;
    m.dealerStock += shipped;
    m.wholesaleMtd += shipped;
    res.wholesale[m.id] = shipped;
    revenue += times(m.netPriceCents, shipped);
    cogs += costOut;
    warranty += scale(times(m.warrantyPerUnitCents, shipped), warrantyRate(m.quality));
    logistics += times(m.logisticsPerUnitCents, shipped);
  }

  if (revenue > 0) {
    post(w, {
      description: `Wholesale deliveries ${d}`,
      sourceType: 'sales',
      lines: [
        { account: '1100', amountCents: revenue },
        { account: '4000', amountCents: -revenue },
        { account: '5000', amountCents: cogs },
        { account: '1200', amountCents: -cogs },
        { account: '5200', amountCents: warranty },
        { account: '2200', amountCents: -warranty },
        { account: '5300', amountCents: logistics },
        { account: '2000', amountCents: -logistics },
      ],
    });
    w.receivables.push({ id: nextId(w, 'AR'), counterparty: 'Dealer network', amountCents: revenue, issueDate: d, dueDate: addDays(d, PARAMS.dealerPaymentDays), status: 'open', settledDate: null, source: `WHS-${d}` });
    if (logistics > 0) w.payables.push({ id: nextId(w, 'AP'), counterpartyId: 'SUP-LOGISTICS', category: 'other', amountCents: logistics, issueDate: d, dueDate: addDays(d, 30), status: 'open', paidDate: null, sourceId: `WHS-${d}`, liabilityAccount: '2000' });
  }
  res.revenueCents = revenue;
  return res;
}
