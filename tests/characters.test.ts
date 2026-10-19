import { describe, expect, it } from 'vitest';
import { loadWorld } from '../server/db/repo';
import { confirmAction, proposeAction } from '../server/game/game';
import { shareDocument } from '../server/game/documents';
import { buildContext } from '../server/llm/context';
import { listMessages, sendMessage, startConversation } from '../server/llm/conversation';
import { ScriptedProvider } from '../server/llm/provider';
import { fingerprint, newGameDb, withProvider } from './helpers';

const ctx = (db: ReturnType<typeof newGameDb>['db'], id: string, msg = 'Where do we stand?') => buildContext(db, loadWorld(db), { characterId: id, conversationId: null, playerMessage: msg }).text;

describe('characters share one consistent picture of the company', () => {
  it('tells every character exactly what the CEO can do, so they only ask for real things', () => {
    const { db } = newGameDb();
    const t = ctx(db, 'CHR-HOLM');
    expect(t).toContain('WHAT THE CEO CAN DO');
    expect(t).toContain('REPORT CATALOGUE');
    expect(t).toContain('pnl — Profit & loss: where the money goes');
    expect(t).toMatch(/You can attach reports your department produces/);
    // The CFO sees her own department's figures, computed live.
    expect(t).toContain('YOUR REPORTS');
    expect(t).toContain('key "cash"');
  });

  it('lets the CEO share a report: recipients get the contents, colleagues know it circulated, outsiders do not', () => {
    const { db } = newGameDb();
    const before = fingerprint(db);
    const doc = shareDocument(db, { reports: [{ key: 'forecast' }], recipientIds: ['CHR-HOLM', 'CHR-WIERZBICKI'], memo: 'Please challenge the Eon assumptions.' });
    expect(doc.reports[0].blocks.some((b) => b.kind === 'chart')).toBe(true);
    expect(doc.title).toMatch(/^Forecast/);
    expect(doc.body).toMatch(/FY operating profit/);
    const holm = ctx(db, 'CHR-HOLM');
    expect(holm).toContain('the CEO sent you "Forecast');
    expect(holm).toContain('also sent to Dr. Tomasz Wierzbicki');
    expect(holm).toContain('Please challenge the Eon assumptions.');
    expect(ctx(db, 'CHR-GARNIER')).toMatch(/the CEO sent "Forecast[^"]*" to Margarethe Holm, Dr. Tomasz Wierzbicki \(you did not receive it/);
    expect(ctx(db, 'CHR-NOVAK')).not.toContain('the CEO sent "Forecast');
    // Economic state is untouched; only knowledge changed.
    const econ = (x: string) => [...x.split('|').slice(1, 9), x.split('|')[15]];
    expect(econ(fingerprint(db))).toEqual(econ(before));
  });

  it('sends memos and project reports, and records them in the meeting when shared there', () => {
    const { db } = newGameDb();
    const conv = startConversation(db, 'CHR-FERRER');
    shareDocument(db, { reports: [{ key: 'project', param: 'PRJ-EON' }], recipientIds: ['CHR-FERRER'], conversationId: conv.id });
    const sys = listMessages(db, conv.id).find((m) => m.role === 'system');
    expect(sys?.content).toMatch(/You shared “Project status: Eon/);
    shareDocument(db, { reports: [], recipientIds: ['CHR-FERRER', 'CHR-LINDQVIST'], memo: 'Battery supply is our first priority this quarter.' });
    expect(ctx(db, 'CHR-LINDQVIST')).toContain('Battery supply is our first priority this quarter.');
    expect(() => shareDocument(db, { reports: [], recipientIds: ['CHR-FERRER'], memo: '' })).toThrow(/Choose at least one report, or write a memo/);
    const dossier = shareDocument(db, { reports: [{ key: 'pnl' }, { key: 'unit_economics' }], recipientIds: ['CHR-HOLM', 'CHR-GARNIER'] });
    expect(dossier.title).toBe('Dossier: Profit & loss: where the money goes · Margin per car, by model');
    expect(dossier.reports).toHaveLength(2);
    expect(() => shareDocument(db, { reports: [{ key: 'project' }], recipientIds: ['CHR-HOLM'] })).toThrow(/needs a project/);
  });

  it('keeps the leadership informed of the CEO’s decisions and of meetings with colleagues', async () => {
    const { db } = newGameDb();
    const a = proposeAction(db, { type: 'hire_staff', payload: { departmentId: 'DEP-BRNO', headcount: 200, reason: 'Eon ramp-up' } });
    confirmAction(db, a.id);
    expect(ctx(db, 'CHR-OKAFOR')).toMatch(/CEO decision — Hire 200 for Brno/);
    const p = new ScriptedProvider([JSON.stringify({ dialogue: 'The battery deal is the priority.', emotion: 'calm', perspective: { stance: 'neutral', concerns: [], interests: [] }, proposed_actions: [], claims: [], memory_candidates: [], ceo_commitments: [], event_proposals: [], trust_delta: 0, trust_reason: 'routine', follow_up_questions: [], summary_update: 'CEO and CFO agreed that securing Voltaris battery volume comes before any new spending.' })]);
    const conv = startConversation(db, 'CHR-HOLM');
    await sendMessage(db, withProvider(p), conv.id, 'What comes first?');
    const t = ctx(db, 'CHR-LINDQVIST');
    expect(t).toMatch(/the CEO met Margarethe Holm \(Chief Financial Officer\)\. Gist: CEO and CFO agreed that securing Voltaris/);
    expect(ctx(db, 'CHR-SUND')).not.toContain('the CEO met Margarethe Holm');
  });

  it('turns “revamp the Vela” into a concrete project proposal, not an empty board motion (deterministic mode)', async () => {
    const { db } = newGameDb();
    const conv = startConversation(db, 'CHR-WIERZBICKI');
    const r = await sendMessage(db, { provider: new (await import('../server/llm/provider')).NoneProvider(), timeoutMs: 1000 }, conv.id, 'Let us revamp the Vela with the mild hybrid refresh.');
    const p = r.actions.find((a) => a.type === 'start_project');
    expect(p?.payload).toMatchObject({ templateKey: 'vela_hybrid_refresh' });
    expect(p?.status).toBe('pending_confirmation');
    expect(r.actions.some((a) => a.type === 'issue_board_proposal')).toBe(false);
  });
});
