import { buildInitialWorld } from '../../server/scenario/initial';
import { buildForecast } from '../../server/engine/forecast';
import { ACTION_BY_TYPE } from '../../server/actions/registry';
const w = buildInitialWorld();
const apply = (type: string, p: any) => { const d = ACTION_BY_TYPE.get(type)!; const v = d.validate(w, p, 'ceo'); if (v.errors.length) throw new Error(v.errors.join()); d.commit(w, p, { actionId: 'x', approverId: 'ceo', actorId: 'ceo' }); };
if (process.argv[2] === 'good') {
  apply('approve_project', { projectId: 'PRJ-VELA-E7' });
  apply('adjust_production', { lineId: 'LINE-LYON-VELA', plannedDailyRate: 520 });
  if (process.argv[3] !== 'nocampaign') apply('address_issue', { issueId: 'ISS-KORA-INV', optionKey: 'service_campaign' });
}
const fc = buildForecast(w, 'dbg', 24);
const s = fc.data.scenarios[0];
console.log(s.summary);
for (const m of s.months) console.log(m.month, 'rev', (m.revenueCents/1e8).toFixed(0), 'ebitda', (m.ebitdaCents/1e8).toFixed(0), 'ebit', (m.ebitCents/1e8).toFixed(0), 'cash', (m.cashCents/1e8).toFixed(0), 'liq', (m.liquidityCents/1e8).toFixed(0), 'lev', m.netLeverage, 'prod', m.production, 'ret', m.retail);
