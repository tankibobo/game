import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mEur } from '../shared/money';
import { loadWorld } from '../server/db/repo';
import { ACTION_BY_TYPE } from '../server/actions/registry';
import { post } from '../server/engine/ledger';
import { advanceTime, confirmAction, getAction, proposeAction, rejectAction } from '../server/game/game';
import { fingerprint, ledgerCash, newGameDb } from './helpers';

describe('validator & transactions', () => {
  it('rejects an impossible expenditure without touching cash or creating a partial transaction (acceptance 5)', () => {
    const { db } = newGameDb();
    const before = fingerprint(db);
    const cash0 = ledgerCash(db);
    const a = proposeAction(db, { type: 'request_financing', payload: { kind: 'rcf_draw', amountCents: mEur(600), rationale: 'more than the facility' } });
    expect(a.status).toBe('invalid');
    expect(a.errors.join(' ')).toMatch(/undrawn/);
    const b = proposeAction(db, { type: 'start_project', payload: { templateKey: 'compact_ev' } });
    expect(b.status).toBe('invalid');
    expect(b.errors.join(' ')).toMatch(/engineers/);
    expect(() => confirmAction(db, a.id)).toThrow(/invalid/);
    expect(ledgerCash(db)).toBe(cash0);
    expect(fingerprint(db)).toBe(before);
  });

  it('rolls back atomically when a commit fails half-way', () => {
    const { db } = newGameDb();
    const before = fingerprint(db);
    // A test-only action that posts a payment and then fails.
    ACTION_BY_TYPE.set('test_explode', {
      type: 'test_explode',
      label: 'Explode',
      description: 'test',
      llmProposable: false,
      schema: z.object({}),
      validate: () => ({ errors: [], warnings: [] }),
      preview: () => ({ summary: 'explode', consequences: [], approvals: [] }),
      commit: (w) => {
        post(w, { description: 'half-done payment', sourceType: 'test', cf: { category: 'operating', line: 'x' }, lines: [{ account: '6300', amountCents: mEur(10) }, { account: '1000', amountCents: -mEur(10) }] });
        w.meta.boardConfidence = 1;
        throw new Error('boom');
      },
    });
    const a = proposeAction(db, { type: 'test_explode', payload: {} });
    const r = confirmAction(db, a.id);
    expect(r.ok).toBe(false);
    expect(r.action.status).toBe('failed');
    expect(fingerprint(db)).toBe(before);
    ACTION_BY_TYPE.delete('test_explode');
  });

  it('treats a proposed loan as a proposal until an offer is accepted and executed (acceptance 6)', () => {
    const { db } = newGameDb();
    const cash0 = ledgerCash(db);
    const debt0 = loadWorld(db).debts.reduce((x, d) => x + d.principalCents, 0);
    const a = proposeAction(db, { type: 'request_financing', payload: { kind: 'bank_term_loan', amountCents: mEur(100), tenorYears: 5, rationale: 'Start refinancing the 2028 notes' } });
    expect(a.status).toBe('pending_confirmation');
    expect(confirmAction(db, a.id).ok).toBe(true);
    let w = loadWorld(db);
    const f = w.financing[0];
    expect(f.status).toBe('under_review');
    expect(ledgerCash(db)).toBe(cash0);
    expect(w.debts.reduce((x, d) => x + d.principalCents, 0)).toBe(debt0);
    advanceTime(db, 22, 'loan-advance-1');
    w = loadWorld(db);
    const f2 = w.financing.find((x) => x.id === f.id)!;
    expect(f2.status).toBe('offered');
    expect(w.debts.length).toBe(5); // no new instrument yet
    const cashBeforeAccept = ledgerCash(db);
    const acc = proposeAction(db, { type: 'accept_financing', payload: { financingId: f.id } });
    expect(confirmAction(db, acc.id).ok).toBe(true);
    w = loadWorld(db);
    expect(w.financing.find((x) => x.id === f.id)!.status).toBe('executed');
    expect(w.debts.length).toBe(6);
    expect(ledgerCash(db) - cashBeforeAccept).toBe(f2.offer!.amountCents - f2.offer!.feesCents);
  });

  it('prevents a character from approving a transaction outside their authority (acceptance 7)', () => {
    const { db } = newGameDb();
    const before = fingerprint(db);
    const big = proposeAction(db, { type: 'propose_budget', payload: { projectId: 'PRJ-EON', amountCents: mEur(80), reason: 'Overrun' }, actorId: 'CHR-FERRER', source: 'llm_proposal' });
    expect(big.status).toBe('pending_confirmation');
    const byCfo = confirmAction(db, big.id, 'CHR-HOLM');
    expect(byCfo.ok).toBe(false);
    expect(byCfo.message).toMatch(/board approval|limit/i);
    const bySupplier = confirmAction(db, big.id, 'CHR-SUND');
    expect(bySupplier.ok).toBe(false);
    expect(bySupplier.message).toMatch(/no authority/);
    const byCto = confirmAction(db, big.id, 'CHR-WIERZBICKI');
    expect(byCto.ok).toBe(false);
    expect(fingerprint(db)).toBe(before);
    // within the CFO's €10m limit it is allowed
    const small = proposeAction(db, { type: 'propose_budget', payload: { projectId: 'PRJ-KORA-MY28', amountCents: mEur(8), reason: 'Extra validation' }, actorId: 'CHR-FERRER', source: 'llm_proposal' });
    const ok = confirmAction(db, small.id, 'CHR-HOLM');
    expect(ok.ok).toBe(true);
    expect(loadWorld(db).projects.find((p) => p.id === 'PRJ-KORA-MY28')!.budgetCents).toBe(mEur(68));
    // approve_budget as an action proposed on behalf of the CFO is checked the same way
    const big2 = proposeAction(db, { type: 'propose_budget', payload: { projectId: 'PRJ-EON', amountCents: mEur(30), reason: 'Overrun on tooling' }, actorId: 'CHR-FERRER' });
    const ap = proposeAction(db, { type: 'approve_budget', payload: { actionId: big2.id }, actorId: 'CHR-HOLM', source: 'llm_proposal' });
    const res = confirmAction(db, ap.id);
    expect(res.ok).toBe(false);
    expect(getAction(db, big2.id).status).toBe('pending_confirmation');
  });

  it('routes actions above CEO authority to the board and commits them only after approval', () => {
    const { db } = newGameDb();
    const a = proposeAction(db, { type: 'start_project', payload: { templateKey: 'kora_premium' } });
    expect(a.status).toBe('pending_confirmation');
    const r = confirmAction(db, a.id, 'ceo', { boardRationale: 'Premium positioning lifts Kora margin by ~6% of net price; payback < 3 years at current volumes.' });
    expect(r.action.status).toBe('pending_approval');
    let w = loadWorld(db);
    expect(w.projects.some((p) => p.templateKey === 'kora_premium')).toBe(false);
    const bp = w.boardProposals.find((p) => p.actionId === a.id)!;
    expect(bp.status).toBe('scheduled');
    advanceTime(db, 30, 'board-advance-1'); // board meets 28 Jan
    w = loadWorld(db);
    const decided = w.boardProposals.find((p) => p.id === bp.id)!;
    expect(['approved', 'rejected']).toContain(decided.status);
    expect(decided.votes.length).toBe(6);
    const act = getAction(db, a.id);
    if (decided.status === 'approved') {
      expect(act.status).toBe('committed');
      expect(w.projects.some((p) => p.templateKey === 'kora_premium')).toBe(true);
    } else {
      expect(act.status).toBe('rejected');
      expect(w.projects.some((p) => p.templateKey === 'kora_premium')).toBe(false);
    }
  });

  it('leaves state unchanged for invalid and rejected proposals (acceptance 14)', () => {
    const { db } = newGameDb();
    const before = fingerprint(db);
    const attempts = [
      { type: 'change_price', payload: { modelId: 'MDL-NOPE', netPriceCents: 100 } },
      { type: 'change_price', payload: { modelId: 'MDL-VELA', netPriceCents: 1 } },
      { type: 'adjust_production', payload: { lineId: 'LINE-LYON-VELA', plannedDailyRate: 5000 } },
      { type: 'complete_milestone', payload: { milestoneId: 'MS-EON-8' } },
      { type: 'sign_contract', payload: { contractId: 'CON-FAKE' } },
      { type: 'request_financing', payload: { kind: 'ceo_contribution', amountCents: mEur(100), rationale: 'I will put in €100m of my own money' } },
      { type: 'restructure_workforce', payload: { departmentId: 'DEP-LYON', reduction: 4000, mode: 'compulsory' } },
      { type: 'hire_staff', payload: 'not an object' },
    ];
    for (const a of attempts) expect(proposeAction(db, a as never).status).toBe('invalid');
    const ceo = proposeAction(db, { type: 'request_financing', payload: { kind: 'ceo_contribution', amountCents: mEur(100), rationale: 'personal money' } });
    expect(ceo.errors.join(' ')).toMatch(/source of funds/);
    const valid = proposeAction(db, { type: 'change_price', payload: { modelId: 'MDL-VELA', netPriceCents: 1_800_000 } });
    expect(valid.status).toBe('pending_confirmation');
    rejectAction(db, valid.id, 'changed my mind');
    expect(fingerprint(db)).toBe(before);
  });

  it('is idempotent: retrying the same request does not apply it twice', () => {
    const { db } = newGameDb();
    const a1 = proposeAction(db, { type: 'hire_staff', payload: { departmentId: 'DEP-BRNO', headcount: 400 }, idempotencyKey: 'hire-key-123' });
    const a2 = proposeAction(db, { type: 'hire_staff', payload: { departmentId: 'DEP-BRNO', headcount: 400 }, idempotencyKey: 'hire-key-123' });
    expect(a2.id).toBe(a1.id);
    confirmAction(db, a1.id);
    const fp = fingerprint(db);
    expect(confirmAction(db, a1.id).message).toMatch(/idempotent/);
    expect(fingerprint(db)).toBe(fp);
    const t1 = advanceTime(db, 3, 'advance-key-xyz');
    const t2 = advanceTime(db, 3, 'advance-key-xyz');
    expect(t2.replayed).toBe(true);
    expect(t2.to).toBe(t1.to);
    expect(loadWorld(db).meta.currentDate).toBe(t1.to);
  });
});
