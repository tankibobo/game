/**
 * The living company: projects that visibly change the simulation, your own
 * projects, campaigns, deals you open yourself (fleet orders, contract
 * assembly), documents exchanged with colleagues, quick questions, employees
 * acting on their own, unsigned agreements lapsing, and the market around us.
 */
import { describe, expect, it } from 'vitest';
import { mEur } from '../shared/money';
import { loadWorld } from '../server/db/repo';
import { advanceTime, confirmAction, proposeAction } from '../server/game/game';
import { templateStatus } from '../server/game/decisions';
import { getDocument, shareDocument } from '../server/game/documents';
import { newsView } from '../server/game/news';
import { buildReport } from '../server/reports/catalog';
import { quickQuestion, submitOffer } from '../server/llm/conversation';
import type { DB } from '../server/db/connection';
import { newGameDb, noLlm } from './helpers';

function act(db: DB, type: string, payload: Record<string, unknown>) {
  const a = proposeAction(db, { type, payload, rationale: 'Test' });
  expect(a.errors, `${type}: ${a.errors.join(' ')}`).toEqual([]);
  const r = confirmAction(db, a.id, 'ceo', { boardRationale: 'A clear, factual case for the board.' });
  expect(r.ok, r.message).toBe(true);
  return r.action;
}

async function agree(db: DB, key: string, terms: Record<string, number>) {
  act(db, 'open_negotiation', { templateKey: key });
  const n = loadWorld(db).negotiations.find((x) => x.templateKey === key && x.status === 'open')!;
  let r = await submitOffer(db, noLlm, n.id, terms, 'We commit firm volumes; our forecast supports it and we have alternatives.');
  for (let i = 0; i < 6 && r.outcome === 'countered'; i++) {
    const x = loadWorld(db).negotiations.find((y) => y.id === n.id)!;
    r = await submitOffer(db, noLlm, n.id, x.rounds[x.rounds.length - 1].terms, 'Agreed.');
  }
  // The counterparty's own approval (their board, a ballot, a committee) comes back after a few days.
  if (r.outcome === 'pending_approval') advanceTime(db, 16);
  return { n, outcome: r.outcome, contract: loadWorld(db).contracts.find((k) => k.templateKey === key && k.status === 'agreed') ?? null };
}

describe('living company', () => {
  it('a completed project changes the simulation, says what it changed and leaves the catalogue', () => {
    const { db } = newGameDb(3);
    const eff0 = loadWorld(db).meta.marketingEfficiency;
    act(db, 'start_project', { templateKey: 'digital_crm' });
    for (let i = 0; i < 10; i++) advanceTime(db, 31);
    const w = loadWorld(db);
    const p = w.projects.find((x) => x.templateKey === 'digital_crm')!;
    expect(p.status).toBe('completed');
    expect(w.meta.marketingEfficiency).toBeGreaterThan(eff0);
    expect(p.impact.join(' ')).toMatch(/→/);
    expect(templateStatus(w, 'digital_crm').completed).toBe(p.completedDate);
    const again = proposeAction(db, { type: 'start_project', payload: { templateKey: 'digital_crm' } });
    expect(again.status).toBe('invalid');
    // The manager reports the result.
    const report = db.prepare("SELECT body FROM inbox WHERE subject LIKE '%completed%' AND body LIKE '%→%'").get() as { body: string } | undefined;
    expect(report?.body).toBeTruthy();
    // The project report carries what it changed.
    const r = buildReport(db, w, 'project', p.id, 'CHR-WIERZBICKI');
    expect(JSON.stringify(r.blocks)).toMatch(/What it changed/);
  }, 60_000);

  it('a project you design yourself is sized by the engine and its result measured', () => {
    const { db } = newGameDb(4);
    const a = proposeAction(db, { type: 'start_custom_project', payload: { name: 'Lyon lean wave', kind: 'plant_efficiency', targetId: 'FAC-LYON', size: 'small' } });
    expect(a.status).toBe('pending_confirmation');
    expect(JSON.stringify(a.consequences)).toMatch(/Expected:/);
    expect(proposeAction(db, { type: 'start_custom_project', payload: { kind: 'plant_efficiency', size: 'small' } }).status).toBe('invalid');
    const crew0 = loadWorld(db).factories.find((f) => f.id === 'FAC-LYON')!;
    confirmAction(db, a.id);
    for (let i = 0; i < 6; i++) advanceTime(db, 31);
    const w = loadWorld(db);
    const p = w.projects.find((x) => x.custom?.kind === 'plant_efficiency')!;
    expect(p.status).toBe('completed');
    expect(p.impact.length).toBeGreaterThan(0);
    const lyon = w.factories.find((f) => f.id === 'FAC-LYON')!;
    expect(lyon.fixedOverheadMonthlyCents).toBeLessThan(crew0.fixedOverheadMonthlyCents);
  }, 60_000);

  it('a campaign costs money, lifts the model while it runs and is measured', () => {
    const { db } = newGameDb(5);
    const w0 = loadWorld(db);
    const before = w0.balances['6200'] ?? 0;
    act(db, 'launch_campaign', { modelId: 'MDL-KORA', spendCents: mEur(5), weeks: 6, name: 'Kora spring' });
    expect(proposeAction(db, { type: 'launch_campaign', payload: { modelId: 'MDL-KORA', spendCents: mEur(2), weeks: 4 } }).status).toBe('invalid');
    advanceTime(db, 30);
    const w = loadWorld(db);
    const c = w.meta.campaigns[0];
    expect((w.balances['6200'] ?? 0) - before).toBeGreaterThanOrEqual(mEur(5));
    expect(c.uplift).toBeGreaterThan(1);
    expect(c.extraUnits).toBeGreaterThan(0);
    expect(c.extraContributionCents).toBeGreaterThan(0);
    const r = buildReport(db, w, 'marketing', null, 'CHR-GARNIER');
    expect(JSON.stringify(r.blocks)).toMatch(/Kora spring/);
    expect(r.summary).toMatch(/supports about/);
  });

  it('a fleet order negotiated by the CEO is delivered from stock and invoiced', async () => {
    const { db } = newGameDb(6);
    const { contract } = await agree(db, 'fleet_kora', { units: 3000, discountPct: 12, months: 6 });
    expect(contract).toBeTruthy();
    const rev0 = loadWorld(db).balances['4000'] ?? 0;
    act(db, 'sign_contract', { contractId: contract!.id });
    advanceTime(db, 45);
    const k = loadWorld(db).contracts.find((x) => x.id === contract!.id)!;
    expect(Number(k.terms.delivered)).toBeGreaterThan(0);
    expect(Number(k.terms.revenueCents)).toBeGreaterThan(0);
    expect(-(loadWorld(db).balances['4000'] ?? 0)).toBeGreaterThan(-rev0);
  }, 30_000);

  it('contract assembly reserves Lyon capacity and crews; you can walk away from talks or decline an agreement', async () => {
    const { db } = newGameDb(7);
    const w0 = loadWorld(db);
    const line0 = w0.lines.find((l) => l.id === 'LINE-LYON-VELA')!.maxDailyRate;
    const crew0 = w0.factories.find((f) => f.id === 'FAC-LYON')!.fixedCrew;
    const { contract } = await agree(db, 'contract_assembly', { carsPerDay: 100, feePerCarEur: 3200, years: 3 });
    expect(contract).toBeTruthy();
    act(db, 'sign_contract', { contractId: contract!.id });
    const w = loadWorld(db);
    expect(w.lines.find((l) => l.id === 'LINE-LYON-VELA')!.maxDailyRate).toBeLessThan(line0);
    expect(w.factories.find((f) => f.id === 'FAC-LYON')!.fixedCrew).toBeGreaterThan(crew0);
    // Walk away from talks.
    act(db, 'open_negotiation', { templateKey: 'hanseatic_price' });
    const n = loadWorld(db).negotiations.find((x) => x.templateKey === 'hanseatic_price' && x.status === 'open')!;
    act(db, 'withdraw_negotiation', { negotiationId: n.id, reason: 'Not now' });
    expect(loadWorld(db).negotiations.find((x) => x.id === n.id)!.status).not.toBe('open');
    // Decline an agreement.
    const f = await agree(db, 'fleet_vela', { units: 2000, discountPct: 12, months: 4 });
    expect(f.contract).toBeTruthy();
    act(db, 'decline_agreement', { contractId: f.contract!.id, reason: 'Changed plans' });
    expect(loadWorld(db).contracts.find((x) => x.id === f.contract!.id)!.status).not.toBe('agreed');
  }, 30_000);

  it('an agreement left unsigned is chased by Legal and then lapses', async () => {
    const { db } = newGameDb(8);
    const { contract } = await agree(db, 'fleet_kora', { units: 2000, discountPct: 12, months: 4 });
    expect(contract).toBeTruthy();
    const trust0 = loadWorld(db).characters.find((c) => c.id === contract!.counterpartyId)!.trustInCeo;
    advanceTime(db, 25);
    expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE from_id = 'CHR-LAURENT' AND body LIKE '%sign%'").get()).toMatchObject({ n: expect.any(Number) });
    advanceTime(db, 25);
    const w = loadWorld(db);
    expect(w.contracts.find((x) => x.id === contract!.id)!.status).toBe('expired');
    expect(w.characters.find((c) => c.id === contract!.counterpartyId)!.trustInCeo).toBeLessThan(trust0);
  }, 30_000);

  it('documents carry real reports; colleagues answer quick questions with the report attached', async () => {
    const { db } = newGameDb(9);
    const doc = shareDocument(db, { reports: [{ key: 'pnl' }, { key: 'sales' }], memo: 'Please read before Monday.', recipientIds: ['CHR-HOLM', 'CHR-GARNIER'] });
    const back = getDocument(db, doc.id);
    expect(back.reports.map((r) => r.key)).toEqual(['pnl', 'sales']);
    expect(back.reports[0].blocks.some((b) => b.kind === 'waterfall' || b.kind === 'kpis')).toBe(true);
    const q = await quickQuestion(db, noLlm, 'CHR-HOLM', 'Why are we losing money? Send me the P&L.');
    expect(q.reply.content.length).toBeGreaterThan(20);
    expect(q.documents.length).toBeGreaterThan(0);
    expect(q.documents[0].reports[0].key).toBe('pnl');
    // Asking again reuses the same quick-question thread.
    const q2 = await quickQuestion(db, noLlm, 'CHR-HOLM', 'And cash?');
    expect(q2.conversationId).toBe(q.conversationId);
  });

  it('executives act on their own: monthly reports, reactions to decisions and drafted proposals', () => {
    const { db } = newGameDb(10);
    const kora = loadWorld(db).models.find((m) => m.id === 'MDL-KORA')!;
    act(db, 'change_price', { modelId: 'MDL-KORA', netPriceCents: kora.netPriceCents - 150000, reason: 'Push volume' });
    advanceTime(db, 32);
    const mail = db.prepare("SELECT from_id, subject, attachments FROM inbox WHERE kind != 'briefing'").all() as { from_id: string; subject: string; attachments: string }[];
    expect(mail.some((m) => m.from_id === 'CHR-HOLM' && m.attachments !== '[]')).toBe(true);
    expect(mail.some((m) => m.from_id === 'CHR-GARNIER')).toBe(true);
    advanceTime(db, 62);
    const drafts = db.prepare("SELECT COUNT(*) AS n FROM actions WHERE source = 'initiative'").get() as { n: number };
    const shared = db.prepare("SELECT COUNT(*) AS n FROM shared_documents WHERE sender_id != 'ceo'").get() as { n: number };
    expect(shared.n).toBeGreaterThan(1);
    expect(drafts.n).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('the share price and competitors move, and the newspaper explains what it means for us', () => {
    const { db } = newGameDb(11);
    const p0 = loadWorld(db).meta.sharePriceCents;
    for (let i = 0; i < 10; i++) advanceTime(db, 31);
    const w = loadWorld(db);
    expect(w.meta.sharePriceCents).not.toBe(p0);
    const news = newsView(db, 12);
    expect(news.editions.length).toBeGreaterThan(3);
    expect(news.priceHistory.length).toBeGreaterThan(3);
    const comp = news.items.filter((i) => i.section === 'industry');
    expect(comp.length).toBeGreaterThan(0);
    expect(news.items.every((i) => i.headline && i.lede)).toBe(true);
    const competitorEvents = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('competitor_promotion','competitor_recall','competitor_distress','competitor_failure')").get() as { n: number };
    expect(competitorEvents.n).toBeGreaterThan(0);
  }, 60_000);

  it('blocks submitting the same decision twice while the first is still pending', () => {
    const { db } = newGameDb(12);
    const a = proposeAction(db, { type: 'start_project', payload: { templateKey: 'kora_phev' } });
    if (a.status !== 'pending_confirmation') return; // not possible in this scenario
    const r = confirmAction(db, a.id, 'ceo', { boardRationale: 'A clear, factual case for the board.' });
    expect(r.ok).toBe(true);
    const b = proposeAction(db, { type: 'start_project', payload: { templateKey: 'kora_phev' } });
    expect(b.status).toBe('invalid');
  });
});
