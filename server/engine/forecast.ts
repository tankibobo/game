/**
 * Forecasts are produced by the simulation engine itself: the current world
 * is cloned and simulated forward with all randomness disabled (expected
 * values), no new player decisions, and no board votes. Three scenarios
 * bracket demand uncertainty. Forecasts are *labelled estimates*, stored
 * separately from actuals, and never written back into the ledger.
 */
import type { Forecast, ForecastData, ForecastMonth, ForecastScenario, ForecastSummary } from '../../shared/domain';
import { monthKey, year, type SimDate } from '../../shared/dates';
import { cash } from './ledger';
import { grossDebt, liquidity, netLeverage } from './metrics';
import { advanceDay } from './tick';
import { cloneWorld, nextId, type World } from './world';
import { co2ProvisionRequired } from './close';
import { forecastProject } from './projects';

const SCENARIOS: { key: ForecastScenario['key']; label: string; demand: number; assumptions: string[] }[] = [
  { key: 'base', label: 'Base case', demand: 1.0, assumptions: ['Market demand at current macro conditions', 'Current prices, production plans and staffing unchanged', 'No new financing, no random shocks', 'Projects progress at current staffing; gates open only with signed agreements'] },
  { key: 'downside', label: 'Downside', demand: 0.92, assumptions: ['Market demand 8% below base', 'Otherwise as base case'] },
  { key: 'upside', label: 'Upside', demand: 1.05, assumptions: ['Market demand 5% above base', 'Otherwise as base case'] },
];

export function runScenario(w: World, months: number, demandFactor: number, key: ForecastScenario['key'], label: string, assumptions: string[]): ForecastScenario {
  const f = cloneWorld(w);
  f.mode = 'forecast';
  f.scenarioDemandFactor = demandFactor;
  const startYear = year(w.meta.currentDate);
  const endMonth = monthKey(addMonthsKey(w.meta.currentDate, months));
  const out: ForecastMonth[] = [];
  let minLiq = liquidity(f);
  let minLiqDate: SimDate = f.meta.currentDate;
  let minLiq12 = minLiq;
  let minLiq12Date: SimDate = f.meta.currentDate;
  const horizon12 = addMonthsKey(w.meta.currentDate, 12);
  let maxLev = 0;
  const projectDates: Record<string, SimDate | null> = {};
  for (const p of f.projects) projectDates[p.id] = p.status === 'completed' ? p.completedDate : null;
  let guard = 0;
  while (f.meta.status === 'active' && monthKey(f.meta.currentDate) <= endMonth && guard++ < 1200) {
    const r = advanceDay(f);
    const liq = liquidity(f);
    if (liq < minLiq) {
      minLiq = liq;
      minLiqDate = r.date;
    }
    if (r.date < horizon12 && liq < minLiq12) {
      minLiq12 = liq;
      minLiq12Date = r.date;
    }
    for (const p of f.projects) if (p.status === 'completed' && !projectDates[p.id]) projectDates[p.id] = p.completedDate;
    if (r.closedMonth) {
      const s = f.snapshots.find((x) => x.period === r.closedMonth)!;
      const lev = netLeverage(f);
      maxLev = Math.max(maxLev, lev);
      out.push({ month: r.closedMonth, revenueCents: s.data.revenueCents, ebitdaCents: s.data.ebitdaCents, ebitCents: s.data.ebitCents, netIncomeCents: s.data.netIncomeCents, cashCents: cash(f), liquidityCents: liq, debtCents: grossDebt(f), netLeverage: Math.round(lev * 100) / 100, production: s.data.unitsProduced, retail: s.data.unitsRetail });
    }
  }
  // FY = closed actual months of the current year + forecast months of the same year
  const actualFy = w.snapshots.filter((s) => s.kind === 'month' && s.period.startsWith(String(startYear)));
  const fcFy = out.filter((m) => m.month.startsWith(String(startYear)) && !actualFy.some((a) => a.period === m.month));
  const fyEbit = actualFy.reduce((a, s) => a + s.data.ebitCents, 0) + fcFy.reduce((a, m) => a + m.ebitCents, 0);
  const fyRev = actualFy.reduce((a, s) => a + s.data.revenueCents, 0) + fcFy.reduce((a, m) => a + m.revenueCents, 0);
  const summary: ForecastSummary = {
    createdDate: w.meta.currentDate,
    fyEbitCents: fyEbit,
    fyRevenueCents: fyRev,
    minLiquidityCents: minLiq,
    minLiquidityDate: minLiqDate,
    minLiquidity12mCents: minLiq12,
    minLiquidity12mDate: minLiq12Date,
    eonSopForecast: projectDates['PRJ-EON'] ?? null,
    eonSopConditional: projectDates['PRJ-EON'] ? projectDates['PRJ-EON'] : conditionalSop(w),
    co2PenaltyFyCents: co2EstimateFy(f, startYear),
    maxLeverage: Math.round(maxLev * 100) / 100,
  };
  return { key, label, assumptions, months: out, summary, projectDates };
}

function conditionalSop(w: World): SimDate | null {
  const p = w.projects.find((x) => x.id === 'PRJ-EON');
  if (!p || p.status === 'completed' || p.status === 'cancelled') return p?.completedDate ?? null;
  return forecastProject(w, p, 1100, { assumeSupply: true }).p50;
}

function co2EstimateFy(f: World, y: number): number {
  // After the forecast run passed year end, the FY premium sits in the CO₂ payable created at close.
  const pay = f.payables.find((p) => p.sourceId === `CO2-${y}`);
  if (pay) return pay.amountCents;
  return co2ProvisionRequired(f);
}

function addMonthsKey(d: SimDate, n: number): SimDate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  return `${y + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`;
}

export function buildForecast(w: World, trigger: string, months = 24): Forecast {
  const scenarios = SCENARIOS.map((s) => runScenario(w, months, s.demand, s.key, s.label, s.assumptions));
  const data: ForecastData = {
    horizonMonths: months,
    scenarios,
    notes: [
      'Estimates produced by running the simulation forward from the current state with randomness disabled.',
      'Board decisions, negotiations and financing not yet agreed are NOT included.',
      'Actual outcomes will differ: supplier disruptions, test failures, strikes and market shocks are excluded from these scenarios.',
    ],
  };
  return { id: nextId(w, 'FC'), createdDate: w.meta.currentDate, trigger, data };
}
