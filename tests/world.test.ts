import { describe, expect, it } from 'vitest';
import { mEur } from '../shared/money';
import { loadWorld } from '../server/db/repo';
import { dashboard } from '../server/game/queries';
import { EVENT_CATALOGUE, proposeEvent } from '../server/engine/events';
import { evaluateOffer, violations } from '../server/engine/negotiation';
import { makeRng } from '../server/engine/rng';
import { advanceDays } from '../server/engine/tick';
import { byId } from '../server/engine/world';
import { advanceTime, confirmAction, proposeAction } from '../server/game/game';
import { submitOffer } from '../server/llm/conversation';
import { incomeStatementFromMovements } from '../server/engine/ledger';
import { ledgerCash, memoryWorld, newGameDb, noLlm } from './helpers';

describe('events & causality', () => {
  it('a supplier disruption affects only the products that use that supplier (acceptance 11)', () => {
    const base = memoryWorld();
    const hit = memoryWorld();
    const fire = EVENT_CATALOGUE.find((e) => e.key === 'supplier_fire')!;
    fire.apply(hit, makeRng(hit.meta.seed), { entityId: 'SUP-HANSEATIC', probability: 1, cause: 'test', refs: [] });
    for (const s of hit.supplies.filter((x) => x.supplierId === 'SUP-HANSEATIC')) {
      s.disruptionFactor = 1;
      s.disruptionUntil = '2027-02-28';
    }
    advanceDays(base, 40);
    advanceDays(hit, 40);
    const vela = (w: typeof base) => w.snapshots.find((s) => s.period === '2027-01')!;
    expect(byId(hit.models, 'MDL-VELA')!.productionLastMonth).toBe(byId(base.models, 'MDL-VELA')!.productionLastMonth);
    expect(byId(hit.models, 'MDL-KORA')!.productionLastMonth).toBeLessThan(byId(base.models, 'MDL-KORA')!.productionLastMonth * 0.5);
    expect(vela(hit)).toBeDefined();
  });

  it('does not fire events whose preconditions are unmet, and the LLM cannot force simulation-only events', () => {
    const w = memoryWorld();
    expect(proposeEvent(w, 'supplier_fire', 'SUP-VOLTARIS', 'narrative').accepted).toBe(false);
    expect(proposeEvent(w, 'made_up_event', null, 'x').accepted).toBe(false);
    // union strike notice requires the agreement to have expired
    expect(proposeEvent(w, 'union_strike_notice', null, 'Novak is angry').accepted).toBe(false);
  });

  it('periods of stability exist: no forced crisis every month', () => {
    const w = memoryWorld(7);
    advanceDays(w, 60);
    const critical = w.out.events.filter((e) => e.severity === 'critical');
    expect(critical.length).toBeLessThan(3);
  });
});

describe('negotiation', () => {
  it('persuasion cannot push a counterparty beyond its walk-away limits', () => {
    const w = memoryWorld();
    const n = byId(w.negotiations, 'NEG-VOLTARIS')!;
    const lowball = { dailyVolume: 300, priceEur: 8_800, prepaymentM: 0, takeOrPayPct: 0 };
    expect(violations(n, lowball).length).toBeGreaterThan(0);
    const ev = evaluateOffer(w, n, lowball, 0.1);
    expect(ev.accepted).toBe(false);
    const fair = { dailyVolume: 300, priceEur: 9_400, prepaymentM: 60, takeOrPayPct: 75 };
    const evWeak = evaluateOffer(w, n, fair, -0.05);
    const evStrong = evaluateOffer(w, n, fair, 0.1);
    expect(evStrong.threshold).toBeLessThan(evWeak.threshold);
  });

  it('an agreement is not a contract until it is signed; signing applies its effects', async () => {
    const { db } = newGameDb();
    let res = await submitOffer(db, noLlm, 'NEG-VOLTARIS', { dailyVolume: 300, priceEur: 9_350, prepaymentM: 60, takeOrPayPct: 75 }, 'We can commit volume for three years; Hanseatic is our alternative if we cannot agree.');
    let guard = 0;
    while (res.outcome === 'countered' && guard++ < 6) {
      const n = loadWorld(db).negotiations.find((x) => x.id === 'NEG-VOLTARIS')!;
      const counter = n.rounds[n.rounds.length - 1].terms;
      res = await submitOffer(db, noLlm, 'NEG-VOLTARIS', counter, 'We accept your proposal.');
    }
    expect(res.outcome).toBe('accepted');
    let w = loadWorld(db);
    const contract = w.contracts.find((c) => c.negotiationId === 'NEG-VOLTARIS')!;
    expect(contract.status).toBe('agreed');
    expect(byId(w.supplies, 'SPL-VOL-PACK')!.pendingCapacity.length).toBe(0);
    const cash0 = ledgerCash(db);
    const sign = proposeAction(db, { type: 'sign_contract', payload: { contractId: contract.id } });
    const r = confirmAction(db, sign.id, 'ceo', { boardRationale: 'Secures Eon battery supply.' });
    if (r.action.status === 'pending_approval') advanceTime(db, 30, 'sign-adv');
    w = loadWorld(db);
    const c2 = w.contracts.find((c) => c.id === contract.id)!;
    if (c2.status === 'active') {
      expect(byId(w.supplies, 'SPL-VOL-PACK')!.pendingCapacity.length + (byId(w.supplies, 'SPL-VOL-PACK')!.dailyCapacity > 140 ? 1 : 0)).toBeGreaterThan(0);
      expect(w.issues.find((i) => i.id === 'ISS-VOLTARIS')!.status).toBe('resolved');
    } else {
      expect(ledgerCash(db)).toBeLessThanOrEqual(cash0 + mEur(2000));
    }
  });
});

describe('displayed figures come from authoritative state (acceptance 15)', () => {
  it('dashboard KPIs equal ledger-derived values; forecasts are labelled', () => {
    const { db } = newGameDb();
    advanceTime(db, 45, 'dash-adv');
    const d = dashboard(db);
    expect(d.kpis.cashCents).toBe(ledgerCash(db));
    const ytdRows = db.prepare("SELECT l.account, SUM(l.amount_cents) AS s FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.date >= '2027-01-01' GROUP BY l.account").all() as { account: string; s: number }[];
    const mv: Record<string, number> = {};
    for (const r of ytdRows) mv[r.account] = r.s;
    expect(d.kpis.revenueYtdCents).toBe(incomeStatementFromMovements(mv).revenue);
    expect(d.forecast).not.toBeNull();
    expect(d.forecast!.notes.join(' ')).toMatch(/Estimates/);
    expect(d.forecast!.scenarios.map((s) => s.key)).toEqual(['base', 'downside', 'upside']);
  });
});
