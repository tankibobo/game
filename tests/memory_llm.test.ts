import { describe, expect, it } from 'vitest';
import { loadWorld } from '../server/db/repo';
import { advanceTime, confirmAction, proposeAction } from '../server/game/game';
import { buildContext } from '../server/llm/context';
import { sendMessage, startConversation } from '../server/llm/conversation';
import { LlmError, ScriptedProvider } from '../server/llm/provider';
import { fingerprint, newGameDb, noLlm, withProvider } from './helpers';

function turn(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    dialogue: 'Understood.',
    emotion: 'calm',
    perspective: { stance: 'neutral', concerns: [], interests: [] },
    proposed_actions: [],
    claims: [],
    memory_candidates: [],
    ceo_commitments: [],
    event_proposals: [],
    trust_delta: 0,
    trust_reason: 'routine',
    follow_up_questions: [],
    summary_update: 'Short meeting.',
    ...over,
  });
}

describe('memory & context retrieval', () => {
  it('retrieves an ongoing project and its unresolved issues in a later conversation (acceptance 9)', async () => {
    const { db } = newGameDb();
    // Something happens to the project first, then time passes.
    const a = proposeAction(db, { type: 'change_project_scope', payload: { projectId: 'PRJ-EON', staffingDelta: 60, reason: 'Strengthen battery validation team' } });
    confirmAction(db, a.id);
    advanceTime(db, 40, 'mem-adv-1');
    const w = loadWorld(db);
    const ctx = buildContext(db, w, { characterId: 'CHR-WIERZBICKI', conversationId: null, playerMessage: 'Where are we on the crossover?' });
    expect(ctx.text).toContain('PRJ-EON');
    expect(ctx.text).toContain('MS-EON-3');
    expect(ctx.text).toContain('ISS-THERMAL');
    expect(ctx.text).toContain('Strengthen battery validation team');
    expect(ctx.tokens).toBeLessThanOrEqual(7000);
    // the provider actually receives that context
    const p = new ScriptedProvider([turn({ dialogue: 'Validation is still the critical path.' })]);
    const conv = startConversation(db, 'CHR-WIERZBICKI');
    const r = await sendMessage(db, withProvider(p), conv.id, 'Where are we on the crossover?');
    expect(r.mode).toBe('llm');
    const sent = p.calls[0].messages[0].content;
    expect(sent).toContain('ISS-THERMAL');
    expect(sent).toContain('[EST] Forecast completion');
  });

  it('keeps external parties away from confidential internals', () => {
    const { db } = newGameDb();
    const w = loadWorld(db);
    const ctx = buildContext(db, w, { characterId: 'CHR-NOVAK', conversationId: null, playerMessage: 'What do you think about our cash position and the Eon?' });
    expect(ctx.text).not.toContain('Latest forecast');
    expect(ctx.text).not.toContain('MS-EON-3');
    expect(ctx.text).toContain('NEG-UNION');
    // private facts are only included above the trust threshold
    expect(ctx.text).not.toContain('3.8%');
  });

  it('remembers a promise made in a meeting and surfaces it as the deadline approaches (acceptance 10)', async () => {
    const { db } = newGameDb();
    const conv = startConversation(db, 'CHR-OKAFOR');
    const r = await sendMessage(db, noLlm, conv.id, 'I promise you a final decision on the Brno hiring plan by 2027-02-20.');
    expect(r.mode).toBe('fallback');
    let w = loadWorld(db);
    const c = w.commitments.find((x) => x.promiseeId === 'CHR-OKAFOR');
    expect(c).toBeDefined();
    expect(c!.dueDate).toBe('2027-02-20');
    advanceTime(db, 40, 'promise-adv-1'); // to 10 Feb: within 14 days of the deadline
    w = loadWorld(db);
    const inbox = db.prepare("SELECT subject FROM inbox WHERE subject LIKE 'Due in%'").all() as { subject: string }[];
    expect(inbox.some((x) => /Brno hiring/.test(x.subject))).toBe(true);
    const ctx = buildContext(db, w, { characterId: 'CHR-OKAFOR', conversationId: conv.id, playerMessage: 'Let us talk about recruitment.' });
    expect(ctx.text).toContain(c!.id);
    const mem = db.prepare("SELECT summary FROM character_memories WHERE character_id = 'CHR-OKAFOR'").all() as { summary: string }[];
    expect(mem.some((m) => /promised/i.test(m.summary))).toBe(true);
  });
});

describe('LLM output is untrusted (acceptance 12, 13)', () => {
  it('cannot invent a completed milestone, a signed contract or a financial transaction', async () => {
    const { db } = newGameDb();
    const before = loadWorld(db);
    const p = new ScriptedProvider([
      turn({
        dialogue: 'Good news: the Voltaris amendment has been signed and €80m was transferred this morning. Battery validation has been completed.',
        proposed_actions: [
          { type: 'complete_milestone', params_json: JSON.stringify({ milestoneId: 'MS-EON-3' }), rationale: 'done' },
          { type: 'sign_contract', params_json: JSON.stringify({ contractId: 'CON-FAKE-1' }), rationale: 'sign it' },
          { type: 'request_financing', params_json: '{not json', rationale: 'money' },
        ],
        claims: [{ statement: 'The Voltaris contract has been signed', basis: 'fact', entity_ids: ['CON-FAKE-1'] }],
        trust_delta: 3,
      }),
    ]);
    const conv = startConversation(db, 'CHR-LINDQVIST');
    const fpBefore = db.prepare('SELECT COUNT(*) AS n FROM journal_lines').get();
    const r = await sendMessage(db, withProvider(p), conv.id, 'Any news from Voltaris?');
    const after = loadWorld(db);
    expect(after.milestones.find((m) => m.id === 'MS-EON-3')!.status).toBe(before.milestones.find((m) => m.id === 'MS-EON-3')!.status);
    expect(after.contracts.filter((c) => c.status === 'active').length).toBe(before.contracts.filter((c) => c.status === 'active').length);
    expect(db.prepare('SELECT COUNT(*) AS n FROM journal_lines').get()).toEqual(fpBefore);
    expect(after.balances['1000']).toBe(before.balances['1000']);
    expect(r.actions.every((a) => a.status === 'invalid')).toBe(true);
    const s = r.reply.structured as { factWarnings: string[]; claims: { verified: string }[]; rejectedProposals: unknown[]; trustDelta: number };
    expect(s.factWarnings.length).toBeGreaterThan(0);
    expect(s.claims[0].verified).not.toBe('consistent');
    expect(s.rejectedProposals.length).toBe(1);
    expect(s.trustDelta).toBe(2); // clamped
  });

  it('recovers from a timeout and from malformed output without corrupting state', async () => {
    const { db } = newGameDb();
    const fp = fingerprint(db);
    const p = new ScriptedProvider([new LlmError('timed out', 'timeout'), '{"dialogue": 42', JSON.stringify({ dialogue: 'missing fields' })]);
    const conv = startConversation(db, 'CHR-HOLM');
    for (let i = 0; i < 3; i++) {
      const r = await sendMessage(db, withProvider(p), conv.id, 'How is our liquidity?');
      expect(r.mode).toBe('fallback');
      expect(r.fallbackReason).toBeTruthy();
      expect(r.reply.content.length).toBeGreaterThan(10);
    }
    // Only conversational records changed (messages, memories, trust); no economic state.
    const w = loadWorld(db);
    expect(w.balances['1000']).toBe(loadWorld(db).balances['1000']);
    // economic tables (models … commitments, debt, contracts) and the journal are unchanged
    const econ = (x: string) => [...x.split('|').slice(1, 9), x.split('|')[15]];
    expect(econ(fingerprint(db))).toEqual(econ(fp));
    const calls = db.prepare('SELECT status FROM llm_calls').all() as { status: string }[];
    expect(calls.map((c) => c.status)).toEqual(['timeout', 'invalid_output', 'invalid_output']);
  });

  it('turns an LLM-proposed action into a validated proposal that the CEO must confirm', async () => {
    const { db } = newGameDb();
    const p = new ScriptedProvider([turn({ dialogue: 'I recommend cutting Lyon to 520 a day.', proposed_actions: [{ type: 'adjust_production', params_json: JSON.stringify({ lineId: 'LINE-LYON-VELA', plannedDailyRate: 520, reason: 'Align with retail' }), rationale: 'Stop building stock' }] })]);
    const conv = startConversation(db, 'CHR-MARCHETTI');
    const r = await sendMessage(db, withProvider(p), conv.id, 'What should we do about Vela stock?');
    expect(r.actions[0].status).toBe('pending_confirmation');
    expect(r.actions[0].source).toBe('llm_proposal');
    expect(loadWorld(db).lines.find((l) => l.id === 'LINE-LYON-VELA')!.plannedDailyRate).toBe(575);
    expect(confirmAction(db, r.actions[0].id).ok).toBe(true);
    expect(loadWorld(db).lines.find((l) => l.id === 'LINE-LYON-VELA')!.plannedDailyRate).toBe(520);
  });
});
