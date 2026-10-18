import { describe, expect, it } from 'vitest';
import { addDays, lastOfMonth } from '../shared/dates';
import { allocate, bps, fmtEur, mEur, mulDiv, parseMoney } from '../shared/money';
import { loadJournal, loadWorld } from '../server/db/repo';
import { balanceSheetFromBalances, balancesFromEntries, cashFlowFromEntries, incomeStatementFromMovements, LedgerError, movements, post } from '../server/engine/ledger';
import { advanceDay, advanceDays } from '../server/engine/tick';
import { statement } from '../server/game/queries';
import { advanceTime } from '../server/game/game';
import { memoryWorld, newGameDb } from './helpers';

describe('money', () => {
  it('rounds exactly with integer arithmetic', () => {
    expect(mulDiv(1, 1, 2)).toBe(1);
    expect(mulDiv(-1, 1, 2)).toBe(-1);
    expect(mulDiv(900_000_000_00, 425, 10_000)).toBe(3_825_000_000);
    expect(bps(mEur(800), 500)).toBe(mEur(40));
    expect(allocate(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(parseMoney('€100 million')).toBe(mEur(100));
    expect(parseMoney('1.2bn')).toBe(mEur(1200));
    expect(fmtEur(mEur(1234))).toBe('€1.23bn');
  });
  it('rejects non-integer amounts and unbalanced entries', () => {
    const w = memoryWorld();
    expect(() => post(w, { description: 'bad', sourceType: 't', lines: [{ account: '6300', amountCents: 10.5 }, { account: '2000', amountCents: -10.5 }] })).toThrow(LedgerError);
    expect(() => post(w, { description: 'bad', sourceType: 't', lines: [{ account: '6300', amountCents: 100 }, { account: '2000', amountCents: -99 }] })).toThrow(/unbalanced/);
    expect(() => post(w, { description: 'bad', sourceType: 't', lines: [{ account: '6300', amountCents: 100 }, { account: '1000', amountCents: -100 }] })).toThrow(/cash-flow/);
    expect(() => post(w, { description: 'bad', sourceType: 't', lines: [{ account: '9999', amountCents: 100 }, { account: '1000', amountCents: -100 }], cf: { category: 'operating', line: 'x' } })).toThrow(/unknown account/);
  });
});

describe('initial scenario (acceptance 1)', () => {
  it('is internally consistent', () => {
    const w = memoryWorld();
    const bs = balanceSheetFromBalances(w.balances);
    expect(bs.check).toBe(0);
    expect(bs.cash).toBe(mEur(1200));
    expect(bs.debt).toBe(mEur(2400));
    // sub-ledgers reconcile with the general ledger
    expect(w.balances['1100']).toBe(w.receivables.reduce((a, r) => a + r.amountCents, 0));
    expect(-w.balances['2000']).toBe(w.payables.filter((p) => p.liabilityAccount === '2000').reduce((a, p) => a + p.amountCents, 0));
    expect(-w.balances['2500']).toBe(w.payables.filter((p) => p.liabilityAccount === '2500').reduce((a, p) => a + p.amountCents, 0));
    expect(w.balances['1200']).toBe(w.models.reduce((a, m) => a + m.fgValueCents, 0));
    expect(-w.balances['2700']).toBe(w.debts.reduce((a, d) => a + d.principalCents, 0));
    expect(-w.balances['2600']).toBe(w.debts.reduce((a, d) => a + d.interestPayableCents, 0));
    // headcount ≈ 18,000; capacity ≈ 350k
    expect(w.departments.reduce((a, d) => a + d.headcount, 0)).toBe(18_000);
    const capacity = w.lines.filter((l) => l.status !== 'not_ready').reduce((a, l) => a + l.maxDailyRate, 0) * 230;
    expect(capacity).toBeGreaterThan(330_000);
    expect(capacity).toBeLessThan(370_000);
    expect(w.meta.currentDate).toBe('2027-01-01');
    // every character has a full profile
    for (const c of w.characters) {
      expect(c.personality.length).toBeGreaterThan(10);
      expect(c.objectives.length).toBeGreaterThan(0);
      expect(c.trustInCeo).toBeGreaterThan(0);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = memoryWorld(42);
    const b = memoryWorld(42);
    advanceDays(a, 45);
    advanceDays(b, 45);
    expect(a.balances).toEqual(b.balances);
    expect(a.models.map((m) => m.retailLastMonth)).toEqual(b.models.map((m) => m.retailLastMonth));
  });
});

describe('time progression (acceptance 3)', () => {
  it('advancing day by day equals advancing in one step (no duplicated payroll, production or payments)', () => {
    const a = memoryWorld();
    const b = memoryWorld();
    for (let i = 0; i < 75; i++) advanceDay(a);
    advanceDays(b, 75);
    expect(a.meta.currentDate).toBe(b.meta.currentDate);
    expect(a.balances).toEqual(b.balances);
    expect(a.snapshots.map((s) => s.data)).toEqual(b.snapshots.map((s) => s.data));
    expect(a.out.journal.length).toBe(b.out.journal.length);
  });

  it('posts exactly one payroll, one depreciation and one interest accrual per instrument per month', () => {
    const w = memoryWorld();
    advanceDays(w, 90); // Jan–Mar
    const months = ['2027-01', '2027-02', '2027-03'];
    for (const m of months) {
      const ofMonth = w.out.journal.filter((e) => e.date.startsWith(m));
      expect(ofMonth.filter((e) => e.sourceType === 'payroll').length).toBe(1);
      expect(ofMonth.filter((e) => e.sourceType === 'depreciation').length).toBe(1);
      expect(ofMonth.filter((e) => e.sourceType === 'interest_accrual' && e.sourceId === 'DEBT-BOND28').length).toBe(1);
      expect(ofMonth.filter((e) => e.sourceType === 'production').every((e) => e.date.startsWith(m))).toBe(true);
    }
    // production only on working days, at most once per day
    const prodDays = w.out.journal.filter((e) => e.sourceType === 'production').map((e) => e.date);
    expect(new Set(prodDays).size).toBe(prodDays.length);
  });

  it('payroll equals headcount × cost × days / 365', () => {
    const w = memoryWorld();
    advanceDays(w, 31);
    const e = w.out.journal.find((x) => x.sourceType === 'payroll' && x.date === '2027-01-31')!;
    const total = e.lines.filter((l) => l.account !== '1000').reduce((a, l) => a + l.amountCents, 0);
    const expected = w.departments.reduce((a, d) => a + mulDiv(d.headcount * 31, d.annualCostPerHeadCents, 365), 0);
    expect(Math.abs(total - expected)).toBeLessThan(10);
  });
});

describe('statements reconcile with the ledger (acceptance 4)', () => {
  it('monthly snapshots are reproducible from the journal; BS balances; CF equals cash change; sub-ledgers reconcile', () => {
    const { db } = newGameDb();
    advanceTime(db, 31 + 28 + 31, 'reconcile-key-1');
    const entries = loadJournal(db);
    for (const m of ['2027-01', '2027-02', '2027-03']) {
      const from = `${m}-01`;
      const to = lastOfMonth(from);
      const st = statement(db, from, to);
      const snap = JSON.parse((db.prepare('SELECT data FROM financial_snapshots WHERE id = ?').get(`M:${m}`) as { data: string }).data);
      expect(st.incomeStatement.revenue).toBe(snap.revenueCents);
      expect(st.incomeStatement.ebit).toBe(snap.ebitCents);
      expect(st.incomeStatement.netIncome).toBe(snap.netIncomeCents);
      expect(st.balanceSheet.check).toBe(0);
      expect(st.reconciliation.difference).toBe(0);
      expect(st.cashFlow.operating).toBe(snap.operatingCfCents);
      expect(st.balanceSheet.cash).toBe(snap.cashCents);
    }
    // retained earnings roll-forward: equity change = net income (no equity issued)
    const open = balanceSheetFromBalances(balancesFromEntries(entries, '2026-12-31'));
    const close = balanceSheetFromBalances(balancesFromEntries(entries, '2027-03-31'));
    const ni = incomeStatementFromMovements(movements(entries.filter((e) => e.sourceType !== 'opening'), '2027-01-01', '2027-03-31')).netIncome;
    expect(close.totalEquity - open.totalEquity).toBe(ni);
    const cf = cashFlowFromEntries(entries, '2027-01-01', '2027-03-31');
    expect(close.cash - open.cash).toBe(cf.netChange);
    // sub-ledgers
    const w = loadWorld(db);
    expect(w.balances['1100']).toBe(w.receivables.reduce((a, r) => a + r.amountCents, 0));
    expect(-w.balances['2000']).toBe(w.payables.filter((p) => p.liabilityAccount === '2000').reduce((a, p) => a + p.amountCents, 0));
    expect(w.balances['1200']).toBe(w.models.reduce((a, m) => a + m.fgValueCents, 0));
    expect(-w.balances['2700']).toBe(w.debts.reduce((a, d) => a + d.principalCents, 0));
    expect(-w.balances['2600']).toBe(w.debts.reduce((a, d) => a + d.interestPayableCents, 0));
    // persisted YTD accumulators match the ledger
    const ytd = movements(entries.filter((e) => e.sourceType !== 'opening'), '2027-01-01', addDays(w.meta.currentDate, -1));
    for (const [k, v] of Object.entries(w.meta.ytdByAccount)) expect(v).toBe(ytd[k] ?? 0);
  });
});
