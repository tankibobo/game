/** Exercise the living-company mechanics end to end: deals, campaigns, own projects, initiative, impacts. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../server/db/connection';
import { loadWorld } from '../../server/db/repo';
import { advanceTime, confirmAction, createNewGame, proposeAction } from '../../server/game/game';
import { submitOffer } from '../../server/llm/conversation';
import { NoneProvider } from '../../server/llm/provider';
import { statement } from '../../server/game/queries';
import { fmtEur, mEur } from '../../shared/money';

const llm = { provider: new NoneProvider(), timeoutMs: 1000 };
const db = openDb(join(mkdtempSync(join(tmpdir(), 'liv-')), 'g.sqlite'));
createNewGame(db, 7);
const w = () => loadWorld(db);
const act = (type: string, payload: Record<string, unknown>) => {
  const a = proposeAction(db, { type, payload, rationale: 'Test' });
  if (a.status !== 'pending_confirmation') return console.log(`✗ ${type}: ${a.errors.join(' ')}`), null;
  const r = confirmAction(db, a.id, 'ceo', { boardRationale: 'A clear, factual case for the board.' });
  console.log(`${r.ok ? '✓' : '✗'} ${a.summary} → ${r.message}`);
  return a;
};
async function negotiate(key: string, first: Record<string, number>) {
  act('open_negotiation', { templateKey: key });
  const n = w().negotiations.find((x) => x.templateKey === key && x.status === 'open');
  if (!n) return console.log('no negotiation', key);
  let r = await submitOffer(db, llm, n.id, first, 'We commit firm volumes; our forecast supports it and we have alternatives.');
  for (let i = 0; i < 6 && r.outcome === 'countered'; i++) {
    const x = w().negotiations.find((y) => y.id === n.id)!;
    r = await submitOffer(db, llm, n.id, x.rounds[x.rounds.length - 1].terms, 'Agreed.');
  }
  console.log(`  ${key}: ${r.outcome}`);
  if (r.outcome === 'pending_approval') advanceTime(db, 16);
  const c = w().contracts.find((k) => k.templateKey === key && k.status === 'agreed');
  if (c) act('sign_contract', { contractId: c.id });
}
async function main() {
  act('launch_campaign', { modelId: 'MDL-KORA', spendCents: mEur(5), weeks: 6, name: 'Kora spring' });
  act('start_custom_project', { name: 'Lyon lean line', kind: 'plant_efficiency', targetId: 'FAC-LYON', size: 'small' });
  act('start_project', { templateKey: 'design_to_cost' });
  act('start_project', { templateKey: 'quality_programme' });
  await negotiate('fleet_vela', { units: 6000, discountPct: 12, months: 6 });
  await negotiate('contract_assembly', { carsPerDay: 150, feePerCarEur: 3600, years: 4 });
  await negotiate('hanseatic_price', { priceCutPct: 7, extensionYears: 1, volumeCommitPct: 70 });
  for (let i = 0; i < 12; i++) {
    const r = advanceTime(db, 31);
    const x = w();
    const fleet = x.contracts.find((k) => k.templateKey === 'fleet_vela');
    const assy = x.contracts.find((k) => k.templateKey === 'contract_assembly');
    console.log(`${x.meta.currentDate} conf ${x.meta.boardConfidence} cash ${fmtEur(x.balances['1000'])} · fleet ${fleet?.status}:${fleet?.terms.delivered ?? '-'} · assembly fees ${fmtEur(Number(assy?.terms.feesCents ?? 0))} · campaign extra ${x.meta.campaigns.map((c) => Math.round(c.extraUnits)).join(',')}`);
    const inb = db.prepare("SELECT from_id, subject, attachments FROM inbox WHERE date > ? AND kind != 'briefing' ORDER BY rowid").all(r.from) as { from_id: string; subject: string; attachments: string }[];
    for (const m of inb) console.log(`   ✉ ${m.from_id}: ${m.subject}${m.attachments !== '[]' ? ' 📎' : ''}`);
    const drafts = db.prepare("SELECT actor_id, summary FROM actions WHERE status = 'pending_confirmation' AND source = 'initiative'").all() as { actor_id: string; summary: string }[];
    for (const d of drafts) console.log(`   ✎ draft by ${d.actor_id}: ${d.summary}`);
  }
  for (const p of w().projects.filter((p) => p.status === 'completed')) console.log(`IMPACT ${p.name}:\n  ${p.impact.join('\n  ')}`);
  const st = statement(db, '2027-01-01', w().meta.currentDate);
  console.log('reconciliation', st.reconciliation);
  console.log('features', w().models.map((m) => `${m.name}: ${m.features.join(' | ')}`));
}

main().then(() => console.log('FLEET', JSON.stringify(w().contracts.filter((k) => k.templateKey?.startsWith('fleet_')).map((k) => ({ s: k.status, t: k.terms, end: k.endDate, vela: w().models[0].fgUnits })))));
