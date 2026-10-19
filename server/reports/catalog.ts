/**
 * The report catalogue: every piece of company information that can be
 * produced, read, shared or asked for. Each report is computed from
 * authoritative state at the moment it is built (never invented), carries a
 * one-line headline, and renders as figures, tables and charts. Characters
 * produce the reports their department owns; the CEO can circulate any of
 * them; characters may only ask for reports that exist here.
 */
import type { Report, ReportBlock, ReportInfo, Tone } from '../../shared/report';
import { addDays, addMonths, diffDays, fmtDate, monthName } from '../../shared/dates';
import { fmtEur, mEur, type Cents } from '../../shared/money';
import type { DB } from '../db/connection';
import { rowToForecast } from '../db/repo';
import { proposalActionIds, upcomingMeeting } from '../engine/board';
import { co2Target, fleetCo2Ytd } from '../engine/close';
import { marketingUtility, modelMonthlyDemand, segmentShares } from '../engine/demand';
import { cash } from '../engine/ledger';
import { engineeringFreeFte, grossDebt, interestCover, liquidity, netLeverage, rcf } from '../engine/metrics';
import { NEGOTIATION_TEMPLATES, lastCounter } from '../engine/negotiation';
import { requiredCrew, availableCrew } from '../engine/operations';
import { PARAMS } from '../engine/params';
import { milestonesOf } from '../engine/projects';
import { byId, type World } from '../engine/world';
import { staffingNeed } from '../actions/defs/people';
import { unitMaterialCost, FY2026 } from '../scenario/initial';

export class ReportError extends Error {}

// ---------------------------------------------------------------- helpers

const em = (c: number) => Math.round(c / 1e6) / 100; // cents → € millions, 2 decimals
const em1 = (c: number) => Math.round(c / 1e7) / 10; // cents → € millions, 1 decimal
const int = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const eurUnit = (c: number) => `€${Math.round(c / 100).toLocaleString('en-GB')}`;
const mLabel = (mk: string) => `${monthName(Number(mk.slice(5, 7))).slice(0, 3)} ${mk.slice(2, 4)}`;
const short = (name: string) => name.replace('Asterion ', '');

type Snap = World['snapshots'][number];

/** Closed months, oldest first (game months carry account and model detail). */
function months(w: World, n = 12): Snap[] {
  return w.snapshots.filter((s) => s.kind === 'month').sort((a, b) => (a.period < b.period ? -1 : 1)).slice(-n);
}
const gameMonths = (w: World, n = 12) => months(w, 30).filter((s) => s.data.byAccount).slice(-n);

/** P&L movements (debit-positive) → named amounts (positive = income for revenue lines, cost for cost lines). */
export interface PlBreakdown {
  vehicles: Cents;
  aftersales: Cents;
  otherIncome: Cents;
  materials: Cents;
  aftersalesCost: Cents;
  warranty: Cents;
  logistics: Cents;
  factoryStaff: Cents;
  engineeringStaff: Cents;
  salesStaff: Cents;
  corporateStaff: Cents;
  overhead: Cents;
  storage: Cents;
  marketing: Cents;
  ga: Cents;
  externalRd: Cents;
  restructuring: Cents;
  co2: Cents;
  recalls: Cents;
  lease: Cents;
  da: Cents;
  interest: Cents;
  tax: Cents;
}

export function plBreakdown(mv: Record<string, number>): PlBreakdown {
  const g = (...codes: string[]) => codes.reduce((a, c) => a + (mv[c] ?? 0), 0);
  return {
    vehicles: -g('4000'),
    aftersales: -g('4100'),
    otherIncome: -g('4900'),
    materials: g('5000'),
    aftersalesCost: g('5100'),
    warranty: g('5200'),
    logistics: g('5300'),
    factoryStaff: g('6000'),
    engineeringStaff: g('6010'),
    salesStaff: g('6020'),
    corporateStaff: g('6030'),
    overhead: g('6100'),
    storage: g('6150'),
    marketing: g('6200'),
    ga: g('6300'),
    externalRd: g('6400'),
    restructuring: g('6600'),
    co2: g('6700'),
    recalls: g('6800'),
    lease: g('6900'),
    da: g('6500', '6850'),
    interest: g('7000', '7100'),
    tax: g('8000'),
  };
}

export function plTotals(p: PlBreakdown) {
  const revenue = p.vehicles + p.aftersales;
  const variable = p.materials + p.aftersalesCost + p.warranty + p.logistics;
  const staff = p.factoryStaff + p.engineeringStaff + p.salesStaff + p.corporateStaff;
  const otherOpex = p.overhead + p.storage + p.marketing + p.ga + p.externalRd + p.restructuring + p.co2 + p.recalls + p.lease;
  const ebitda = revenue + p.otherIncome - variable - staff - otherOpex;
  const ebit = ebitda - p.da;
  const ebt = ebit - p.interest;
  return { revenue, variable, staff, otherOpex, grossMargin: revenue - variable, ebitda, ebit, ebt, net: ebt - p.tax };
}

/** Cost categories as the CFO presents them (label, amount, what it is). */
export function costCategories(p: PlBreakdown): { label: string; amount: Cents; what: string; fixed: boolean }[] {
  return [
    { label: 'Materials & components', amount: p.materials + p.aftersalesCost, what: 'Bought-in parts and battery packs for the cars and spare parts sold', fixed: false },
    { label: 'Warranty & logistics', amount: p.warranty + p.logistics, what: 'Warranty provision and delivery to dealers, per car sold', fixed: false },
    { label: 'Factory staff', amount: p.factoryStaff, what: 'Plant workforces (paid whether or not the lines run)', fixed: true },
    { label: 'Plant overhead & energy', amount: p.overhead + p.storage, what: 'Energy, maintenance, plant services, storage of unsold cars', fixed: true },
    { label: 'Engineering & R&D', amount: p.engineeringStaff + p.externalRd, what: 'Engineers and expensed project spend', fixed: true },
    { label: 'Sales & marketing', amount: p.salesStaff + p.marketing, what: 'Sales organisation and marketing budget', fixed: true },
    { label: 'Corporate & admin', amount: p.corporateStaff + p.ga + p.lease, what: 'Head office, G&A, rent and leases', fixed: true },
    { label: 'One-offs', amount: p.restructuring + p.co2 + p.recalls, what: 'Restructuring, CO₂ penalties, recalls and field actions', fixed: false },
    { label: 'Depreciation & amortisation', amount: p.da, what: 'Wear of plants and tooling; amortised development (non-cash)', fixed: true },
    { label: 'Interest & financing fees', amount: p.interest, what: 'Cost of the debt', fixed: true },
  ];
}

function sumAccounts(snaps: Snap[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of snaps) for (const [k, v] of Object.entries(s.data.byAccount ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Monthly fixed cost of a plant (payroll + overhead), at today's headcount and energy prices. */
export function plantMonthlyCost(w: World, factoryId: string): { staff: Cents; overhead: Cents } {
  const f = byId(w.factories, factoryId);
  const dep = f ? byId(w.departments, f.departmentId) : undefined;
  const staff = dep ? Math.round((dep.headcount * dep.annualCostPerHeadCents * w.meta.wageIndex) / 12) : 0;
  const overhead = f ? Math.round((f.status === 'operating' ? f.fixedOverheadMonthlyCents : f.fixedOverheadMonthlyCents * 0.35) * w.macro.energyIndex) : 0;
  return { staff, overhead };
}

export interface UnitEconomics {
  modelId: string;
  name: string;
  priceCents: Cents;
  materialCents: Cents;
  logisticsCents: Cents;
  warrantyCents: Cents;
  co2Cents: Cents;
  contributionCents: Cents;
  plantCents: Cents;
  marginCents: Cents;
  monthlyUnits: number;
  monthlyContributionCents: Cents;
  plantUtilisation: number;
}

/** Per-car economics: price minus variable costs (contribution), then the plant's fixed cost spread over its output. */
export function unitEconomics(w: World): UnitEconomics[] {
  const yr = Number(w.meta.currentDate.slice(0, 4));
  const target = co2Target(w, yr);
  const out: UnitEconomics[] = [];
  for (const m of w.models.filter((x) => x.status === 'in_production')) {
    const lines = w.lines.filter((l) => l.modelId === m.id);
    const material = unitMaterialCost(w, m);
    const co2 = Math.max(0, Math.round((m.co2Gkm - target) * PARAMS.co2PenaltyPerGramPerVehicleCents));
    const contribution = m.netPriceCents - material - m.logisticsPerUnitCents - m.warrantyPerUnitCents - co2;
    // Plant fixed cost per car: each plant's monthly cost shared by the cars it builds.
    let plant = 0;
    let util = 0;
    for (const l of lines) {
      const plantLines = w.lines.filter((x) => x.factoryId === l.factoryId);
      const plantMonthly = plantLines.reduce((a, x) => a + Math.max(x.plannedDailyRate, 0), 0) * 21.5;
      const cost = plantMonthlyCost(w, l.factoryId);
      const perCar = plantMonthly > 0 ? (cost.staff + cost.overhead) / plantMonthly : 0;
      const weight = lines.length ? (l.plannedDailyRate || 1) / lines.reduce((a, x) => a + (x.plannedDailyRate || 1), 0) : 1;
      plant += perCar * weight;
      util += (l.maxDailyRate ? l.plannedDailyRate / l.maxDailyRate : 0) * weight;
    }
    const units = m.retailLastMonth || Math.round(modelMonthlyDemand(w, m, w.meta.currentDate));
    out.push({ modelId: m.id, name: m.name, priceCents: m.netPriceCents, materialCents: material, logisticsCents: m.logisticsPerUnitCents, warrantyCents: m.warrantyPerUnitCents, co2Cents: co2, contributionCents: contribution, plantCents: Math.round(plant), marginCents: Math.round(contribution - plant), monthlyUnits: units, monthlyContributionCents: contribution * units, plantUtilisation: util });
  }
  return out;
}

function latestForecastData(db: DB) {
  const r = db.prepare('SELECT * FROM forecasts ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown> | undefined;
  return r ? rowToForecast(r) : null;
}

const tone = (bad: boolean, warn = false): Tone => (bad ? 'critical' : warn ? 'warning' : null);

// ---------------------------------------------------------------- builders

type Ctx = { db: DB; w: World; param: string | null };
type Built = Omit<Report, 'key' | 'date' | 'authorId'>;

function buildPnl({ w }: Ctx): Built {
  const d = w.meta.currentDate;
  const ytdMv = w.meta.ytdByAccount;
  const closed = gameMonths(w, 12);
  const useYtd = Object.keys(ytdMv).length > 0 && Math.abs(plTotals(plBreakdown(ytdMv)).revenue) > 0;
  const fc = w.meta.lastForecastSummary;
  const fcMv = fc?.fyByAccount && Object.keys(fc.fyByAccount).length ? fc.fyByAccount : null;
  const blocks: ReportBlock[] = [];
  if (!useYtd && !fcMv) {
    blocks.push({ kind: 'text', text: 'No sales have been booked yet this year; the first month closes at the end of January. FY2026 figures for reference.' });
    blocks.push({ kind: 'kpis', items: [{ label: 'FY2026 revenue', value: fmtEur(FY2026.revenueCents) }, { label: 'FY2026 EBITDA', value: fmtEur(FY2026.ebitdaCents) }, { label: 'FY2026 operating profit', value: fmtEur(FY2026.ebitCents), hint: pct(FY2026.ebitCents / FY2026.revenueCents) }] });
    return { title: 'Profit & loss: where the money goes', summary: `No month has closed yet this year. Last year Asterion made ${fmtEur(FY2026.ebitCents)} operating profit on ${fmtEur(FY2026.revenueCents)} revenue.`, blocks };
  }
  const ytdMvUsed = useYtd ? ytdMv : fcMv!;
  const periodLabel = useYtd ? `${d.slice(0, 4)} to date` : `${d.slice(0, 4)} full year (forecast)`;
  if (!useYtd) {
    const t0 = plTotals(plBreakdown(fcMv!));
    blocks.push({ kind: 'text', text: `No month has closed yet this year, so this is the forecast for the whole of ${d.slice(0, 4)} if nothing changes (an estimate from the simulation). Last year (FY2026, before you arrived): revenue ${fmtEur(FY2026.revenueCents)}, EBITDA ${fmtEur(FY2026.ebitdaCents)}, operating profit ${fmtEur(FY2026.ebitCents)}. This year: revenue ${fmtEur(t0.revenue)} (${fmtEur(t0.revenue - FY2026.revenueCents)}), EBITDA ${fmtEur(t0.ebitda)} (${fmtEur(t0.ebitda - FY2026.ebitdaCents)}).` });
  }
  const p = plBreakdown(ytdMvUsed);
  const t = plTotals(p);
  const lm = closed[closed.length - 1];
  const lmt = lm ? plTotals(plBreakdown(lm.data.byAccount ?? {})) : null;
  blocks.push({
    kind: 'kpis',
    items: [
      { label: `Revenue (${periodLabel})`, value: fmtEur(t.revenue), hint: !useYtd ? 'estimate' : `${int(w.snapshots.filter((s) => s.kind === 'month' && s.period.startsWith(d.slice(0, 4))).reduce((a, s) => a + s.data.unitsWholesale, 0) + w.models.reduce((a, m) => a + m.wholesaleMtd, 0))} cars invoiced to dealers` },
      { label: 'Operating profit (EBIT)', value: fmtEur(t.ebit), hint: `margin ${pct(t.ebit / Math.max(1, t.revenue))}`, tone: tone(t.ebit < 0) },
      { label: 'Net income', value: fmtEur(t.net), tone: tone(t.net < 0) },
      ...(lm && lmt ? [{ label: `Last month (${mLabel(lm.period)}) EBIT`, value: fmtEur(lmt.ebit), hint: `revenue ${fmtEur(lmt.revenue)}`, tone: tone(lmt.ebit < 0) } as const] : []),
    ],
  });
  blocks.push({
    kind: 'waterfall',
    title: `From revenue to profit — ${periodLabel} (€m)`,
    unit: '€m',
    steps: [
      { label: 'Revenue', value: em1(t.revenue + p.otherIncome) },
      { label: 'Materials', value: -em1(p.materials + p.aftersalesCost) },
      { label: 'Warranty & logistics', value: -em1(p.warranty + p.logistics) },
      { label: 'Gross margin', value: em1(t.grossMargin + p.otherIncome), total: true },
      { label: 'Factory staff', value: -em1(p.factoryStaff) },
      { label: 'Plant overhead', value: -em1(p.overhead + p.storage) },
      { label: 'Engineering', value: -em1(p.engineeringStaff + p.externalRd) },
      { label: 'Sales & marketing', value: -em1(p.salesStaff + p.marketing) },
      { label: 'Corporate', value: -em1(p.corporateStaff + p.ga + p.lease) },
      { label: 'One-offs', value: -em1(p.restructuring + p.co2 + p.recalls) },
      { label: 'EBITDA', value: em1(t.ebitda), total: true },
      { label: 'Depreciation', value: -em1(p.da) },
      { label: 'EBIT', value: em1(t.ebit), total: true },
      { label: 'Interest', value: -em1(p.interest) },
      { label: 'Tax', value: -em1(p.tax) },
      { label: 'Net income', value: em1(t.net), total: true },
    ],
    note: 'Bars going down are costs. “Gross margin” is what the cars earn before any fixed cost; everything after it is paid whatever the volume.',
  });
  const cats = costCategories(p);
  const lmCats = lm ? costCategories(plBreakdown(lm.data.byAccount ?? {})) : null;
  blocks.push({
    kind: 'table',
    title: 'Costs by category',
    columns: ['Category', periodLabel, '% of revenue', lm ? `Last month (${mLabel(lm.period)})` : 'Last month', 'What it is'],
    numeric: [false, true, true, true, false],
    rows: cats.map((c, i) => [c.label + (c.fixed ? ' ·fixed' : ''), fmtEur(c.amount), pct(c.amount / Math.max(1, t.revenue)), lmCats ? fmtEur(lmCats[i].amount) : '—', c.what]),
    note: '“·fixed” costs do not fall when you build or sell fewer cars.',
  });
  if (closed.length) {
    blocks.push({
      kind: 'chart',
      title: 'Monthly revenue, costs and operating profit (€m)',
      chart: 'bar',
      x: 'month',
      unit: '€m',
      series: [{ key: 'revenue', label: 'Revenue' }, { key: 'costs', label: 'Total operating costs' }, { key: 'ebit', label: 'Operating profit' }],
      data: closed.map((s) => {
        const tt = plTotals(plBreakdown(s.data.byAccount ?? {}));
        return { month: mLabel(s.period), revenue: em1(tt.revenue), costs: em1(tt.revenue + plBreakdown(s.data.byAccount ?? {}).otherIncome - tt.ebit), ebit: em1(tt.ebit) };
      }),
    });
  }
  // Break-even: average contribution per car vs fixed costs per month.
  const findings: { text: string; tone?: Tone }[] = [];
  const unitsYtd = w.snapshots.filter((s) => s.period?.startsWith(d.slice(0, 4)) && s.kind === 'month').reduce((a, s) => a + s.data.unitsWholesale, 0) + w.models.reduce((a, m) => a + m.wholesaleMtd, 0);
  const monthsYtd = Math.max(1, closed.filter((s) => s.period.startsWith(d.slice(0, 4))).length + (d.slice(8) > '15' ? 0.5 : 0));
  if (unitsYtd > 0) {
    const contribPerCar = (p.vehicles - p.materials - p.warranty - p.logistics) / unitsYtd;
    const fixedMonthly = cats.filter((c) => c.fixed && c.label !== 'Interest & financing fees').reduce((a, c) => a + c.amount, 0) / monthsYtd;
    const breakEven = contribPerCar > 0 ? fixedMonthly / contribPerCar : Infinity;
    const actual = unitsYtd / monthsYtd;
    findings.push({ text: `Each car sold earns on average ${eurUnit(contribPerCar)} after materials, warranty and delivery. Fixed costs run at about ${fmtEur(fixedMonthly)} a month, so the company needs about ${Number.isFinite(breakEven) ? int(breakEven) : '∞'} cars a month to break even at operating level; it is selling about ${int(actual)}.`, tone: actual < breakEven ? 'critical' : 'good' });
  }
  const top = [...cats].sort((a, b) => b.amount - a.amount)[0];
  findings.push({ text: `Largest cost: ${top.label.toLowerCase()} — ${pct(top.amount / Math.max(1, t.revenue), 0)} of revenue.` });
  if (p.interest > 0) findings.push({ text: `Interest and financing fees cost ${fmtEur(p.interest)} ${useYtd ? 'so far this year' : 'this year (forecast)'} (${pct(p.interest / Math.max(1, t.revenue))} of revenue) — it is the price of the debt, independent of operations.` });
  const oneOffs = p.restructuring + p.co2 + p.recalls;
  if (oneOffs > mEur(5)) findings.push({ text: `One-offs (restructuring, CO₂ penalty, recalls) cost ${fmtEur(oneOffs)} this year${useYtd ? '' : ' (forecast)'}.`, tone: 'warning' });
  if (p.storage > mEur(2)) findings.push({ text: `Storing unsold cars ${useYtd ? 'has cost' : 'will cost'} ${fmtEur(p.storage)} — a sign of overproduction.`, tone: 'warning' });
  if (FY2026.revenueCents) findings.push({ text: `For comparison: FY2026 operating margin was ${pct(FY2026.ebitCents / FY2026.revenueCents)}.` });
  blocks.push({ kind: 'bullets', title: 'What the numbers say', items: findings });
  return { title: 'Profit & loss: where the money goes', summary: `${periodLabel}: revenue ${fmtEur(t.revenue)}, operating profit ${fmtEur(t.ebit)} (${pct(t.ebit / Math.max(1, t.revenue))}), net income ${fmtEur(t.net)}. Largest cost: ${top.label.toLowerCase()}.`, blocks };
}

function buildUnitEconomics({ w }: Ctx): Built {
  const ue = unitEconomics(w);
  if (!ue.length) throw new ReportError('No model is in production.');
  const rows = ue.map((u) => [short(u.name), eurUnit(u.priceCents), eurUnit(u.materialCents), eurUnit(u.logisticsCents + u.warrantyCents), u.co2Cents ? eurUnit(u.co2Cents) : '—', eurUnit(u.contributionCents), eurUnit(u.plantCents), eurUnit(u.marginCents), int(u.monthlyUnits), pct(u.plantUtilisation, 0)]);
  const items: { text: string; tone?: Tone }[] = [];
  for (const u of ue) {
    if (u.marginCents < 0) items.push({ text: `${short(u.name)}: every car loses about ${eurUnit(-u.marginCents)} once its plant's fixed cost is counted — ${u.plantUtilisation < 0.75 ? `the plant runs at only ${pct(u.plantUtilisation, 0)} of capacity, so each car carries a lot of fixed cost` : 'the price does not cover the cost base'}.`, tone: 'critical' });
    else items.push({ text: `${short(u.name)}: earns ${eurUnit(u.contributionCents)} per car before fixed costs and ${eurUnit(u.marginCents)} after its plant's costs.`, tone: u.marginCents < mEur(0.01) ? 'warning' : 'good' });
    if (u.co2Cents > 0) items.push({ text: `${short(u.name)}: above the CO₂ target, each car adds about ${eurUnit(u.co2Cents)} of penalty to the fleet bill.`, tone: 'warning' });
  }
  return {
    title: 'Margin per car, by model',
    summary: ue.map((u) => `${short(u.name)} ${eurUnit(u.contributionCents)} contribution, ${eurUnit(u.marginCents)} after plant costs`).join('; ') + '.',
    blocks: [
      { kind: 'table', title: 'Per car sold', columns: ['Model', 'Net price', 'Materials', 'Warranty & delivery', 'CO₂ penalty', 'Contribution', 'Plant cost', 'Margin after plant', 'Sold / month', 'Plant use'], numeric: [false, true, true, true, true, true, true, true, true, true], rows, note: 'Contribution = what a car earns before fixed costs. Plant cost = the plant’s monthly staff and overhead divided by the cars it is planned to build. Engineering, sales, head office, depreciation and interest come on top.' },
      { kind: 'chart', title: 'Contribution and margin per car (€)', chart: 'bar', x: 'model', unit: '', series: [{ key: 'contribution', label: 'Contribution per car' }, { key: 'margin', label: 'After plant cost' }], data: ue.map((u) => ({ model: short(u.name), contribution: Math.round(u.contributionCents / 100), margin: Math.round(u.marginCents / 100) })) },
      { kind: 'bullets', title: 'Reading', items },
    ],
  };
}

function buildCash({ db, w }: Ctx): Built {
  const r = rcf(w);
  const fc = latestForecastData(db);
  const base = fc?.data.scenarios.find((s) => s.key === 'base');
  const hist = months(w, 12);
  const blocks: ReportBlock[] = [
    {
      kind: 'kpis',
      items: [
        { label: 'Cash', value: fmtEur(cash(w)) },
        { label: 'Liquidity (cash + undrawn credit line)', value: fmtEur(liquidity(w)), tone: tone(liquidity(w) < mEur(400), liquidity(w) < w.meta.boardPlan.minLiquidityCents) },
        { label: 'Credit line drawn', value: `${fmtEur(r?.principalCents ?? 0)} of ${fmtEur(r?.limitCents ?? 0)}`, hint: r ? `expires ${fmtDate(r.maturityDate)}` : 'no facility' },
        ...(base ? [{ label: '12-month low (forecast)', value: fmtEur(base.summary.minLiquidity12mCents), hint: fmtDate(base.summary.minLiquidity12mDate), tone: tone(base.summary.minLiquidity12mCents < mEur(400), base.summary.minLiquidity12mCents < w.meta.boardPlan.minLiquidityCents) } as const] : []),
      ],
    },
  ];
  if (hist.length) {
    blocks.push({ kind: 'chart', title: 'Where cash came from and went, by month (€m)', chart: 'bar', x: 'month', unit: '€m', series: [{ key: 'operating', label: 'Operations' }, { key: 'investing', label: 'Investment' }, { key: 'financing', label: 'Financing' }], data: hist.map((s) => ({ month: mLabel(s.period), operating: em1(s.data.operatingCfCents), investing: em1(s.data.investingCfCents), financing: em1(s.data.financingCfCents) })), note: 'Operations = cash from selling cars minus suppliers, wages and running costs. Investment = projects and plant spending. Financing = borrowing, repayments and equity.' });
  }
  if (base) {
    blocks.push({ kind: 'chart', title: 'Liquidity forecast, base case (€m)', chart: 'line', x: 'month', unit: '€m', series: [{ key: 'liquidity', label: 'Liquidity' }, { key: 'cash', label: 'Cash' }], data: base.months.slice(0, 18).map((m) => ({ month: mLabel(m.month), liquidity: em1(m.liquidityCents), cash: em1(m.cashCents) })), refY: 400, refLabel: 'EIB covenant €400m' });
  }
  const due = w.debts.filter((x) => x.status === 'active' && x.maturityDate <= addDays(w.meta.currentDate, 730)).sort((a, b) => (a.maturityDate < b.maturityDate ? -1 : 1));
  if (due.length) blocks.push({ kind: 'table', title: 'Debt falling due within two years', columns: ['Instrument', 'Amount', 'Due'], numeric: [false, true, false], rows: due.map((x) => [x.name, fmtEur(x.kind === 'rcf' ? x.principalCents : x.principalCents), fmtDate(x.maturityDate)]) });
  return { title: 'Cash & liquidity', summary: `Cash ${fmtEur(cash(w))}, liquidity ${fmtEur(liquidity(w))}${base ? `; forecast 12-month low ${fmtEur(base.summary.minLiquidity12mCents)} (${base.summary.minLiquidity12mDate})` : ''}.`, blocks };
}

function buildForecast({ db, w }: Ctx): Built {
  const fc = latestForecastData(db);
  if (!fc) throw new ReportError('No forecast is available yet.');
  const sc = fc.data.scenarios;
  const base = sc.find((s) => s.key === 'base')!;
  const plan = w.meta.boardPlan;
  return {
    title: 'Forecast (24 months, three scenarios)',
    summary: `Base case: FY operating profit ${fmtEur(base.summary.fyEbitCents)} vs plan ${fmtEur(plan.ebitTargetCents)}; 12-month liquidity low ${fmtEur(base.summary.minLiquidity12mCents)}; Eon start of production ${base.summary.eonSopForecast ?? 'blocked'}.`,
    blocks: [
      { kind: 'table', title: `Prepared ${fmtDate(fc.createdDate)} — estimates, no future decisions or shocks assumed`, columns: ['Scenario', 'FY revenue', 'FY operating profit', '12-month liquidity low', 'Eon start', 'CO₂ penalty FY'], numeric: [false, true, true, true, false, true], rows: sc.map((s) => [s.label, fmtEur(s.summary.fyRevenueCents), fmtEur(s.summary.fyEbitCents), fmtEur(s.summary.minLiquidity12mCents), s.summary.eonSopForecast ? fmtDate(s.summary.eonSopForecast) : 'blocked', fmtEur(s.summary.co2PenaltyFyCents)]) },
      { kind: 'chart', title: 'Liquidity by scenario (€m)', chart: 'line', x: 'month', unit: '€m', series: sc.map((s) => ({ key: s.key, label: s.label })), data: base.months.map((m, i) => ({ month: mLabel(m.month), ...Object.fromEntries(sc.map((s) => [s.key, em1(s.months[i]?.liquidityCents ?? 0)])) })), refY: 400, refLabel: 'EIB covenant €400m' },
      { kind: 'chart', title: 'Monthly operating profit, base case (€m)', chart: 'bar', x: 'month', unit: '€m', series: [{ key: 'ebit', label: 'Operating profit' }], data: base.months.slice(0, 18).map((m) => ({ month: mLabel(m.month), ebit: em1(m.ebitCents) })) },
      { kind: 'kpis', items: [{ label: 'Board plan: operating profit', value: fmtEur(plan.ebitTargetCents) }, { label: 'Board plan: minimum liquidity', value: fmtEur(plan.minLiquidityCents) }, { label: 'Board plan: Eon start', value: fmtDate(plan.eonSopDate) }] },
    ],
  };
}

function buildDebt({ w }: Ctx): Built {
  const active = w.debts.filter((x) => x.status === 'active');
  const lev = netLeverage(w);
  const icr = interestCover(w);
  return {
    title: 'Debt & covenants',
    summary: `Gross debt ${fmtEur(grossDebt(w))}, net leverage ${lev.toFixed(2)}x (limit 3.50x), interest cover ${icr.toFixed(1)}x (minimum 3.0x), rating ${w.meta.creditRating}.`,
    blocks: [
      { kind: 'kpis', items: [{ label: 'Gross debt', value: fmtEur(grossDebt(w)) }, { label: 'Net leverage', value: `${lev > 50 ? 'n/m' : `${lev.toFixed(2)}x`}`, hint: 'covenant ≤ 3.50x', tone: tone(lev > 3.5, lev > 3.2) }, { label: 'Interest cover', value: `${icr.toFixed(1)}x`, hint: 'covenant ≥ 3.0x', tone: tone(icr < 3, icr < 3.4) }, { label: 'Rating', value: `${w.meta.creditRating} (${w.meta.ratingOutlook})` }] },
      { kind: 'table', title: 'Instruments', columns: ['Instrument', 'Outstanding', 'Rate', 'Matures'], numeric: [false, true, true, false], rows: active.map((x) => [x.name, fmtEur(x.kind === 'rcf' ? x.principalCents : x.principalCents) + (x.kind === 'rcf' ? ` of ${fmtEur(x.limitCents)}` : ''), `${(x.rateBps / 100).toFixed(2)}%`, fmtDate(x.maturityDate)]) },
      { kind: 'chart', title: 'Repayments by year (€m)', chart: 'bar', x: 'year', unit: '€m', series: [{ key: 'due', label: 'Principal due' }], data: [0, 1, 2, 3, 4, 5, 6].map((k) => { const y = Number(w.meta.currentDate.slice(0, 4)) + k; return { year: String(y), due: em1(active.reduce((a, x) => a + (x.maturityDate.startsWith(String(y)) && x.kind !== 'rcf' ? x.principalCents : 0) + x.amortization.filter((am) => am.date.startsWith(String(y))).reduce((b, am) => b + am.amountCents, 0), 0)) }; }) },
      { kind: 'table', title: 'Covenants', columns: ['Covenant', 'Status', 'Last test'], rows: w.covenants.map((c) => [c.description, c.status, c.lastValue === null ? 'not tested yet' : c.metric === 'min_liquidity' ? fmtEur(c.lastValue) : `${c.lastValue.toFixed(2)}x (${c.lastTestDate})`]) },
    ],
  };
}

function buildSales({ w }: Ctx): Built {
  const d = w.meta.currentDate;
  const live = w.models.filter((m) => m.status === 'in_production');
  const hist = gameMonths(w, 12).filter((s) => s.data.byModel);
  const blocks: ReportBlock[] = [
    { kind: 'table', title: 'This month so far and last month', columns: ['Model', 'Sold last month', 'Built last month', 'Demand / month (est.)', 'Dealer stock', 'Factory stock', 'Stock days', 'Net price'], numeric: [false, true, true, true, true, true, true, true], rows: live.map((m) => { const dem = modelMonthlyDemand(w, m, d); const days = dem > 0 ? Math.round(((m.dealerStock + m.fgUnits) / dem) * 30) : 0; return [short(m.name), int(m.retailLastMonth), int(m.productionLastMonth), int(dem), int(m.dealerStock), int(m.fgUnits), days, fmtEur(m.netPriceCents)]; }), note: 'Stock days = cars in the chain (dealers + factory) ÷ monthly demand × 30. Around 45 is healthy; much more ties up cash and leads to discounting.' },
  ];
  if (hist.length) {
    blocks.push({ kind: 'chart', title: 'Cars sold to customers per month', chart: 'stacked', x: 'month', unit: 'units', series: live.map((m) => ({ key: m.id, label: short(m.name) })), data: hist.map((s) => ({ month: mLabel(s.period), ...Object.fromEntries(live.map((m) => [m.id, s.data.byModel?.[m.id]?.retail ?? 0])) })) });
    const lost = hist.reduce((a, s) => a + Object.values(s.data.byModel ?? {}).reduce((b, x) => b + x.lost, 0), 0);
    if (lost > 100) blocks.push({ kind: 'bullets', items: [{ text: `${int(lost)} customers walked away in the last ${hist.length} months because dealers had no car to sell them.`, tone: 'warning' }] });
  }
  const fleet = w.contracts.filter((k) => k.templateKey?.startsWith('fleet_') && ['active', 'expired'].includes(k.status) && k.signedDate);
  if (fleet.length) blocks.push({ kind: 'table', title: 'Fleet orders', columns: ['Order', 'Status', 'Cars', 'Delivered', 'Discount', 'Deliver by', 'Revenue so far'], numeric: [false, false, true, true, true, false, true], rows: fleet.map((k) => [k.title, k.status === 'active' ? 'delivering' : 'closed', int(Number(k.terms.units)), int(Number(k.terms.delivered ?? 0)), `${k.terms.discountPct}%`, k.endDate ? fmtDate(k.endDate) : '—', fmtEur(Number(k.terms.revenueCents ?? 0))]), note: 'Fleet cars come out of factory stock before dealers are served — the production plan has to include them.' });
  const items: { text: string; tone?: Tone }[] = [];
  for (const m of live) {
    const dem = modelMonthlyDemand(w, m, d);
    const days = dem > 0 ? ((m.dealerStock + m.fgUnits) / dem) * 30 : 0;
    if (days > 75) items.push({ text: `${short(m.name)}: ${Math.round(days)} days of stock — too many cars for the demand. Build fewer or sell harder (price, marketing).`, tone: 'warning' });
    else if (days < 25 && dem > 0) items.push({ text: `${short(m.name)}: only ${Math.round(days)} days of stock — sales are being lost.`, tone: 'warning' });
  }
  if (items.length) blocks.push({ kind: 'bullets', title: 'Reading', items });
  return { title: 'Sales by model', summary: live.map((m) => `${short(m.name)} sold ${int(m.retailLastMonth)} last month (demand ≈${int(modelMonthlyDemand(w, m, d))}/month)`).join('; ') + '.', blocks };
}

function buildMarket({ w }: Ctx): Built {
  const d = w.meta.currentDate;
  const blocks: ReportBlock[] = [];
  const summary: string[] = [];
  for (const seg of w.segments) {
    const rows = segmentShares(w, seg.id, d);
    const ours = rows.filter((r) => r.kind === 'asterion');
    if (!ours.length && !w.models.some((m) => m.segmentId === seg.id)) continue;
    const share = ours.reduce((a, r) => a + r.share, 0);
    summary.push(`${seg.name}: Asterion ${pct(share)} share`);
    blocks.push({ kind: 'table', title: `${seg.name} — about ${int(rows.reduce((a, r) => a + r.monthlyUnits, 0))} cars a month in Europe`, columns: ['Product', 'Maker', 'Powertrain', 'Net price', 'Share', 'Cars / month'], numeric: [false, false, false, true, true, true], rows: rows.sort((a, b) => b.share - a.share).map((r) => [r.name, r.kind === 'asterion' ? 'Asterion' : r.kind === 'other' ? '—' : byId(w.competitors, byId(w.competitorProducts, r.id)?.competitorId ?? '')?.name ?? '', r.powertrain?.toUpperCase() ?? '—', r.priceCents ? fmtEur(r.priceCents) : '—', pct(r.share), int(r.monthlyUnits)]) });
  }
  blocks.push({ kind: 'table', title: 'Competitors', columns: ['Competitor', 'Strategy', 'Financial health', 'EV capability'], numeric: [false, false, true, true], rows: w.competitors.map((c) => [c.name, c.strategy, Math.round(c.financialHealth), Math.round(c.evCapability)]) });
  return { title: 'Market & competitors', summary: summary.join('; ') + '.', blocks };
}

function buildMarketing({ w }: Ctx): Built {
  const d = w.meta.currentDate;
  const u = marketingUtility(w);
  const effect = Math.exp(u) - 1; // approximate demand change vs the baseline budget
  const campaigns = (w.meta.campaigns ?? []).slice(-8);
  const live = w.models.filter((m) => m.status === 'in_production');
  const blocks: ReportBlock[] = [
    { kind: 'kpis', items: [{ label: 'Marketing budget', value: `${fmtEur(w.meta.marketingMonthlyCents)} / month`, hint: `baseline ${fmtEur(PARAMS.marketingBaselineMonthlyCents)}` }, { label: 'Effect on demand (est.)', value: `${effect >= 0 ? '+' : ''}${pct(effect)}`, hint: 'vs spending the baseline budget', tone: effect < -0.03 ? 'warning' : null }, { label: 'Diminishing returns', value: 'yes', hint: 'doubling the budget adds ~8% demand, halving it costs ~8%' }] },
  ];
  if (campaigns.length) {
    blocks.push({ kind: 'table', title: 'Campaigns', columns: ['Campaign', 'Model', 'Period', 'Spend', 'Extra cars sold (est.)', 'Extra contribution (est.)'], numeric: [false, false, false, true, true, true], rows: campaigns.map((c) => [c.name, short(byId(w.models, c.modelId)?.name ?? c.modelId), `${fmtDate(c.start)} – ${fmtDate(c.end)}`, fmtEur(c.spendCents), int(c.extraUnits), fmtEur(c.extraContributionCents)]), note: 'Extra cars = the campaign’s demand uplift × the demand there would have been without it (engine estimate). Contribution = extra cars × contribution per car.' });
  } else blocks.push({ kind: 'text', text: 'No targeted campaign has run yet. A campaign raises one model’s demand for a few weeks; it pays off when the model has stock to sell and a healthy margin per car.' });
  // Is it worth it? Compare demand at the current budget with a little more, and with almost none.
  const ue = unitEconomics(w);
  const contrib = live.reduce((a, m) => a + (ue.find((x) => x.modelId === m.id)?.contributionCents ?? 0) * modelMonthlyDemand(w, m, d), 0) / Math.max(1, live.reduce((a, m) => a + modelMonthlyDemand(w, m, d), 0));
  const demandAt = (cents: number) => {
    const keep = w.meta.marketingMonthlyCents;
    try {
      w.meta.marketingMonthlyCents = cents;
      return live.reduce((a, m) => a + modelMonthlyDemand(w, m, d), 0);
    } finally {
      w.meta.marketingMonthlyCents = keep;
    }
  };
  const now = demandAt(w.meta.marketingMonthlyCents);
  const none = demandAt(Math.round(PARAMS.marketingBaselineMonthlyCents * 0.05));
  const more = demandAt(w.meta.marketingMonthlyCents + mEur(1));
  const less = demandAt(Math.max(0, w.meta.marketingMonthlyCents - mEur(1)));
  const gain = Math.round((more - now) * contrib);
  const loss = Math.round((now - less) * contrib);
  blocks.push({
    kind: 'bullets',
    title: 'Is it worth it?',
    items: [
      { text: `The current budget supports about ${int(now - none)} cars a month compared with almost no marketing (worth ≈${fmtEur(Math.round((now - none) * contrib))} contribution a month, for ${fmtEur(w.meta.marketingMonthlyCents)} spent).`, tone: (now - none) * contrib > w.meta.marketingMonthlyCents ? 'good' : 'warning' },
      { text: `Another €1m a month would sell ≈${int(more - now)} more cars (≈${fmtEur(gain)} contribution): ${gain > mEur(1) ? 'it would pay for itself' : 'it would not pay for itself'}.`, tone: gain > mEur(1) ? 'good' : null },
      { text: `€1m a month less would lose ≈${int(now - less)} cars (≈${fmtEur(loss)} contribution): ${loss < mEur(1) ? 'a saving worth considering' : 'a false saving'}.`, tone: loss < mEur(1) ? 'good' : null },
      { text: 'Extra demand only becomes sales when there are cars: check stock days before spending more.' },
    ],
  });
  blocks.push({ kind: 'table', title: 'Where marketing money works best', columns: ['Model', 'Contribution per car', 'Stock days', 'Verdict'], numeric: [false, true, true, false], rows: live.map((m) => { const dem = modelMonthlyDemand(w, m, d); const days = dem > 0 ? Math.round(((m.dealerStock + m.fgUnits) / dem) * 30) : 0; const c = ue.find((x) => x.modelId === m.id)?.contributionCents ?? 0; return [short(m.name), eurUnit(c), days, days > 60 && c > 0 ? 'Good target: stock to clear, positive margin' : days < 30 ? 'Not now: too little stock to sell' : c <= 0 ? 'Poor: each extra car loses money' : 'Neutral']; }) });
  const campLine = campaigns.length ? ` ${campaigns.length} campaign(s) so far: ${int(campaigns.reduce((a, c) => a + c.extraUnits, 0))} extra cars, ${fmtEur(campaigns.reduce((a, c) => a + c.extraContributionCents, 0))} extra contribution for ${fmtEur(campaigns.reduce((a, c) => a + c.spendCents, 0))} spent.` : ' No targeted campaign yet.';
  return { title: 'Marketing performance', summary: `The ${fmtEur(w.meta.marketingMonthlyCents)}/month budget supports about ${int(now - none)} cars a month; another €1m would ${gain > mEur(1) ? '' : 'not '}pay for itself.${campLine}`, blocks };
}

function buildProduction({ w }: Ctx): Built {
  const d = w.meta.currentDate;
  const hist = gameMonths(w, 12).filter((s) => s.data.byModel);
  const blocks: ReportBlock[] = [
    { kind: 'table', title: 'Lines', columns: ['Line', 'Model', 'Status', 'Planned / day', 'Capacity / day', 'Use'], numeric: [false, false, false, true, true, true], rows: w.lines.map((l) => [l.name, short(byId(w.models, l.modelId)?.name ?? ''), l.status.replace('_', ' '), l.plannedDailyRate, l.maxDailyRate, pct(l.maxDailyRate ? l.plannedDailyRate / l.maxDailyRate : 0, 0)]) },
    { kind: 'table', title: 'Plants', columns: ['Plant', 'Workforce', 'Crew needed', 'Gap', 'Morale', 'Absenteeism', 'Fixed cost / month'], numeric: [false, true, true, true, true, true, true], rows: w.factories.map((f) => { const dep = byId(w.departments, f.departmentId); const need = requiredCrew(w, f, d); const cost = plantMonthlyCost(w, f.id); return [f.name, int(dep?.headcount ?? 0), int(need), int(-(staffingNeed(w, f.departmentId))), Math.round(dep?.morale ?? 0), `${f.absenteeismPct.toFixed(1)}%`, fmtEur(cost.staff + cost.overhead)]; }), note: 'Gap > 0: more people than the plan needs (surplus); < 0: short of people.' },
  ];
  if (hist.length) blocks.push({ kind: 'chart', title: 'Cars built per month', chart: 'stacked', x: 'month', unit: 'units', series: w.models.filter((m) => m.status !== 'development').map((m) => ({ key: m.id, label: short(m.name) })), data: hist.map((s) => ({ month: mLabel(s.period), ...Object.fromEntries(w.models.map((m) => [m.id, s.data.byModel?.[m.id]?.produced ?? 0])) })) });
  const totalPlanned = w.lines.reduce((a, l) => a + l.plannedDailyRate, 0);
  const totalMax = w.lines.reduce((a, l) => a + l.maxDailyRate, 0);
  return { title: 'Production & plants', summary: `Planned ${int(totalPlanned)} cars/day of ${int(totalMax)} capacity (${pct(totalPlanned / Math.max(1, totalMax), 0)}). ${w.factories.map((f) => `${f.name}: ${int(byId(w.departments, f.departmentId)?.headcount ?? 0)} staff`).join('; ')}.`, blocks };
}

function buildSupply({ w }: Ctx): Built {
  const d = w.meta.currentDate;
  const rows = w.supplies.map((s) => {
    const need = s.modelIds.reduce((a, m) => a + w.lines.filter((l) => l.modelId === m).reduce((b, l) => b + l.plannedDailyRate, 0), 0);
    return [byId(w.suppliers, s.supplierId)?.name ?? s.supplierId, s.component, s.modelIds.map((m) => short(byId(w.models, m)?.name ?? m)).join('/'), s.dailyCapacity, need, eurUnit(s.unitPriceCents), s.pendingCapacity.length ? s.pendingCapacity.map((p) => `${p.dailyCapacity}/day from ${fmtDate(p.date)}`).join('; ') : '—', s.disruptionUntil && s.disruptionUntil >= d ? `−${Math.round(s.disruptionFactor * 100)}% until ${fmtDate(s.disruptionUntil)}` : '—'] as (string | number)[];
  });
  return {
    title: 'Supply chain',
    summary: w.supplies.filter((s) => s.disruptionUntil && s.disruptionUntil >= d).length ? 'Some supplies are disrupted.' : 'No supply disruption at the moment.',
    blocks: [
      { kind: 'table', title: 'Critical components', columns: ['Supplier', 'Component', 'For', 'Capacity / day', 'Planned need / day', 'Price per set', 'Contracted increases', 'Disruption'], numeric: [false, false, false, true, true, true, false, false], rows },
      { kind: 'table', title: 'Suppliers', columns: ['Supplier', 'Reliability', 'Quality', 'Financial health', 'Relationship', 'Payment terms'], numeric: [false, true, true, true, true, true], rows: w.suppliers.map((s) => [s.name, Math.round(s.reliability), Math.round(s.qualityScore), Math.round(s.financialHealth), Math.round(s.relationship), `${s.paymentTermsDays} days`]) },
    ],
  };
}

function buildWorkforce({ w }: Ctx): Built {
  const items: { text: string; tone?: Tone }[] = [];
  for (const dep of w.departments.filter((x) => x.kind === 'plant')) {
    const need = staffingNeed(w, dep.id);
    if (need > 60) items.push({ text: `${dep.name}: short of about ${int(need)} people for the production plan.`, tone: 'warning' });
    if (need < -150) items.push({ text: `${dep.name}: about ${int(-need)} more people than the plan needs (≈${fmtEur(Math.round(-need * dep.annualCostPerHeadCents * w.meta.wageIndex))} a year of payroll).`, tone: 'warning' });
    if (dep.morale < 45) items.push({ text: `${dep.name}: morale ${Math.round(dep.morale)} — absenteeism and strike risk rise.`, tone: 'warning' });
  }
  const free = Math.floor(engineeringFreeFte(w));
  items.push({ text: `${int(Math.max(0, free))} engineers are not assigned to any project.` });
  return {
    title: 'Workforce',
    summary: `${int(w.departments.reduce((a, x) => a + x.headcount, 0))} employees; payroll ≈${fmtEur(Math.round(w.departments.reduce((a, x) => a + x.headcount * x.annualCostPerHeadCents, 0) * w.meta.wageIndex))} a year.`,
    blocks: [
      { kind: 'table', title: 'Departments', columns: ['Department', 'People', 'Morale', 'Cost per head / year', 'Arriving', 'Leaving', 'Gap to plan'], numeric: [false, true, true, true, true, true, true], rows: w.departments.map((dep) => [dep.name, int(dep.headcount), Math.round(dep.morale), eurUnit(Math.round(dep.annualCostPerHeadCents * w.meta.wageIndex)), int(dep.hiring.reduce((a, h) => a + h.count, 0)), int(dep.leaving.reduce((a, l) => a + l.count, 0)), dep.kind === 'plant' ? int(-staffingNeed(w, dep.id)) : '—']) },
      { kind: 'chart', title: 'People by department', chart: 'bar', x: 'dept', unit: 'units', series: [{ key: 'people', label: 'People' }], data: w.departments.map((dep) => ({ dept: dep.name.replace(/ plant workforce| workforce/, ''), people: dep.headcount })) },
      { kind: 'bullets', title: 'Reading', items },
    ],
  };
}

function buildProjects({ w }: Ctx): Built {
  const list = w.projects.filter((p) => p.status !== 'cancelled');
  const prog = (id: string) => { const ms = milestonesOf(w, id); const tot = ms.reduce((a, m) => a + m.workTotal, 0); return tot ? ms.reduce((a, m) => a + Math.min(m.workDone, m.workTotal), 0) / tot : 0; };
  return {
    title: 'Project portfolio',
    summary: `${list.filter((p) => !['completed', 'proposed'].includes(p.status)).length} projects under way, ${list.filter((p) => p.status === 'completed').length} completed; ${int(Math.max(0, Math.floor(engineeringFreeFte(w))))} engineers free.`,
    blocks: [
      { kind: 'table', title: 'Projects', columns: ['Project', 'Status', 'Progress', 'Target', 'Forecast', 'Budget', 'Spent', 'Engineers'], numeric: [false, false, true, false, false, true, true, true], rows: list.map((p) => [p.name, p.status, pct(prog(p.id), 0), fmtDate(p.targetDate), p.status === 'completed' ? `done ${fmtDate(p.completedDate ?? p.targetDate)}` : p.forecastDate ? fmtDate(p.forecastDate) : p.status === 'proposed' ? 'not started' : 'blocked', fmtEur(p.budgetCents), fmtEur(p.spentCents), p.status === 'completed' ? 0 : Math.round(p.staffingFte)]) },
      { kind: 'chart', title: 'Engineers by project', chart: 'bar', x: 'project', unit: 'units', series: [{ key: 'fte', label: 'Engineers' }], data: list.filter((p) => !['completed', 'proposed'].includes(p.status)).map((p) => ({ project: p.name.slice(0, 22), fte: Math.round(p.staffingFte) })) },
    ],
  };
}

function buildProject({ w, param }: Ctx): Built {
  const p = byId(w.projects, param ?? '');
  if (!p) throw new ReportError('Choose which project the report is about.');
  const ms = milestonesOf(w, p.id);
  const issues = w.issues.filter((x) => (x.projectId === p.id || x.linked.some((l) => l.id === p.id)) && !['resolved', 'closed'].includes(x.status));
  return {
    title: `Project status: ${p.name}`,
    summary: `${p.status}; target ${p.targetDate}, forecast ${p.forecastDate ?? 'blocked'}; budget ${fmtEur(p.budgetCents)}, spent ${fmtEur(p.spentCents)}; ${Math.round(p.staffingFte)} engineers.`,
    blocks: [
      { kind: 'kpis', items: [{ label: 'Status', value: p.status }, { label: 'Target', value: fmtDate(p.targetDate), hint: p.targetDate !== p.originalTargetDate ? `originally ${fmtDate(p.originalTargetDate)}` : undefined }, { label: 'Forecast', value: p.forecastDate ? fmtDate(p.forecastDate) : p.status === 'completed' ? 'done' : 'blocked', tone: tone(!p.forecastDate && p.status !== 'completed', !!p.forecastDate && p.forecastDate > p.targetDate) }, { label: 'Budget used', value: `${fmtEur(p.spentCents)} of ${fmtEur(p.budgetCents)}` }] },
      { kind: 'table', title: 'Milestones', columns: ['Milestone', 'Status', 'Done', 'Planned', 'Completed'], numeric: [false, false, true, false, false], rows: ms.map((m) => [m.name, m.status, pct(m.workDone / Math.max(1, m.workTotal), 0), fmtDate(m.plannedDate), m.completedDate ? fmtDate(m.completedDate) : '—']) },
      ...(issues.length ? [{ kind: 'bullets' as const, title: 'Open issues', items: issues.map((i) => ({ text: `${i.title} (${i.severity})`, tone: (i.severity === 'critical' ? 'critical' : 'warning') as Tone })) }] : []),
      ...(p.completionEffects.length || p.status === 'completed' ? [{ kind: 'bullets' as const, title: p.status === 'completed' ? 'What it changed' : 'What it will change when completed', items: (p.impact ?? []).length ? (p.impact ?? []).map((t) => ({ text: t, tone: 'good' as Tone })) : p.completionEffects.map((e) => ({ text: describeEffect(w, e) })) }] : []),
    ],
  };
}

/** Plain-language description of a completion effect (before it happens). */
export function describeEffect(w: World, e: World['projects'][number]['completionEffects'][number]): string {
  const mn = (id: string) => (id === '*' ? 'all models' : short(byId(w.models, id)?.name ?? id));
  switch (e.type) {
    case 'model_appeal': return `${mn(e.modelId)} becomes more attractive to buyers (appeal ${e.delta > 0 ? '+' : ''}${e.delta}).`;
    case 'model_quality': return `Build quality ${e.delta > 0 ? '+' : ''}${e.delta} on ${mn(e.modelId)}.`;
    case 'model_cost': return `${mn(e.modelId)} material cost ${e.deltaCents > 0 ? '+' : '−'}${eurUnit(Math.abs(e.deltaCents))} per car.`;
    case 'model_co2': return `${mn(e.modelId)} CO₂ down to ${e.gkm} g/km.`;
    case 'model_euro7': return `${mn(e.modelId)} certified to Euro 7.`;
    case 'model_launch': return `${mn(e.modelId)} enters series production.`;
    case 'factory_overhead_pct': return `${byId(w.factories, e.factoryId)?.name ?? e.factoryId}: overhead ${(e.pct * 100).toFixed(0)}%.`;
    case 'factory_crew_pct': return `${byId(w.factories, e.factoryId)?.name ?? e.factoryId}: people needed per car ${(e.pct * 100).toFixed(0)}%.`;
    case 'line_capacity': return `${byId(w.lines, e.lineId)?.name ?? e.lineId}: capacity +${e.delta} cars/day.`;
    case 'supply_capacity': return `Supply capacity raised to ${e.dailyCapacity}/day.`;
    case 'segment_ref_price_pct': return `${mn(e.modelId)} positioned upmarket — supports ~${(e.pct * 100).toFixed(0)}% higher prices.`;
    case 'warranty_pct': return `Warranty cost ${(e.pct * 100).toFixed(0)}% on every car.`;
    case 'distribution': return `Sales reach +${Math.round(e.delta * 100)}% (more buyers reached).`;
    case 'marketing_efficiency': return `Marketing money works ${Math.round(e.pct * 100)}% harder.`;
    case 'morale': return `Morale ${e.delta > 0 ? '+' : ''}${e.delta} ${e.departmentId === '*' ? 'everywhere' : `at ${byId(w.departments, e.departmentId)?.name ?? e.departmentId}`}.`;
    case 'material_pct': return `Material cost ${(e.pct * 100).toFixed(1)}% on ${mn(e.modelId)}.`;
    case 'absenteeism': return `Absenteeism ${e.delta > 0 ? '+' : ''}${e.delta} points at ${e.factoryId === '*' ? 'all plants' : byId(w.factories, e.factoryId)?.name ?? e.factoryId}.`;
    case 'trust': return `${byId(w.characters, e.characterId)?.name ?? e.characterId} ${e.delta > 0 ? 'more' : 'less'} trusting.`;
    case 'model_feature': return `New on ${mn(e.modelId)}: ${e.feature}.`;
  }
  return 'Effect recorded.';
}

function buildContracts({ w }: Ctx): Built {
  const active = w.contracts.filter((c) => c.status === 'active');
  const agreed = w.contracts.filter((c) => c.status === 'agreed');
  return {
    title: 'Contracts & obligations',
    summary: `${active.length} contracts in force, ${agreed.length} agreed but not yet signed.`,
    blocks: [
      { kind: 'table', title: 'In force', columns: ['Contract', 'Counterparty', 'Signed', 'Ends', 'Terms'], rows: active.map((c) => [c.title, c.counterpartyName, c.signedDate ? fmtDate(c.signedDate) : 'before 2027', c.endDate ? fmtDate(c.endDate) : '—', c.summary.slice(0, 160)]) },
      ...(agreed.length ? [{ kind: 'bullets' as const, title: 'Agreed, not signed', items: agreed.map((c) => ({ text: `${c.title} with ${c.counterpartyName} — not binding until signed. The other side can still walk away${c.agreedDate ? ` (agreed ${fmtDate(c.agreedDate)}; offers lapse after 45 days)` : ''}.`, tone: 'warning' as Tone })) }] : []),
      { kind: 'bullets', title: 'Why signing matters', items: [{ text: 'An agreement at the table is a promise to sign, nothing more: until the contract is signed, no capacity, price or wage term applies, and the counterparty may withdraw.' }, { text: 'Signing makes the terms binding on both sides — including obligations such as take-or-pay volumes, prepayments or job guarantees. Legal reviews each contract before signature; the preview shows its obligations.' }] },
    ],
  };
}

function buildNegotiation({ w, param }: Ctx): Built {
  const n = byId(w.negotiations, param ?? '');
  if (!n) throw new ReportError('Choose which negotiation the report is about.');
  const t = NEGOTIATION_TEMPLATES[n.templateKey];
  const lc = lastCounter(n);
  const rounds = n.rounds.slice(-8);
  return {
    title: `Negotiation: ${n.title}`,
    summary: `${n.status}${n.deadline ? `, deadline ${n.deadline}` : ''}. ${lc ? `Their latest position: ${t.describe(lc)}` : ''}`,
    blocks: [
      { kind: 'kpis', items: [{ label: 'Status', value: n.status }, { label: 'Counterparty', value: byId(w.characters, n.counterpartyId)?.name ?? n.counterpartyId }, { label: 'Deadline', value: n.deadline ? fmtDate(n.deadline) : '—' }] },
      { kind: 'table', title: 'Rounds', columns: ['Date', 'By', 'Terms'], rows: rounds.map((r) => [fmtDate(r.date), r.by === 'ceo' ? 'Asterion' : byId(w.characters, n.counterpartyId)?.orgName ?? 'Counterparty', t.describe(r.terms)]) },
    ],
  };
}

function buildBoardProposal({ db, w, param }: Ctx): Built {
  const p = byId(w.boardProposals, param ?? '');
  if (!p) throw new ReportError('Choose which board proposal.');
  const ids = proposalActionIds(p);
  const rows = ids.length ? (db.prepare(`SELECT id, summary FROM actions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; summary: string }[]) : [];
  return {
    title: `Board proposal: ${p.title}`,
    summary: `${p.status}, meeting ${p.meetingDate}. ${rows.length ? `Contains: ${rows.map((r) => r.summary).join('; ')}.` : 'Endorsement only.'}`,
    blocks: [
      { kind: 'kpis', items: [{ label: 'Status', value: p.status }, { label: 'Meeting', value: fmtDate(p.meetingDate) }] },
      { kind: 'text', text: p.rationale || '(no written case)' },
      { kind: 'bullets', title: 'Decisions it contains', items: rows.length ? rows.map((r) => ({ text: r.summary })) : [{ text: 'None — an endorsement changes nothing by itself.' }] },
    ],
  };
}

function buildDecisions({ db, w }: Ctx): Built {
  const rows = db.prepare("SELECT sim_date, summary, status FROM actions WHERE status IN ('committed','pending_approval','approved') AND type NOT IN ('advance_time','approve_budget','negotiate_contract','share_document') AND sim_date >= ? ORDER BY created_at").all(addDays(w.meta.currentDate, -120)) as { sim_date: string; summary: string; status: string }[];
  return {
    title: 'Decision log',
    summary: `${rows.length} decisions in the last 120 days.`,
    blocks: [{ kind: 'table', columns: ['Date', 'Decision', 'Status'], rows: rows.map((r) => [fmtDate(r.sim_date), r.summary, r.status === 'committed' ? 'done' : r.status === 'approved' ? 'approved, waiting' : 'awaiting the board']) }],
  };
}

function buildQuality({ w }: Ctx): Built {
  const live = w.models.filter((m) => m.status === 'in_production');
  const issues = w.issues.filter((i) => ['quality', 'kora_inverter', 'recall'].includes(i.kind) && !['resolved', 'closed'].includes(i.status));
  return {
    title: 'Quality & warranty',
    summary: live.map((m) => `${short(m.name)} quality ${m.quality}, warranty ${eurUnit(m.warrantyPerUnitCents)}/car`).join('; ') + '.',
    blocks: [
      { kind: 'table', columns: ['Model', 'Quality (0–100)', 'Customer satisfaction', 'Warranty per car'], numeric: [false, true, true, true], rows: live.map((m) => [short(m.name), m.quality, Math.round(m.satisfaction), eurUnit(m.warrantyPerUnitCents)]), note: 'Quality and satisfaction feed demand directly: +10 quality ≈ +25% preference in the model’s segment.' },
      ...(issues.length ? [{ kind: 'bullets' as const, title: 'Open quality issues', items: issues.map((i) => ({ text: `${i.title} (${i.severity})`, tone: 'warning' as Tone })) }] : []),
    ],
  };
}

function buildCo2({ w }: Ctx): Built {
  const yr = Number(w.meta.currentDate.slice(0, 4));
  const target = co2Target(w, yr);
  const avg = fleetCo2Ytd(w);
  const live = w.models.filter((m) => m.status === 'in_production');
  const euro7 = w.regulations.find((r) => r.id === 'REG-EURO7');
  return {
    title: 'CO₂ & regulation',
    summary: `Fleet CO₂ ${avg ? avg.toFixed(1) : '—'} g/km this year vs target ${target}; every gram above costs €95 per car registered.`,
    blocks: [
      { kind: 'kpis', items: [{ label: 'Fleet average (year to date)', value: avg ? `${avg.toFixed(1)} g/km` : 'no sales yet', tone: tone(avg > target + 3, avg > target) }, { label: `${yr} target`, value: `${target} g/km` }, { label: 'Penalty provision so far', value: fmtEur(w.meta.co2ProvisionYtdCents) }] },
      { kind: 'table', title: 'Models', columns: ['Model', 'Powertrain', 'CO₂ g/km', 'Euro 7', 'Sold last month'], numeric: [false, false, true, false, true], rows: live.map((m) => [short(m.name), m.powertrain.toUpperCase(), m.co2Gkm, m.euro7Compliant ? 'certified' : `not certified${euro7 ? ` (needed from ${fmtDate(String(euro7.params.allNewCarsDate ?? ''))})` : ''}`, int(m.retailLastMonth)]) },
      { kind: 'bullets', items: [{ text: 'Electric cars count as 0 g/km: every Eon sold pulls the fleet average down. Selling more petrol Velas pushes it up.' }] },
    ],
  };
}

// ---------------------------------------------------------------- catalogue

interface ReportDef extends ReportInfo {
  build: (c: Ctx) => Built;
}

const HOLM = 'CHR-HOLM';
const GARNIER = 'CHR-GARNIER';
const MARCHETTI = 'CHR-MARCHETTI';
const OKAFOR = 'CHR-OKAFOR';
const WIERZ = 'CHR-WIERZBICKI';
const FERRER = 'CHR-FERRER';
const LINDQVIST = 'CHR-LINDQVIST';
const LAURENT = 'CHR-LAURENT';

export const REPORTS: ReportDef[] = [
  { key: 'pnl', title: 'Profit & loss: where the money goes', area: 'finance', ownerIds: [HOLM], description: 'Revenue to net income step by step, every cost category, monthly trend, break-even volume and what drives the result.', build: buildPnl },
  { key: 'unit_economics', title: 'Margin per car, by model', area: 'finance', ownerIds: [HOLM, MARCHETTI, GARNIER], description: 'For each model: price, materials, warranty and delivery, CO₂ penalty, contribution per car, plant cost per car and the margin left.', build: buildUnitEconomics },
  { key: 'cash', title: 'Cash & liquidity', area: 'finance', ownerIds: [HOLM], description: 'Cash, credit line, monthly cash flows from operations, investment and financing, the liquidity forecast and debt falling due.', build: buildCash },
  { key: 'forecast', title: 'Forecast (24 months, three scenarios)', area: 'finance', ownerIds: [HOLM], description: 'Base, downside and upside: revenue, operating profit, liquidity low point, Eon start of production, CO₂ penalty — against the board plan.', build: buildForecast },
  { key: 'debt', title: 'Debt & covenants', area: 'finance', ownerIds: [HOLM], description: 'Every loan and bond, interest rates, repayments by year, leverage and interest cover against the covenants, credit rating.', build: buildDebt },
  { key: 'sales', title: 'Sales by model', area: 'sales', ownerIds: [GARNIER], description: 'Cars sold and built per model, demand estimates, dealer and factory stock, stock days, lost sales and the monthly trend.', build: buildSales },
  { key: 'market', title: 'Market & competitors', area: 'sales', ownerIds: [GARNIER], description: 'Each segment’s size, every competing product with price and market share, and the competitors’ strength.', build: buildMarket },
  { key: 'marketing', title: 'Marketing performance', area: 'sales', ownerIds: [GARNIER], description: 'Marketing budget and its estimated effect on demand, campaigns with their extra sales and returns, and where money works best.', build: buildMarketing },
  { key: 'production', title: 'Production & plants', area: 'operations', ownerIds: [MARCHETTI], description: 'Line rates against capacity, plant workforces against crew needs, morale, absenteeism, fixed costs per plant, monthly output.', build: buildProduction },
  { key: 'supply', title: 'Supply chain', area: 'operations', ownerIds: [LINDQVIST, MARCHETTI], description: 'Critical components (battery packs, inverters…): supplier capacity against need, prices, contracted increases, disruptions; supplier health.', build: buildSupply },
  { key: 'quality', title: 'Quality & warranty', area: 'operations', ownerIds: [MARCHETTI], description: 'Quality and customer satisfaction per model, warranty cost per car, open quality problems.', build: buildQuality },
  { key: 'workforce', title: 'Workforce', area: 'people', ownerIds: [OKAFOR], description: 'Headcount, cost and morale per department, hires and departures in progress, plant surpluses and shortfalls, free engineers.', build: buildWorkforce },
  { key: 'projects', title: 'Project portfolio', area: 'projects', ownerIds: [WIERZ, FERRER], description: 'All projects with status, progress, dates, budget and engineers; how the engineering capacity is spent.', build: buildProjects },
  { key: 'project', title: 'Project status report', area: 'projects', ownerIds: [WIERZ, FERRER, MARCHETTI], description: 'One project in depth: dates, budget, milestones, open issues and what it changes when completed.', param: 'project', build: buildProject },
  { key: 'co2', title: 'CO₂ & regulation', area: 'operations', ownerIds: [WIERZ, GARNIER], description: 'Fleet CO₂ against the target and the penalty building up, each model’s emissions and Euro 7 status.', build: buildCo2 },
  { key: 'contracts', title: 'Contracts & obligations', area: 'legal', ownerIds: [LAURENT], description: 'Contracts in force and their terms, agreements awaiting signature, and what signing commits the company to.', build: buildContracts },
  { key: 'negotiation', title: 'Negotiation status', area: 'deals', ownerIds: [LAURENT, LINDQVIST], description: 'One negotiation: counterparty, deadline and every round of offers (no private limits).', param: 'negotiation', build: buildNegotiation },
  { key: 'board_proposal', title: 'Board proposal', area: 'board', ownerIds: [], description: 'A proposal on the board agenda: the case made and the decisions it contains.', param: 'board_proposal', build: buildBoardProposal },
  { key: 'decisions', title: 'Decision log', area: 'board', ownerIds: [], description: 'Every decision you took in the last four months, with its status.', build: buildDecisions },
];

export const REPORT_BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));

export function reportInfo(): ReportInfo[] {
  return REPORTS.map(({ build: _b, ...info }) => info);
}

/** Build a report from current state. Throws ReportError when it cannot be produced. */
export function buildReport(db: DB, w: World, key: string, param: string | null = null, authorId = 'ceo'): Report {
  const def = REPORT_BY_KEY.get(key);
  if (!def) throw new ReportError(`Unknown report "${key}".`);
  if (def.param && !param) throw new ReportError(`The ${def.title.toLowerCase()} needs a ${def.param.replace('_', ' ')}.`);
  const built = def.build({ db, w, param });
  return { key, date: w.meta.currentDate, authorId, ...built };
}

/** Flatten a report to text for a character's context (numbers kept, layout dropped). */
export function reportToText(r: Report, maxChars = 1800): string {
  const out: string[] = [`${r.title} (as of ${r.date}): ${r.summary}`];
  for (const b of r.blocks) {
    if (b.kind === 'kpis') out.push(b.items.map((k) => `${k.label}: ${k.value}${k.hint ? ` (${k.hint})` : ''}`).join('; '));
    else if (b.kind === 'table') {
      if (b.title) out.push(`${b.title}:`);
      for (const row of b.rows.slice(0, 10)) out.push(`- ${row.map((c, i) => (i === 0 ? String(c) : `${b.columns[i]} ${c}`)).join(', ')}`);
    } else if (b.kind === 'chart') {
      const last = b.data.slice(-4);
      out.push(`${b.title}: ${last.map((row) => `${row[b.x]} ${b.series.map((s) => `${s.label} ${row[s.key]}`).join('/')}`).join('; ')}`);
    } else if (b.kind === 'waterfall') out.push(`${b.title}: ${b.steps.map((s) => `${s.label} ${s.value}`).join(', ')}`);
    else if (b.kind === 'bullets') out.push(...b.items.map((i) => `* ${i.text}`));
    else out.push(b.text);
  }
  const text = out.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Which reports a character can produce from their own department's data. */
export function reportsOwnedBy(characterId: string): ReportInfo[] {
  return reportInfo().filter((r) => r.ownerIds.includes(characterId));
}

export { addMonths, diffDays, upcomingMeeting };
