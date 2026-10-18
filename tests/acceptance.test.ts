/**
 * Deterministic acceptance scenario: the player delays the electric
 * crossover; the delay changes the forecast; the board reacts; and the
 * project remains consistent after restarting the application.
 */
import { describe, expect, it } from 'vitest';
import { openDb } from '../server/db/connection';
import { loadWorld } from '../server/db/repo';
import { advanceTime, confirmAction, proposeAction } from '../server/game/game';
import { latestForecast } from '../server/game/queries';
import { newGameDb } from './helpers';

describe('acceptance scenario: delaying the Eon', () => {
  it('delay → forecast changes → board reacts → consistent after restart', () => {
    const { db, file } = newGameDb(20270101);
    // A sensible first month so the baseline is meaningful.
    for (const [type, payload] of [
      ['approve_project', { projectId: 'PRJ-VELA-E7' }],
      ['adjust_production', { lineId: 'LINE-LYON-VELA', plannedDailyRate: 520, reason: 'Align with retail demand' }],
    ] as const) {
      const a = proposeAction(db, { type, payload });
      expect(confirmAction(db, a.id).ok).toBe(true);
    }
    advanceTime(db, 14, 'acc-adv-1');
    const w0 = loadWorld(db);
    const fc0 = w0.meta.lastForecastSummary!;
    const conf0 = w0.meta.boardConfidence;
    const eon0 = w0.projects.find((p) => p.id === 'PRJ-EON')!;
    expect(eon0.targetDate).toBe('2027-10-01');

    // The player delays the Eon by four months and re-plans the programme.
    const a = proposeAction(db, { type: 'change_project_scope', payload: { projectId: 'PRJ-EON', newTargetDate: '2028-02-01', reason: 'Re-phase the Eon to protect liquidity until battery supply is secured.' } });
    expect(a.status).toBe('pending_confirmation');
    expect(a.consequences.some((c) => /board/.test(c.label))).toBe(true);
    const r = confirmAction(db, a.id);
    expect(r.ok).toBe(true);

    const w1 = loadWorld(db);
    const eon1 = w1.projects.find((p) => p.id === 'PRJ-EON')!;
    // Current deadline changed, original preserved, history appended (acceptance 8)
    expect(eon1.targetDate).toBe('2028-02-01');
    expect(eon1.originalTargetDate).toBe('2027-03-01');
    const hist = db.prepare("SELECT * FROM project_history WHERE project_id = 'PRJ-EON' AND field = 'targetDate'").all() as { old_value: string; new_value: string }[];
    expect(hist).toEqual([expect.objectContaining({ old_value: '2027-10-01', new_value: '2028-02-01' })]);
    expect(eon1.staffingFte).toBeLessThan(eon0.staffingFte); // the slower plan releases engineers

    // The forecast changed …
    const fc1 = w1.meta.lastForecastSummary!;
    expect(fc1.createdDate).toBe(w1.meta.currentDate);
    const sop0 = fc0.eonSopForecast ?? fc0.eonSopConditional!;
    const sop1 = fc1.eonSopForecast ?? fc1.eonSopConditional!;
    expect(sop1 > sop0).toBe(true);
    expect(latestForecast(db)!.trigger).toBe('action:change_project_scope');

    // … and the board reacted.
    const reaction = db.prepare("SELECT * FROM events WHERE type = 'board_reaction'").all();
    expect(reaction.length).toBe(1);
    expect(w1.meta.boardConfidence).toBeLessThan(conf0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE from_id = 'CHR-DUBREUIL' AND subject = 'The latest forecast'").get() as { n: number }).n).toBe(1);
    const planCommitment = w1.commitments.find((c) => c.check.type === 'deliver_plan' && c.check.topic === 'recovery');
    expect(planCommitment?.status).toBe('open');

    // Restart: the project and its history are intact and time continues.
    db.close();
    const db2 = openDb(file);
    const w2 = loadWorld(db2);
    const eon2 = w2.projects.find((p) => p.id === 'PRJ-EON')!;
    expect(eon2).toEqual(eon1);
    expect(w2.milestones.filter((m) => m.projectId === 'PRJ-EON')).toEqual(w1.milestones.filter((m) => m.projectId === 'PRJ-EON'));
    expect((db2.prepare("SELECT COUNT(*) AS n FROM project_history WHERE project_id = 'PRJ-EON'").get() as { n: number }).n).toBeGreaterThan(1);
    advanceTime(db2, 20, 'acc-adv-2');
    const w3 = loadWorld(db2);
    const eon3 = w3.projects.find((p) => p.id === 'PRJ-EON')!;
    expect(eon3.targetDate).toBe('2028-02-01');
    expect(eon3.originalTargetDate).toBe('2027-03-01');
    // The board meeting on 28 January took place and recorded the CEO's standing.
    expect((db2.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'board_meeting'").get() as { n: number }).n).toBe(1);
  });
});
