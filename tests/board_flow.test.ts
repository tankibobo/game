import { describe, expect, it } from 'vitest';
import { loadWorld } from '../server/db/repo';
import { predictVote } from '../server/engine/board';
import { actionView, advanceTime, confirmAction, executeApproved, getAction, proposeAction, rejectAction } from '../server/game/game';
import { ACTION_BY_TYPE } from '../server/actions/registry';
import { newGameDb } from './helpers';

const inbox = (db: ReturnType<typeof newGameDb>['db']) => db.prepare('SELECT subject, body FROM inbox ORDER BY rowid').all() as { subject: string; body: string }[];

describe('board decisions lead somewhere', () => {
  it('judges proposals on their own merits: necessary and profitable ones pass, harmful ones fail', () => {
    const { db } = newGameDb();
    const w = loadWorld(db);
    const outlook = (type: string, payload: Record<string, unknown>) => {
      const def = ACTION_BY_TYPE.get(type)!;
      return predictVote(w, def.boardAnalysis!(w, payload as never), '').outlook;
    };
    expect(outlook('start_project', { templateKey: 'vela_hybrid_refresh' })).toBe('likely_approve');
    expect(outlook('hire_staff', { departmentId: 'DEP-BRNO', headcount: 900 })).toBe('likely_approve');
    expect(outlook('start_project', { templateKey: 'lyon_cost_down' })).toBe('likely_approve');
    expect(outlook('restructure_workforce', { departmentId: 'DEP-CORP', reduction: 350, mode: 'voluntary' })).toBe('likely_approve');
    expect(outlook('request_financing', { kind: 'bond', amountCents: 500e8, tenorYears: 5, rationale: 'Refinance the 2028 notes' })).toBe('likely_approve');
    expect(outlook('restructure_workforce', { departmentId: 'DEP-LYON', reduction: 1200, mode: 'compulsory' })).toBe('likely_reject');
    expect(outlook('cancel_project', { projectId: 'PRJ-EON', reason: 'Too risky' })).toBe('likely_reject');
  });

  it('starts the Vela hybrid refresh after board approval and withdraws the proposed Euro 7-only project', () => {
    const { db } = newGameDb();
    const a = proposeAction(db, { type: 'start_project', payload: { templateKey: 'vela_hybrid_refresh' } });
    expect(a.status).toBe('pending_confirmation');
    expect(a.warnings.join(' ')).toMatch(/replaces the proposed project/);
    const view = actionView(db, a);
    expect(view.needsBoard).toBe(true);
    expect(view.boardOutlook?.outlook).toBe('likely_approve');
    expect(view.nextStep).toMatch(/Submit to the board/);
    const c = confirmAction(db, a.id, 'ceo', { boardRationale: 'Euro 7 is mandatory from 29 Nov 2027 and the hybrid revives Vela demand.' });
    expect(c.action.status).toBe('pending_approval');
    advanceTime(db, 28);
    const w = loadWorld(db);
    const hybrid = w.projects.find((p) => p.templateKey === 'vela_hybrid_refresh');
    expect(hybrid?.status).toBe('active');
    expect(w.projects.find((p) => p.id === 'PRJ-VELA-E7')?.status).toBe('cancelled');
    expect(getAction(db, a.id).status).toBe('committed');
    expect(inbox(db).some((m) => m.subject.startsWith('Done: Start Vela mild-hybrid refresh'))).toBe(true);
  });

  it('carries out every decision in an approved board plan', () => {
    const { db } = newGameDb();
    const hire = proposeAction(db, { type: 'hire_staff', payload: { departmentId: 'DEP-BRNO', headcount: 900, reason: 'Eon ramp-up crew' } });
    const lyon = proposeAction(db, { type: 'start_project', payload: { templateKey: 'lyon_cost_down' } });
    const plan = proposeAction(db, { type: 'issue_board_proposal', payload: { title: 'Brno ramp-up and Lyon cost-down', kind: 'strategy', rationale: 'Crew Brno for the Eon and cut fixed cost at Lyon to protect margins.', actionIds: [hire.id, lyon.id] } });
    expect(plan.status).toBe('pending_confirmation');
    expect(plan.consequences.map((c) => c.label).join(' ')).toMatch(/2 decisions are carried out/);
    expect(actionView(db, plan).boardOutlook?.outlook).toBe('likely_approve');
    confirmAction(db, plan.id);
    expect(getAction(db, hire.id).status).toBe('pending_approval');
    expect(getAction(db, lyon.id).status).toBe('pending_approval');
    advanceTime(db, 28);
    expect(getAction(db, hire.id).status).toBe('committed');
    expect(getAction(db, lyon.id).status).toBe('committed');
    const w = loadWorld(db);
    expect(w.departments.find((d) => d.id === 'DEP-BRNO')!.hiring.reduce((x, h) => x + h.count, 0)).toBe(900);
    expect(w.projects.some((p) => p.templateKey === 'lyon_cost_down' && p.status === 'active')).toBe(true);
  });

  it('keeps an approved decision waiting with the reason, then carries it out once possible', () => {
    const { db } = newGameDb();
    const kora = proposeAction(db, { type: 'start_project', payload: { templateKey: 'kora_premium' } });
    confirmAction(db, kora.id);
    // Use most of the free engineers before the meeting.
    const e7 = proposeAction(db, { type: 'approve_project', payload: { projectId: 'PRJ-VELA-E7' } });
    expect(confirmAction(db, e7.id).ok).toBe(true);
    advanceTime(db, 28);
    const waiting = getAction(db, kora.id);
    expect(waiting.status).toBe('approved');
    expect(actionView(db, waiting).nextStep).toMatch(/not possible yet/);
    expect(inbox(db).some((m) => m.subject.startsWith('Board-approved, waiting') && /engineers/.test(m.body))).toBe(true);
    expect(executeApproved(db, kora.id).ok).toBe(false);
    // Free engineers from another project: the next time advance carries it out automatically.
    const release = proposeAction(db, { type: 'change_project_scope', payload: { projectId: 'PRJ-KORA-MY28', staffingDelta: -90, reason: 'Release engineers for the Kora GT' } });
    expect(confirmAction(db, release.id).ok).toBe(true);
    advanceTime(db, 1);
    expect(getAction(db, kora.id).status).toBe('committed');
    expect(loadWorld(db).projects.some((p) => p.templateKey === 'kora_premium' && p.status === 'active')).toBe(true);
  });

  it('lets the CEO withdraw a waiting approval', () => {
    const { db } = newGameDb();
    const kora = proposeAction(db, { type: 'start_project', payload: { templateKey: 'kora_premium' } });
    confirmAction(db, kora.id);
    confirmAction(db, proposeAction(db, { type: 'approve_project', payload: { projectId: 'PRJ-VELA-E7' } }).id);
    advanceTime(db, 28);
    expect(rejectAction(db, kora.id).status).toBe('cancelled');
  });

  it('makes an endorsement-only plan explicit and moves board confidence, not the company', () => {
    const { db } = newGameDb();
    const plan = proposeAction(db, { type: 'issue_board_proposal', payload: { title: 'Turnaround strategy 2027-2029', kind: 'strategy', rationale: 'Secure the Eon, certify the Vela, refinance in tranches, protect liquidity.' } });
    expect(plan.warnings.join(' ')).toMatch(/Endorsement only/);
    expect(actionView(db, plan).nextStep).toMatch(/nothing changes except board confidence/);
    confirmAction(db, plan.id);
    const before = loadWorld(db);
    advanceTime(db, 28);
    const w = loadWorld(db);
    const bp = w.boardProposals.find((b) => b.title === 'Turnaround strategy 2027-2029')!;
    expect(bp.status).toBe('approved');
    expect(w.projects.length).toBe(before.projects.length);
    const minutes = inbox(db).find((m) => m.subject.startsWith('Board meeting — minutes'))!;
    expect(minutes.body).toMatch(/endorsement only/);
  });

  it('rejects a plan that includes something that is not a draft', () => {
    const { db } = newGameDb();
    const hire = proposeAction(db, { type: 'hire_staff', payload: { departmentId: 'DEP-BRNO', headcount: 100 } });
    confirmAction(db, hire.id);
    const plan = proposeAction(db, { type: 'issue_board_proposal', payload: { title: 'Plan with a committed action', kind: 'strategy', rationale: 'This includes something already done, which is not allowed.', actionIds: [hire.id] } });
    expect(plan.status).toBe('invalid');
    expect(plan.errors.join(' ')).toMatch(/only drafts/);
  });

  it('warns when decisions waiting for the board compete for the same engineers', () => {
    const { db } = newGameDb();
    const vela = proposeAction(db, { type: 'start_project', payload: { templateKey: 'vela_hybrid_refresh' } });
    confirmAction(db, vela.id);
    const lyon = proposeAction(db, { type: 'start_project', payload: { templateKey: 'lyon_cost_down' } });
    expect(lyon.warnings.join(' ')).toMatch(/decisions already waiting for the board need 220 .* only 220 are free/);
  });

  it('does not alarm the board about spending it approved itself', () => {
    const { db } = newGameDb();
    const vela = proposeAction(db, { type: 'start_project', payload: { templateKey: 'vela_hybrid_refresh' } });
    confirmAction(db, vela.id, 'ceo', { boardRationale: 'Euro 7 is mandatory and the hybrid revives demand.' });
    advanceTime(db, 28);
    const alarm = db.prepare("SELECT title, description FROM events WHERE type = 'board_reaction'").all() as { title: string; description: string }[];
    expect(alarm).toEqual([]);
  });

  it('counts a bond put to the board before April as presenting the refinancing plan', () => {
    const { db } = newGameDb();
    advanceTime(db, 60);
    const bond = proposeAction(db, { type: 'request_financing', payload: { kind: 'bond', amountCents: 500e8, tenorYears: 5, rationale: 'Refinance the 2028 notes early' } });
    expect(actionView(db, bond).boardOutlook?.outlook).toBe('likely_approve');
    confirmAction(db, bond.id);
    advanceTime(db, 2);
    expect(loadWorld(db).commitments.find((c) => c.id === 'COM-001')?.status).toBe('fulfilled');
  });
});
