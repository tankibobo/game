/**
 * Month-end close. Runs exactly once per calendar month, on its last day,
 * after the day's operations. Because everything recurring is posted here
 * (from accumulators such as headcount-days and principal-days), advancing
 * one day at a time or a whole month at once yields identical books.
 */
import { modelMonthlyDemand } from './demand';
import type { FinancialSnapshot, SnapshotData } from '../../shared/domain';
import { addDays, isQuarterEnd, isYearEnd, month, monthKey, quarterKey, year, type SimDate } from '../../shared/dates';
import { mulDiv, scale, times, type Cents } from '../../shared/money';
import { bal, cash, incomeStatementFromMovements, post } from './ledger';
import { headcount, interestCover, liquidity, netLeverage, grossDebt } from './metrics';
import { PARAMS } from './params';
import { monthEndTreasury, payOrDefer } from './treasury';
import { byId, emit, inbox, nextId, type World } from './world';

function payable(w: World, counterpartyId: string, category: Parameters<typeof pushPayable>[2], amount: Cents, days: number, sourceId: string, liabilityAccount = '2000') {
  pushPayable(w, counterpartyId, category, amount, days, sourceId, liabilityAccount);
}

function pushPayable(w: World, counterpartyId: string, category: import('../../shared/domain').PayableCategory, amount: Cents, days: number, sourceId: string, liabilityAccount = '2000') {
  if (amount === 0) return;
  w.payables.push({ id: nextId(w, 'AP'), counterpartyId, category, amountCents: amount, issueDate: w.meta.currentDate, dueDate: addDays(w.meta.currentDate, days), status: 'open', paidDate: null, sourceId, liabilityAccount });
}

export function co2Target(w: World, y: number): number {
  const reg = w.regulations.find((r) => r.kind === 'co2_fleet');
  const v = reg?.params[`target${y}`];
  return typeof v === 'number' ? v : y >= 2030 ? 72 : 98;
}

export function co2ProvisionRequired(w: World): Cents {
  if (w.meta.co2UnitsYtd <= 0) return 0;
  const avg = w.meta.co2GramsYtd / w.meta.co2UnitsYtd;
  const excess = Math.max(0, avg - co2Target(w, year(w.meta.currentDate)));
  return mulDiv(Math.round(excess * 1000) * w.meta.co2UnitsYtd, PARAMS.co2PenaltyPerGramPerVehicleCents, 1000);
}

export function fleetCo2Ytd(w: World): number {
  return w.meta.co2UnitsYtd > 0 ? w.meta.co2GramsYtd / w.meta.co2UnitsYtd : 0;
}

export function closeMonth(w: World): FinancialSnapshot {
  const d = w.meta.currentDate;
  const mk = monthKey(d);
  const src = `CLOSE-${mk}`;

  // 1. Payroll (from headcount-days, so mid-month hires/leavers are prorated)
  const payLines: { account: string; amountCents: Cents }[] = [];
  for (const dep of w.departments) {
    const cost = mulDiv(dep.headcountDays, Math.round(dep.annualCostPerHeadCents * w.meta.wageIndex), PARAMS.daysPerYear);
    dep.headcountDays = 0;
    if (cost > 0) payLines.push({ account: dep.expenseAccount, amountCents: cost });
  }
  const payroll = payLines.reduce((a, l) => a + l.amountCents, 0);
  if (payroll > 0) payOrDefer(w, { description: `Payroll ${mk}`, sourceType: 'payroll', sourceId: src, cf: { category: 'operating', line: 'payroll' }, debits: payLines, counterpartyId: 'EMPLOYEES', category: 'payroll' });

  // 2. Factory overhead (energy-indexed), storage, marketing, G&A, sustaining capex
  for (const f of w.factories) {
    const base = f.status === 'operating' ? f.fixedOverheadMonthlyCents : scale(f.fixedOverheadMonthlyCents, 0.35);
    const amt = scale(base, w.macro.energyIndex);
    post(w, { description: `Overhead & energy ${mk} — ${f.name}`, sourceType: 'overhead', sourceId: f.id, lines: [{ account: '6100', amountCents: amt }, { account: '2000', amountCents: -amt }] });
    payable(w, 'VARIOUS', 'overhead', amt, 30, src);
  }
  const unitDays = w.models.reduce((a, m) => a + m.fgUnitDaysMtd, 0);
  const storage = times(PARAMS.storageCostPerUnitDayCents, unitDays);
  if (storage > 0) {
    post(w, { description: `Finished-vehicle storage ${mk}`, sourceType: 'storage', sourceId: src, lines: [{ account: '6150', amountCents: storage }, { account: '2000', amountCents: -storage }] });
    payable(w, 'VARIOUS', 'other', storage, 30, src);
  }
  for (const m of w.models) m.fgUnitDaysMtd = 0;
  if (w.meta.marketingMonthlyCents > 0) {
    post(w, { description: `Marketing ${mk}`, sourceType: 'marketing', sourceId: src, lines: [{ account: '6200', amountCents: w.meta.marketingMonthlyCents }, { account: '2000', amountCents: -w.meta.marketingMonthlyCents }] });
    payable(w, 'VARIOUS', 'marketing', w.meta.marketingMonthlyCents, 30, src);
  }
  post(w, { description: `General & administrative ${mk}`, sourceType: 'ga', sourceId: src, lines: [{ account: '6300', amountCents: w.meta.gaMonthlyCents }, { account: '2000', amountCents: -w.meta.gaMonthlyCents }] });
  payable(w, 'VARIOUS', 'ga', w.meta.gaMonthlyCents, 30, src);
  if (w.meta.leaseMonthlyCents > 0) {
    payOrDefer(w, { description: `Lease payments ${mk}`, sourceType: 'lease', sourceId: src, cf: { category: 'operating', line: 'lease_payments' }, debits: [{ account: '6900', amountCents: w.meta.leaseMonthlyCents }], counterpartyId: 'LESSOR', category: 'other' });
  }
  const capex = w.meta.sustainingCapexMonthlyCents;
  if (capex > 0) {
    post(w, { description: `Sustaining capex ${mk}`, sourceType: 'capex', sourceId: src, lines: [{ account: '1500', amountCents: capex }, { account: '2000', amountCents: -capex }] });
    payable(w, 'VARIOUS', 'capex', capex, 30, src);
    w.meta.newPpeGrossCents += capex;
  }

  // 3. Project external spend incurred this month (invoiced, 30-day terms)
  for (const p of w.projects) {
    const amt = p.externalAccrualCents;
    if (amt <= 0) continue;
    p.externalAccrualCents = 0;
    if (p.capitalizeExternal) {
      const acct = p.kind === 'vehicle_program' ? '1600' : '1500';
      post(w, { description: `${p.name}: external spend ${mk} (capitalised)`, sourceType: 'project', sourceId: p.id, lines: [{ account: acct, amountCents: amt }, { account: '2000', amountCents: -amt }] });
      payable(w, 'VARIOUS', 'capex', amt, 30, p.id);
      if (acct === '1500') w.meta.newPpeGrossCents += amt;
      else if (p.status === 'completed' || byId(w.models, p.linkedModelId ?? '')?.status === 'in_production') w.meta.amortizingDevCents += amt;
    } else {
      post(w, { description: `${p.name}: external spend ${mk}`, sourceType: 'project', sourceId: p.id, lines: [{ account: '6400', amountCents: amt }, { account: '2000', amountCents: -amt }] });
      payable(w, 'VARIOUS', 'project', amt, 30, p.id);
    }
  }

  // 4. Depreciation & amortisation (non-cash)
  const dep = w.meta.legacyDepMonthlyCents + mulDiv(w.meta.newPpeGrossCents, 1, PARAMS.sustainingCapexDepreciationYears * 12);
  post(w, { description: `Depreciation ${mk}`, sourceType: 'depreciation', sourceId: src, lines: [{ account: '6500', amountCents: dep }, { account: '1510', amountCents: -dep }] });
  if (w.meta.amortizingDevCents > 0) {
    const remaining = bal(w, '1600') + bal(w, '1610');
    const amort = Math.min(remaining, mulDiv(w.meta.amortizingDevCents, 1, PARAMS.developmentAmortisationYears * 12));
    if (amort > 0) post(w, { description: `Amortisation of development costs ${mk}`, sourceType: 'amortisation', sourceId: src, lines: [{ account: '6500', amountCents: amort }, { account: '1610', amountCents: -amort }] });
  }

  // 5. Aftersales (parts & service) — revenue from the vehicle parc
  const asRevenue = times(PARAMS.aftersalesRevenuePerParcVehicleMonthCents, w.meta.aftersalesParc);
  const asCost = scale(asRevenue, PARAMS.aftersalesCostShare);
  post(w, { description: `Parts & aftersales ${mk}`, sourceType: 'aftersales', sourceId: src, lines: [{ account: '1100', amountCents: asRevenue }, { account: '4100', amountCents: -asRevenue }, { account: '5100', amountCents: asCost }, { account: '2000', amountCents: -asCost }] });
  w.receivables.push({ id: nextId(w, 'AR'), counterparty: 'Dealer network (parts)', amountCents: asRevenue, issueDate: d, dueDate: addDays(d, 30), status: 'open', settledDate: null, source: src });
  payable(w, 'SUP-TIER2', 'materials', asCost, 45, src);
  const retailMonth = w.models.reduce((a, m) => a + m.retailMtd, 0);
  w.meta.aftersalesParc = Math.round(w.meta.aftersalesParc * (1 - PARAMS.parcMonthlyDecay)) + retailMonth;

  // 6. Warranty claims and field-action spending (cash)
  const warrantyProv = -bal(w, '2200');
  const claims = Math.max(0, scale(warrantyProv, PARAMS.warrantyMonthlyClaimShare));
  if (claims > 0) payOrDefer(w, { description: `Warranty claims paid ${mk}`, sourceType: 'warranty', sourceId: src, cf: { category: 'operating', line: 'warranty_claims' }, debits: [{ account: '2200', amountCents: claims }], counterpartyId: 'DEALERS', category: 'warranty' });
  const recallProv = -bal(w, '2450');
  if (recallProv > 0) {
    const use = recallProv < 100_000_000 ? recallProv : scale(recallProv, 0.18);
    payOrDefer(w, { description: `Field-action costs paid ${mk}`, sourceType: 'recall', sourceId: src, cf: { category: 'operating', line: 'field_actions' }, debits: [{ account: '2450', amountCents: use }], counterpartyId: 'DEALERS', category: 'warranty' });
  }

  // 7. CO₂ compliance provision (true-up to YTD fleet average)
  const required = co2ProvisionRequired(w);
  const delta = required - w.meta.co2ProvisionYtdCents;
  if (delta !== 0) {
    post(w, { description: `CO₂ compliance provision true-up ${mk} (fleet avg ${(w.meta.co2GramsYtd / Math.max(1, w.meta.co2UnitsYtd)).toFixed(1)} g/km)`, sourceType: 'co2', sourceId: 'REG-CO2', lines: [{ account: '6700', amountCents: delta }, { account: '2300', amountCents: -delta }] });
    w.meta.co2ProvisionYtdCents = required;
  }

  // 8. Interest accruals and treasury sweep
  monthEndTreasury(w);

  // 9. Income tax (25% of YTD profit before tax after loss carry-forward)
  const ytd = { ...w.meta.ytdByAccount };
  delete ytd['8000'];
  const ytdEbt = -Object.values(ytd).reduce((a, b) => a + b, 0);
  const taxable = Math.max(0, ytdEbt - w.meta.taxLossCarryforwardCents);
  const requiredTax = Math.round(taxable * PARAMS.taxRate);
  const taxDelta = requiredTax - w.meta.taxAccruedYtdCents;
  if (taxDelta !== 0) {
    post(w, { description: `Income tax accrual ${mk}`, sourceType: 'tax', sourceId: src, lines: [{ account: '8000', amountCents: taxDelta }, { account: '2500', amountCents: -taxDelta }] });
    w.meta.taxAccruedYtdCents = requiredTax;
  }
  if (isQuarterEnd(d)) {
    const scheduled = w.payables.filter((p) => p.category === 'tax' && p.status !== 'paid').reduce((a, p) => a + p.amountCents, 0);
    const owed = -bal(w, '2500') - scheduled;
    if (owed > 0) pushPayable(w, 'TAX', 'tax', owed, PARAMS.taxPaymentDay, `TAX-${quarterKey(d)}`, '2500');
  }

  // 10. Snapshot
  const is = incomeStatementFromMovements(w.meta.mtdByAccount);
  const r = w.models.reduce((a, m) => ({ prod: a.prod + m.productionMtd, whs: a.whs + m.wholesaleMtd, ret: a.ret + m.retailMtd }), { prod: 0, whs: 0, ret: 0 });
  const cfBy = (cat: string) => w.meta.cfMtd[cat] ?? 0;
  const data: SnapshotData = {
    revenueCents: is.revenue,
    vehicleRevenueCents: is.vehicleRevenue,
    aftersalesRevenueCents: is.aftersalesRevenue,
    cogsCents: is.cogs,
    grossProfitCents: is.grossProfit,
    personnelCents: is.personnel,
    otherOpexCents: is.otherOpex,
    ebitdaCents: is.ebitda,
    daCents: is.da,
    ebitCents: is.ebit,
    interestCents: is.interest,
    taxCents: is.tax,
    netIncomeCents: is.netIncome,
    cashCents: cash(w),
    debtCents: grossDebt(w),
    liquidityCents: liquidity(w),
    operatingCfCents: cfBy('operating'),
    investingCfCents: cfBy('investing'),
    financingCfCents: cfBy('financing'),
    unitsProduced: r.prod,
    unitsWholesale: r.whs,
    unitsRetail: r.ret,
    headcount: headcount(w),
    byAccount: { ...w.meta.mtdByAccount },
    byModel: Object.fromEntries(w.models.filter((m) => m.status !== 'development' || m.productionMtd > 0).map((m) => [m.id, { produced: m.productionMtd, wholesale: m.wholesaleMtd, retail: m.retailMtd, lost: Math.round(m.lostSalesMtd), priceCents: m.netPriceCents, dealerStock: m.dealerStock, fgUnits: m.fgUnits, demand: Math.round(modelMonthlyDemand(w, m, d)) }])),
  };
  const snap: FinancialSnapshot = { id: `M:${mk}`, kind: 'month', period: mk, date: d, data };
  w.snapshots = w.snapshots.filter((s) => s.id !== snap.id);
  w.snapshots.push(snap);
  if (w.snapshots.length > 30) w.snapshots = w.snapshots.slice(-30);
  if (w.mode === 'live') w.out.snapshots.push(snap);

  // 11. Roll monthly counters
  w.meta.cfMtd = {};
  for (const m of w.models) {
    m.retailLastMonth = m.retailMtd;
    m.wholesaleLastMonth = m.wholesaleMtd;
    m.productionLastMonth = m.productionMtd;
    m.retailMtd = 0;
    m.wholesaleMtd = 0;
    m.productionMtd = 0;
    m.lostSalesMtd = 0;
  }

  // 12. Quarter-end covenant tests
  if (isQuarterEnd(d)) testCovenants(w);

  // 13. Year-end: CO₂ premium becomes payable in April; tax loss carry-forward
  if (isYearEnd(d)) {
    const co2 = -bal(w, '2300');
    if (co2 > 0) {
      pushPayable(w, 'EU-COMMISSION', 'co2', co2, 120, `CO2-${year(d)}`, '2300');
      emit(w, { type: 'co2_premium_due', category: 'regulatory', severity: 'warning', title: `${year(d)} CO₂ excess-emissions premium: €${(co2 / 1e8).toFixed(0)}m`, description: `Fleet average ${(w.meta.co2GramsYtd / Math.max(1, w.meta.co2UnitsYtd)).toFixed(1)} g/km vs target ${co2Target(w, year(d))} g/km. Payable by 30 April ${year(d) + 1}.`, causeKind: 'causal', cause: { text: 'Fleet average above the manufacturer-specific target.', refs: [{ type: 'regulation', id: 'REG-CO2' }] }, entities: [{ type: 'regulation', id: 'REG-CO2' }] });
    }
    if (ytdEbt < 0) w.meta.taxLossCarryforwardCents += -ytdEbt;
    else w.meta.taxLossCarryforwardCents = Math.max(0, w.meta.taxLossCarryforwardCents - ytdEbt);
    w.meta.taxAccruedYtdCents = 0;
    w.meta.co2ProvisionYtdCents = 0;
    w.meta.co2UnitsYtd = 0;
    w.meta.co2GramsYtd = 0;
  }
  return snap;
}

export function testCovenants(w: World): void {
  const d = w.meta.currentDate;
  for (const c of w.covenants) {
    const value = c.metric === 'net_leverage' ? netLeverage(w) : c.metric === 'interest_cover' ? interestCover(w) : liquidity(w);
    c.lastTestDate = d;
    c.lastValue = c.metric === 'min_liquidity' ? value : Math.round(value * 100) / 100;
    const ok = c.comparator === 'max' ? value <= c.threshold : value >= c.threshold;
    const waived = c.waiverUntil && d <= c.waiverUntil;
    if (ok) {
      if (c.status === 'breached') emit(w, { type: 'covenant_cured', category: 'finance', severity: 'notice', title: `${c.name} covenant back in compliance`, description: `${c.name}: ${fmtCov(c.metric, value)} vs ${fmtCov(c.metric, c.threshold)}.`, causeKind: 'causal', entities: [{ type: 'covenant', id: c.id }] });
      c.status = 'compliant';
    } else if (waived) {
      c.status = 'waived';
    } else {
      c.status = 'breached';
      emit(w, {
        type: 'covenant_breach', category: 'finance', severity: 'critical', title: `Covenant breach: ${c.name}`,
        description: `${c.name} tested at ${fmtCov(c.metric, value)} against a limit of ${fmtCov(c.metric, c.threshold)}. Lenders may accelerate the affected facilities; the RCF cannot be drawn until cured or waived.`,
        causeKind: 'causal', cause: { text: 'Quarter-end covenant test failed.', refs: c.instrumentIds.map((id) => ({ type: 'debt' as const, id })) }, entities: [{ type: 'covenant', id: c.id }],
        followUps: ['Request a covenant waiver from the banks (Finance → Financing → bank negotiation), raise equity, or sell assets to reduce leverage.'],
      });
      inbox(w, { kind: 'warning', fromId: 'CHR-FONTAINE', subject: `Covenant breach notice — ${c.name}`, body: `The quarterly compliance certificate shows ${c.name} at ${fmtCov(c.metric, value)} (limit ${fmtCov(c.metric, c.threshold)}). Under the facilities agreement this is an Event of Default. The lenders reserve their rights. We are open to discussing a waiver against a fee and an improved business plan.`, priority: 'urgent', linked: [{ type: 'covenant', id: c.id }] });
    }
  }
}

function fmtCov(metric: string, v: number): string {
  return metric === 'min_liquidity' ? `€${(v / 1e8).toFixed(0)}m` : `${v.toFixed(2)}x`;
}

export function monthIndex(d: SimDate): number {
  return year(d) * 12 + month(d);
}
