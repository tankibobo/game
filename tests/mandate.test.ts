/**
 * Scenarios, difficulty, the three-year mandate and the Coach.
 */
import { describe, expect, it } from 'vitest';
import { mEur } from '../shared/money';
import { addDays } from '../shared/dates';
import { openDb } from '../server/db/connection';
import { loadWorld, writeWorld } from '../server/db/repo';
import { holdBoardMeeting } from '../server/engine/board';
import { DIFFICULTIES } from '../server/engine/difficulty';
import { finalReview, mandateObjectives, mandateScore } from '../server/engine/mandate';
import { liquidity } from '../server/engine/metrics';
import { advanceTime, confirmAction, createNewGame, proposeAction } from '../server/game/game';
import { statement } from '../server/game/queries';
import { coachReport } from '../server/guide/advisor';
import { buildInitialWorld } from '../server/scenario/initial';
import { SCENARIOS } from '../server/scenario/scenarios';
import { tempFile } from './helpers';

function game(scenario = 'turnaround', difficulty: 'relaxed' | 'standard' | 'hard' = 'standard', seed = 20270101) {
  const db = openDb(tempFile());
  createNewGame(db, seed, { scenario, difficulty });
  return db;
}

describe('scenarios', () => {
  it.each(SCENARIOS.map((s) => [s.key]))('%s builds a consistent company with balanced books', (key) => {
    const db = game(key);
    const w = loadWorld(db);
    expect(w.meta.scenarioKey).toBe(key);
    expect(w.meta.termEndDate).toBe('2029-12-31');
    const st = statement(db, '2027-01-01', '2027-01-01');
    expect(st.reconciliation.balanceSheetCheck).toBe(0);
    expect(w.meta.lastForecastSummary).toBeTruthy();
  });

  it('differ in the ways they promise', () => {
    const steady = loadWorld(game('steady_start'));
    expect(steady.contracts.some((c) => c.id === 'CON-VOLTARIS-A1' && c.status === 'active')).toBe(true);
    expect(steady.negotiations.some((n) => n.id === 'NEG-VOLTARIS')).toBe(false);
    const crunch = loadWorld(game('cash_crunch'));
    const base = loadWorld(game('turnaround'));
    expect(crunch.balances['1000']).toBeLessThan(base.balances['1000']);
    expect(crunch.debts.find((d) => d.id === 'DEBT-BOND28')!.maturityDate).toBe('2028-05-15');
    expect(liquidity(crunch)).toBeLessThan(liquidity(base));
    const labour = loadWorld(game('labour_crisis'));
    expect(labour.negotiations.find((n) => n.id === 'NEG-UNION')!.deadline).toBe('2027-03-15');
    expect(labour.characters.find((c) => c.id === 'CHR-NOVAK')!.trustInCeo).toBe(28);
  });

  it('rejects an unknown scenario', () => {
    const db = openDb(tempFile());
    expect(() => createNewGame(db, 1, { scenario: 'nope' })).toThrow();
  });
});

describe('difficulty and dismissal', () => {
  it('uses the difficulty’s threshold, and strikes are consecutive', () => {
    const w = buildInitialWorld(20270101, 'turnaround', 'standard');
    w.meta.currentDate = '2027-09-01'; // after the grace period
    // Values far outside 0–100 pin the post-meeting confidence to 0 or 100 whatever the target.
    w.meta.boardConfidence = -300;
    holdBoardMeeting(w);
    expect(w.meta.boardConfidence).toBe(0);
    expect(w.meta.lowConfidenceMeetings).toBe(1);
    expect(w.meta.status).toBe('active');
    w.meta.boardConfidence = 300; // a good meeting clears the strike
    holdBoardMeeting(w);
    expect(w.meta.lowConfidenceMeetings).toBe(0);
    w.meta.boardConfidence = -300;
    holdBoardMeeting(w);
    w.meta.boardConfidence = -300;
    holdBoardMeeting(w);
    expect(w.meta.status).toBe('dismissed');
  });

  it('a relaxed board needs three bad meetings and has a lower line', () => {
    const w = buildInitialWorld(20270101, 'turnaround', 'relaxed');
    w.meta.currentDate = '2027-12-01';
    for (let i = 0; i < 2; i++) {
      w.meta.boardConfidence = -300;
      holdBoardMeeting(w);
    }
    expect(w.meta.status).toBe('active');
    expect(DIFFICULTIES.relaxed.dismissalThreshold).toBeLessThan(DIFFICULTIES.standard.dismissalThreshold);
    expect(DIFFICULTIES.hard.passScore).toBeGreaterThan(DIFFICULTIES.standard.passScore);
  });
});

describe('the mandate', () => {
  it('tracks seven weighted objectives', () => {
    const w = buildInitialWorld();
    const objs = mandateObjectives(w);
    expect(objs.map((o) => o.id)).toEqual(['confidence', 'eon', 'vela', 'refinancing', 'profit', 'liquidity', 'commitments']);
    expect(objs.reduce((a, o) => a + o.weight, 0)).toBe(100);
    const score = mandateScore(objs);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(60); // the inherited situation does not pass
  });

  it('renews a CEO who delivered, and does not renew one who did not', () => {
    const good = buildInitialWorld();
    good.mode = 'live';
    good.meta.currentDate = good.meta.termEndDate;
    good.meta.boardConfidence = 75;
    good.models.find((m) => m.id === 'MDL-VELA')!.euro7Compliant = 1;
    const eon = good.projects.find((p) => p.id === 'PRJ-EON')!;
    eon.status = 'completed';
    eon.completedDate = '2027-10-15';
    good.debts.find((d) => d.id === 'DEBT-BOND28')!.status = 'repaid';
    good.meta.lastForecastSummary = { ...good.meta.lastForecastSummary!, fyEbitCents: good.meta.boardPlan.ebitTargetCents + mEur(10), minLiquidity12mCents: mEur(1000) };
    finalReview(good);
    expect(good.meta.mandate?.passed).toBe(true);
    expect(good.meta.status).toBe('active'); // the game goes on
    expect(good.out.events.some((e) => e.type === 'mandate_renewed')).toBe(true);

    const bad = buildInitialWorld();
    bad.mode = 'live';
    bad.meta.currentDate = bad.meta.termEndDate;
    bad.meta.boardConfidence = 25;
    finalReview(bad);
    expect(bad.meta.mandate?.passed).toBe(false);
    expect(bad.meta.status).toBe('not_renewed');
    expect(bad.meta.terminalReason).toMatch(/did not renew/);
  });

  it('the final review runs on the term-end date during a time advance', () => {
    const db = game();
    const w = loadWorld(db);
    w.meta.currentDate = addDays(w.meta.termEndDate, -1);
    writeWorld(db, w);
    advanceTime(db, 2);
    const after = loadWorld(db);
    expect(after.meta.mandate).toBeTruthy();
    expect(after.meta.mandate!.date).toBe('2029-12-31');
  });
});

describe('the Coach', () => {
  it.each(SCENARIOS.map((s) => [s.key]))('gives valid, previewable advice at the start of %s', (key) => {
    const db = game(key);
    const rep = coachReport(db, loadWorld(db));
    expect(rep.headline.length).toBeGreaterThan(10);
    expect(rep.advice.length).toBeGreaterThan(2);
    expect(rep.advice[0].priority).toBe(1);
    expect(rep.mandate.objectives).toHaveLength(7);
    // Every one-click action must be a valid decision the player can preview.
    for (const a of rep.advice.filter((x) => x.action)) {
      const rec = proposeAction(db, { type: a.action!.type, payload: a.action!.payload, rationale: a.action!.rationale ?? 'Coach' });
      expect(rec.errors, `${a.id}: ${rec.errors.join(' ')}`).toEqual([]);
      expect(rec.status).toBe('pending_confirmation');
    }
  });

  it('covers the inherited problems of the turnaround', () => {
    const db = game();
    const ids = coachReport(db, loadWorld(db)).advice.map((a) => a.id);
    for (const id of ['eon-supply', 'eon-thermal', 'vela-euro7', 'refinance', 'union']) expect(ids).toContain(id);
  });

  it('drops advice once it has been followed', () => {
    const db = game();
    const thermal = coachReport(db, loadWorld(db)).advice.find((a) => a.id === 'eon-thermal')!;
    const rec = proposeAction(db, { type: thermal.action!.type, payload: thermal.action!.payload });
    expect(confirmAction(db, rec.id).ok).toBe(true);
    expect(coachReport(db, loadWorld(db)).advice.some((a) => a.id === 'eon-thermal')).toBe(false);
  });
});

describe('financing flow', () => {
  it('the credit line can be extended in its last two years, not before', () => {
    const db = game();
    const early = proposeAction(db, { type: 'request_financing', payload: { kind: 'rcf_extension', amountCents: 0, rationale: 'Extend the RCF' } });
    expect(early.errors.join(' ')).toMatch(/only in the last two years/);
    const w = loadWorld(db);
    w.meta.currentDate = '2027-06-01';
    writeWorld(db, w);
    const ok = proposeAction(db, { type: 'request_financing', payload: { kind: 'rcf_extension', amountCents: 0, rationale: 'Extend the RCF' } });
    expect(ok.errors).toEqual([]);
    expect(ok.approvals.some((x) => x.approver === 'board')).toBe(false); // within the CEO's authority
    expect(confirmAction(db, ok.id).ok).toBe(true);
    const r = advanceTime(db, 30);
    expect(r.stoppedEarly).toMatch(/Time paused/); // the offer stops the clock
    const offer = loadWorld(db).financing.find((f) => f.kind === 'rcf_extension')!;
    expect(offer.status).toBe('offered');
    const acc = proposeAction(db, { type: 'accept_financing', payload: { financingId: offer.id } });
    expect(confirmAction(db, acc.id).ok).toBe(true);
    expect(loadWorld(db).debts.find((d) => d.id === 'DEBT-RCF')!.maturityDate).toBe('2032-03-31');
  });

  it('a new wage agreement can be negotiated once the current one nears its end', () => {
    const db = game();
    const w = loadWorld(db);
    const open = proposeAction(db, { type: 'open_negotiation', payload: { templateKey: 'labor_agreement' } });
    expect(open.errors.join(' ')).toMatch(/already open/);
    // Pretend a 2027 agreement was signed and is about to expire.
    w.negotiations.find((n) => n.id === 'NEG-UNION')!.status = 'failed';
    w.contracts.push({ ...w.contracts.find((c) => c.kind === 'labor')!, id: 'CON-LABOR-T', status: 'active', signedDate: '2027-02-01', startDate: '2027-02-01', endDate: '2029-12-31' });
    w.meta.currentDate = '2029-03-01';
    writeWorld(db, w);
    expect(proposeAction(db, { type: 'open_negotiation', payload: { templateKey: 'labor_agreement' } }).errors.join(' ')).toMatch(/runs until 2029-12-31/);
    const w2 = loadWorld(db);
    w2.meta.currentDate = '2029-08-01';
    writeWorld(db, w2);
    const again = proposeAction(db, { type: 'open_negotiation', payload: { templateKey: 'labor_agreement' } });
    expect(again.errors).toEqual([]);
    expect(confirmAction(db, again.id).ok).toBe(true);
    expect(loadWorld(db).negotiations.find((n) => n.templateKey === 'labor_agreement' && n.status === 'open')!.title).toBe('Collective wage agreement 2029–2031');
  });
});

describe('following the Coach', () => {
  it('keeps a new CEO safe through the first eight months', async () => {
    const { playMandate } = await import('../scripts/dev/coach-bot');
    const r = await playMandate('turnaround', 'standard', 20270101, { months: 8, quiet: true });
    expect(r.status).toBe('active');
    expect(r.minConfidence).toBeGreaterThan(35);
    expect(r.score).toBeGreaterThan(60);
  }, 240_000);
});
