/**
 * Double-entry general ledger. Every financial consequence in the game is a
 * balanced journal entry; statements are derived from the journal only.
 */
import type { CashFlowCategory, JournalEntry, JournalLine, SnapshotData } from '../../shared/domain';
import type { Cents } from '../../shared/money';
import { monthKey, year, type SimDate } from '../../shared/dates';
import { ACCOUNT_BY_CODE, ACCOUNT_CODES, CASH, isPnl } from './accounts';
import { nextId, type World } from './world';

export interface PostInput {
  date?: SimDate;
  description: string;
  sourceType: string;
  sourceId?: string | null;
  cf?: { category: CashFlowCategory; line: string } | null;
  lines: JournalLine[];
}

export class LedgerError extends Error {}

export function validateLines(lines: JournalLine[], hasCf: boolean): void {
  if (lines.length < 2) throw new LedgerError('journal entry needs at least two lines');
  let total = 0;
  let touchesCash = false;
  for (const l of lines) {
    if (!ACCOUNT_CODES.has(l.account)) throw new LedgerError(`unknown account ${l.account}`);
    if (!Number.isSafeInteger(l.amountCents)) throw new LedgerError(`non-integer amount on ${l.account}: ${l.amountCents}`);
    total += l.amountCents;
    if (l.account === CASH && l.amountCents !== 0) touchesCash = true;
  }
  if (total !== 0) throw new LedgerError(`unbalanced journal entry (difference ${total} cents)`);
  if (touchesCash && !hasCf) throw new LedgerError('entries touching cash must carry a cash-flow classification');
}

/** Post a balanced entry: updates in-memory balances and period accumulators. */
export function post(w: World, input: PostInput): JournalEntry | null {
  const lines = input.lines.filter((l) => l.amountCents !== 0);
  if (lines.length === 0) return null;
  validateLines(lines, !!input.cf);
  const entry: JournalEntry = {
    id: nextId(w, 'JE'),
    date: input.date ?? w.meta.currentDate,
    description: input.description,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    cfCategory: input.cf?.category ?? null,
    cfLine: input.cf?.line ?? null,
    lines,
  };
  if (input.cf && input.cf.category !== 'opening' && monthKey(entry.date) === monthKey(w.meta.currentDate)) {
    const c = lines.filter((l) => l.account === CASH).reduce((a, l) => a + l.amountCents, 0);
    w.meta.cfMtd[input.cf.category] = (w.meta.cfMtd[input.cf.category] ?? 0) + c;
  }
  for (const l of lines) {
    w.balances[l.account] = (w.balances[l.account] ?? 0) + l.amountCents;
    if (isPnl(l.account) && entry.date.slice(0, 4) === w.meta.currentDate.slice(0, 4)) {
      w.meta.ytdByAccount[l.account] = (w.meta.ytdByAccount[l.account] ?? 0) + l.amountCents;
      if (monthKey(entry.date) === monthKey(w.meta.currentDate)) {
        w.meta.mtdByAccount[l.account] = (w.meta.mtdByAccount[l.account] ?? 0) + l.amountCents;
      }
    }
  }
  w.out.journal.push(entry);
  return entry;
}

export function bal(w: World, account: string): Cents {
  return w.balances[account] ?? 0;
}

export function cash(w: World): Cents {
  return bal(w, CASH);
}

// ---------------------------------------------------------------- statements (pure, from entries)

export interface IncomeStatement {
  vehicleRevenue: Cents;
  aftersalesRevenue: Cents;
  otherIncome: Cents;
  revenue: Cents;
  cogs: Cents;
  grossProfit: Cents;
  personnel: Cents;
  otherOpex: Cents;
  ebitda: Cents;
  da: Cents;
  ebit: Cents;
  interest: Cents;
  ebt: Cents;
  tax: Cents;
  netIncome: Cents;
  byAccount: Record<string, Cents>;
}

/** Build an income statement from P&L account movements (debit-positive). */
export function incomeStatementFromMovements(mv: Record<string, Cents>): IncomeStatement {
  const lineSum = (line: string) => {
    let s = 0;
    for (const [code, amt] of Object.entries(mv)) if (ACCOUNT_BY_CODE.get(code)?.statementLine === line) s += amt;
    return s;
  };
  const vehicleRevenue = -(mv['4000'] ?? 0);
  const aftersalesRevenue = -(mv['4100'] ?? 0);
  const otherIncome = -(mv['4900'] ?? 0);
  const revenue = vehicleRevenue + aftersalesRevenue;
  const cogs = lineSum('cogs');
  const grossProfit = revenue - cogs;
  const personnel = lineSum('personnel');
  const otherOpex = lineSum('other_opex');
  const ebitda = grossProfit + otherIncome - personnel - otherOpex;
  const da = lineSum('da');
  const ebit = ebitda - da;
  const interest = lineSum('interest');
  const ebt = ebit - interest;
  const tax = lineSum('tax');
  const netIncome = ebt - tax;
  const byAccount: Record<string, Cents> = {};
  for (const [k, v] of Object.entries(mv)) if (isPnl(k)) byAccount[k] = v;
  return { vehicleRevenue, aftersalesRevenue, otherIncome, revenue, cogs, grossProfit, personnel, otherOpex, ebitda, da, ebit, interest, ebt, tax, netIncome, byAccount };
}

export function movements(entries: JournalEntry[], from: SimDate, to: SimDate, pnlOnly = true): Record<string, Cents> {
  const mv: Record<string, Cents> = {};
  for (const e of entries) {
    if (e.date < from || e.date > to) continue;
    for (const l of e.lines) {
      if (pnlOnly && !isPnl(l.account)) continue;
      mv[l.account] = (mv[l.account] ?? 0) + l.amountCents;
    }
  }
  return mv;
}

export interface CashFlowStatement {
  operating: Cents;
  investing: Cents;
  financing: Cents;
  netChange: Cents;
  lines: Record<string, Cents>; // "operating:customer_receipts" -> amount
}

export function cashFlowFromEntries(entries: JournalEntry[], from: SimDate, to: SimDate): CashFlowStatement {
  const res: CashFlowStatement = { operating: 0, investing: 0, financing: 0, netChange: 0, lines: {} };
  for (const e of entries) {
    if (e.date < from || e.date > to) continue;
    if (!e.cfCategory || e.cfCategory === 'opening') continue;
    let c = 0;
    for (const l of e.lines) if (l.account === CASH) c += l.amountCents;
    if (c === 0) continue;
    res[e.cfCategory] += c;
    const key = `${e.cfCategory}:${e.cfLine ?? 'other'}`;
    res.lines[key] = (res.lines[key] ?? 0) + c;
    res.netChange += c;
  }
  return res;
}

export interface BalanceSheet {
  cash: Cents;
  receivables: Cents;
  inventory: Cents;
  otherCurrentAssets: Cents;
  ppe: Cents;
  intangibles: Cents;
  totalAssets: Cents;
  payables: Cents;
  provisions: Cents;
  taxPayable: Cents;
  accruedInterest: Cents;
  debt: Cents;
  leases: Cents;
  totalLiabilities: Cents;
  shareCapital: Cents;
  retainedEarnings: Cents; // opening RE + cumulative P&L
  totalEquity: Cents;
  check: Cents; // assets - liabilities - equity (must be 0)
}

export function balanceSheetFromBalances(b: Record<string, Cents>): BalanceSheet {
  const g = (c: string) => b[c] ?? 0;
  const cashV = g('1000');
  const receivables = g('1100');
  const otherCurrentAssets = g('1150');
  const inventory = g('1200');
  const ppe = g('1500') + g('1510');
  const intangibles = g('1600') + g('1610');
  const totalAssets = cashV + receivables + otherCurrentAssets + inventory + ppe + intangibles;
  const payables = -g('2000');
  const provisions = -(g('2200') + g('2300') + g('2400') + g('2450'));
  const taxPayable = -g('2500');
  const accruedInterest = -g('2600');
  const debt = -g('2700');
  const leases = -g('2800');
  const totalLiabilities = payables + provisions + taxPayable + accruedInterest + debt + leases;
  const shareCapital = -g('3000');
  let pnl = 0;
  for (const [code, amt] of Object.entries(b)) if (isPnl(code)) pnl += amt;
  const retainedEarnings = -g('3100') - pnl;
  const totalEquity = shareCapital + retainedEarnings;
  return {
    cash: cashV,
    receivables,
    inventory,
    otherCurrentAssets,
    ppe,
    intangibles,
    totalAssets,
    payables,
    provisions,
    taxPayable,
    accruedInterest,
    debt,
    leases,
    totalLiabilities,
    shareCapital,
    retainedEarnings,
    totalEquity,
    check: totalAssets - totalLiabilities - totalEquity,
  };
}

export function balancesFromEntries(entries: JournalEntry[], to?: SimDate): Record<string, Cents> {
  const b: Record<string, Cents> = {};
  for (const e of entries) {
    if (to && e.date > to) continue;
    for (const l of e.lines) b[l.account] = (b[l.account] ?? 0) + l.amountCents;
  }
  return b;
}

export function emptySnapshotData(): SnapshotData {
  return {
    revenueCents: 0,
    vehicleRevenueCents: 0,
    aftersalesRevenueCents: 0,
    cogsCents: 0,
    grossProfitCents: 0,
    personnelCents: 0,
    otherOpexCents: 0,
    ebitdaCents: 0,
    daCents: 0,
    ebitCents: 0,
    interestCents: 0,
    taxCents: 0,
    netIncomeCents: 0,
    cashCents: 0,
    debtCents: 0,
    liquidityCents: 0,
    operatingCfCents: 0,
    investingCfCents: 0,
    financingCfCents: 0,
    unitsProduced: 0,
    unitsWholesale: 0,
    unitsRetail: 0,
    headcount: 0,
  };
}

export function isSameYear(a: SimDate, b: SimDate): boolean {
  return year(a) === year(b);
}
