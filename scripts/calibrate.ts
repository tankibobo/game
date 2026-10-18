import { buildInitialWorld } from '../server/scenario/initial';
import { advanceDays } from '../server/engine/tick';
import { balanceSheetFromBalances } from '../server/engine/ledger';
import { liquidity, netLeverage } from '../server/engine/metrics';
import { buildForecast } from '../server/engine/forecast';
import { updateProjectForecasts } from '../server/engine/projects';

const days = Number(process.argv[2] ?? 365);
const w = buildInitialWorld();
updateProjectForecasts(w);
console.log('Eon forecast at start:', w.projects.map((p) => `${p.id} ${p.status} f=${p.forecastDate} p80=${p.forecastP80Date}`).join(' | '));
const bs0 = balanceSheetFromBalances(w.balances);
console.log('Opening BS', { assets: bs0.totalAssets / 1e8, liab: bs0.totalLiabilities / 1e8, eq: bs0.totalEquity / 1e8, check: bs0.check });
const t0 = Date.now();
const fc = buildForecast(w, 'start', 24);
console.log('forecast ms', Date.now() - t0, fc.data.scenarios.map((s) => ({ k: s.key, ebit: s.summary.fyEbitCents / 1e8, rev: s.summary.fyRevenueCents / 1e8, minLiq: s.summary.minLiquidityCents / 1e8, at: s.summary.minLiquidityDate, sop: s.summary.eonSopForecast, co2: s.summary.co2PenaltyFyCents / 1e8, lev: s.summary.maxLeverage })));
const t1 = Date.now();
advanceDays(w, days);
console.log('sim ms', Date.now() - t1, 'date', w.meta.currentDate, 'status', w.meta.status, w.meta.terminalReason ?? '');
for (const s of w.snapshots.filter((x) => x.period >= '2027')) {
  const d = s.data;
  console.log(s.period, 'rev', (d.revenueCents / 1e8).toFixed(0), 'ebitda', (d.ebitdaCents / 1e8).toFixed(1), 'ebit', (d.ebitCents / 1e8).toFixed(1), 'ni', (d.netIncomeCents / 1e8).toFixed(1), 'cash', (d.cashCents / 1e8).toFixed(0), 'prod', d.unitsProduced, 'whs', d.unitsWholesale, 'ret', d.unitsRetail, 'ocf', (d.operatingCfCents/1e8).toFixed(0), 'icf', (d.investingCfCents/1e8).toFixed(0), 'fcf', (d.financingCfCents/1e8).toFixed(0));
}
const bs = balanceSheetFromBalances(w.balances);
console.log('BS check', bs.check, 'liq', liquidity(w) / 1e8, 'lev', netLeverage(w).toFixed(2));
for (const m of w.models) console.log(m.name, m.status, 'fg', m.fgUnits, 'dealer', m.dealerStock, 'backlog', m.backlog, 'retailLM', m.retailLastMonth);
console.log(w.projects.map((p) => `${p.id} ${p.status} f=${p.forecastDate} done=${p.completedDate}`).join('\n'));
console.log('events', w.out.events.length);
for (const e of w.out.events.filter(e => e.severity !== 'info')) console.log(e.date, e.severity, e.title);
