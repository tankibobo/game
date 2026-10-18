import { buildInitialWorld } from '../../server/scenario/initial';
import { advanceDay } from '../../server/engine/tick';
import { ACCOUNT_BY_CODE } from '../../server/engine/accounts';
const w = buildInitialWorld();
const target = process.argv[2] ?? '2027-03';
for (;;) {
  const r = advanceDay(w);
  if (r.closedMonth === target) break;
}
const snapMv: Record<string, number> = {};
for (const e of w.out.journal) if (e.date.startsWith(target)) for (const l of e.lines) { const a = ACCOUNT_BY_CODE.get(l.account)!; if (a.type === 'revenue' || a.type === 'expense') snapMv[l.account] = (snapMv[l.account] ?? 0) + l.amountCents; }
for (const [k, v] of Object.entries(snapMv).sort()) console.log(k, ACCOUNT_BY_CODE.get(k)!.name.padEnd(36), (v / 1e8).toFixed(1));
const cfm: Record<string, number> = {};
for (const e of w.out.journal) if (e.date.startsWith(target) && e.cfCategory) { const c = e.lines.filter(l => l.account === '1000').reduce((a, l) => a + l.amountCents, 0); cfm[`${e.cfCategory}:${e.cfLine}`] = (cfm[`${e.cfCategory}:${e.cfLine}`] ?? 0) + c; }
console.log(Object.fromEntries(Object.entries(cfm).map(([k, v]) => [k, (v / 1e8).toFixed(1)])));
for (const m of w.models) console.log(m.name, 'prodLM', m.productionLastMonth, 'whsLM', m.wholesaleLastMonth, 'retLM', m.retailLastMonth, 'fg', m.fgUnits, 'dealer', m.dealerStock);
