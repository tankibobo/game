/**
 * Cash movements: dealer receipts, supplier/tax payments, debt service and
 * automatic revolving-credit treasury. Payment obligations are never skipped
 * silently — if cash and available RCF are insufficient, the payable becomes
 * overdue and the missed-payment counter (→ insolvency) starts.
 */
import type { CashFlowCategory, DebtInstrument, Payable } from '../../shared/domain';
import { dayOfMonth, daysInMonth, month, type SimDate } from '../../shared/dates';
import { mulDiv, type Cents } from '../../shared/money';
import { cash, post } from './ledger';
import { rcf, rcfAvailable } from './metrics';
import { PARAMS } from './params';
import { emit, nextId, type World } from './world';

export function collectReceivables(w: World): Cents {
  const d = w.meta.currentDate;
  let total = 0;
  for (const r of w.receivables) {
    if (r.status !== 'open' || r.dueDate > d) continue;
    r.status = 'settled';
    r.settledDate = d;
    total += r.amountCents;
  }
  if (total !== 0) {
    post(w, { description: `Dealer receipts ${d}`, sourceType: 'receipts', cf: { category: 'operating', line: 'customer_receipts' }, lines: [{ account: '1000', amountCents: total }, { account: '1100', amountCents: -total }] });
  }
  return total;
}

/** Draw the RCF (in €10m steps) to cover `needed` while keeping the minimum operating cash. */
export function ensureCash(w: World, needed: Cents, reason: string): boolean {
  const shortfall = needed + PARAMS.minOperatingCashCents - cash(w);
  if (shortfall <= 0) return true;
  const avail = rcfAvailable(w);
  const step = 1_000_000_000; // €10m
  const draw = Math.min(avail, Math.ceil(shortfall / step) * step);
  if (draw > 0) drawRcf(w, draw, reason);
  return cash(w) >= needed;
}

export function drawRcf(w: World, amount: Cents, reason: string): void {
  const r = rcf(w);
  if (!r || amount <= 0) return;
  r.principalCents += amount;
  post(w, { description: `RCF drawdown (${reason})`, sourceType: 'treasury', sourceId: r.id, cf: { category: 'financing', line: 'rcf_draw' }, lines: [{ account: '1000', amountCents: amount }, { account: '2700', amountCents: -amount }] });
  emit(w, { type: 'rcf_draw', category: 'finance', severity: 'notice', title: `Treasury drew €${(amount / 1e8).toFixed(0)}m on the RCF`, description: `Automatic drawdown to meet payments (${reason}). RCF drawn: €${(r.principalCents / 1e8).toFixed(0)}m of €${(r.limitCents / 1e8).toFixed(0)}m.`, causeKind: 'causal', cause: { text: 'Cash below the minimum operating balance.', refs: [{ type: 'debt', id: r.id }] }, entities: [{ type: 'debt', id: r.id }] });
}

export function repayRcf(w: World, amount: Cents, reason: string): Cents {
  const r = rcf(w);
  if (!r) return 0;
  const amt = Math.min(amount, r.principalCents, Math.max(0, cash(w)));
  if (amt <= 0) return 0;
  r.principalCents -= amt;
  post(w, { description: `RCF repayment (${reason})`, sourceType: 'treasury', sourceId: r.id, cf: { category: 'financing', line: 'rcf_repay' }, lines: [{ account: '2700', amountCents: amt }, { account: '1000', amountCents: -amt }] });
  return amt;
}

/**
 * Pay an obligation now if cash (incl. automatic RCF draw) allows; otherwise
 * recognise it as a payable due today, so it is paid as soon as cash is
 * available and counts toward missed payments meanwhile. Never lets cash go
 * negative.
 */
export function payOrDefer(
  w: World,
  input: { description: string; sourceType: string; sourceId?: string | null; cf: { category: CashFlowCategory; line: string }; debits: { account: string; amountCents: Cents }[]; counterpartyId: string; category: Payable['category'] },
): 'paid' | 'deferred' {
  const total = input.debits.reduce((a, l) => a + l.amountCents, 0);
  if (total <= 0) return 'paid';
  ensureCash(w, total, input.description);
  if (cash(w) >= total) {
    post(w, { description: input.description, sourceType: input.sourceType, sourceId: input.sourceId ?? null, cf: input.cf, lines: [...input.debits, { account: '1000', amountCents: -total }] });
    return 'paid';
  }
  post(w, { description: `${input.description} (unpaid — recognised as overdue payable)`, sourceType: input.sourceType, sourceId: input.sourceId ?? null, lines: [...input.debits, { account: '2000', amountCents: -total }] });
  w.payables.push({ id: nextId(w, 'AP'), counterpartyId: input.counterpartyId, category: input.category, amountCents: total, issueDate: w.meta.currentDate, dueDate: w.meta.currentDate, status: 'overdue', paidDate: null, sourceId: input.sourceId ?? null, liabilityAccount: '2000' });
  emit(w, { type: 'payment_deferred', category: 'finance', severity: 'critical', title: `Unable to pay: ${input.description}`, description: `No cash or available credit to pay ${(total / 1e8).toFixed(1)}m. The amount is now overdue.`, causeKind: 'causal' });
  return 'deferred';
}

const CF_FOR: Record<Payable['category'], { category: CashFlowCategory; line: string }> = {
  materials: { category: 'operating', line: 'supplier_payments' },
  overhead: { category: 'operating', line: 'supplier_payments' },
  marketing: { category: 'operating', line: 'supplier_payments' },
  ga: { category: 'operating', line: 'supplier_payments' },
  other: { category: 'operating', line: 'supplier_payments' },
  warranty: { category: 'operating', line: 'supplier_payments' },
  project: { category: 'operating', line: 'supplier_payments' },
  capex: { category: 'investing', line: 'capex' },
  tax: { category: 'operating', line: 'tax_paid' },
  co2: { category: 'operating', line: 'co2_premium' },
  restructuring: { category: 'operating', line: 'restructuring' },
  payroll: { category: 'operating', line: 'payroll' },
  prepayment: { category: 'operating', line: 'supplier_prepayment' },
  fees: { category: 'financing', line: 'financing_fees' },
};

/** Pay all payables due today (and overdue ones), drawing the RCF if needed. */
export function payPayables(w: World): { paid: Cents; overdue: Cents } {
  const d = w.meta.currentDate;
  const due = w.payables.filter((p) => (p.status === 'open' || p.status === 'overdue') && p.dueDate <= d).sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id < b.id ? -1 : 1));
  if (due.length === 0) return { paid: 0, overdue: 0 };
  const totalDue = due.reduce((a, p) => a + p.amountCents, 0);
  ensureCash(w, totalDue, 'supplier and tax payments');
  const groups = new Map<string, { cf: { category: CashFlowCategory; line: string }; byAccount: Record<string, Cents>; total: Cents }>();
  let overdue = 0;
  let paid = 0;
  let available = cash(w);
  for (const p of due) {
    if (p.amountCents > available) {
      if (p.status !== 'overdue') p.status = 'overdue';
      overdue += p.amountCents;
      continue;
    }
    available -= p.amountCents;
    p.status = 'paid';
    p.paidDate = d;
    paid += p.amountCents;
    const cf = CF_FOR[p.category];
    const key = `${cf.category}:${cf.line}`;
    const g = groups.get(key) ?? { cf, byAccount: {}, total: 0 };
    g.byAccount[p.liabilityAccount] = (g.byAccount[p.liabilityAccount] ?? 0) + p.amountCents;
    g.total += p.amountCents;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.total === 0) continue;
    post(w, {
      description: `Payments ${d} (${g.cf.line.replace(/_/g, ' ')})`,
      sourceType: 'payments',
      cf: g.cf,
      lines: [...Object.entries(g.byAccount).map(([account, amountCents]) => ({ account, amountCents })), { account: '1000', amountCents: -g.total }],
    });
  }
  return { paid, overdue };
}

function isPaymentDay(inst: DebtInstrument, d: SimDate): boolean {
  if (!inst.interestMonths.includes(month(d))) return false;
  const day = Math.min(inst.paymentDay, daysInMonth(d));
  return dayOfMonth(d) === day;
}

/** Accrue interest for the instrument's accumulated principal-days (and RCF commitment fee). */
export function accrueInterest(w: World, inst: DebtInstrument, description: string): Cents {
  const interest = mulDiv(inst.principalDays, inst.rateBps, 10_000 * PARAMS.daysPerYear);
  const fee = inst.kind === 'rcf' ? mulDiv(inst.undrawnDays, inst.commitmentFeeBps, 10_000 * PARAMS.daysPerYear) : 0;
  inst.principalDays = 0;
  inst.undrawnDays = 0;
  const lines = [];
  if (interest > 0) lines.push({ account: '7000', amountCents: interest });
  if (fee > 0) lines.push({ account: '7100', amountCents: fee });
  if (interest + fee > 0) {
    lines.push({ account: '2600', amountCents: -(interest + fee) });
    post(w, { description, sourceType: 'interest_accrual', sourceId: inst.id, lines });
  }
  inst.interestPayableCents += interest + fee;
  return interest + fee;
}

export interface DebtServiceResult {
  defaulted: DebtInstrument[];
}

/** Daily debt service: accumulators, coupons, amortisation and maturities. */
export function debtService(w: World): DebtServiceResult {
  const d = w.meta.currentDate;
  const res: DebtServiceResult = { defaulted: [] };
  for (const inst of w.debts) {
    if (inst.status !== 'active') continue;
    inst.principalDays += inst.principalCents;
    if (inst.kind === 'rcf') inst.undrawnDays += Math.max(0, inst.limitCents - inst.principalCents);

    const maturing = d === inst.maturityDate;
    if (maturing) accrueInterest(w, inst, `Interest accrual to maturity — ${inst.name}`);

    // Interest payment
    if ((isPaymentDay(inst, d) || maturing) && inst.interestPayableCents > 0) {
      const amt = inst.interestPayableCents;
      if (ensureCash(w, amt, `interest on ${inst.name}`) || cash(w) >= amt) {
        post(w, { description: `Interest paid — ${inst.name}`, sourceType: 'interest_payment', sourceId: inst.id, cf: { category: 'operating', line: 'interest_paid' }, lines: [{ account: '2600', amountCents: amt }, { account: '1000', amountCents: -amt }] });
        inst.interestPayableCents = 0;
      } else {
        res.defaulted.push(inst);
        continue;
      }
    }
    // Scheduled amortisation
    for (const a of inst.amortization) {
      if (a.date !== d) continue;
      const amt = Math.min(a.amountCents, inst.principalCents);
      if (amt <= 0) continue;
      if (ensureCash(w, amt, `amortisation of ${inst.name}`)) {
        inst.principalCents -= amt;
        post(w, { description: `Scheduled repayment — ${inst.name}`, sourceType: 'debt_repayment', sourceId: inst.id, cf: { category: 'financing', line: 'debt_repayment' }, lines: [{ account: '2700', amountCents: amt }, { account: '1000', amountCents: -amt }] });
      } else {
        res.defaulted.push(inst);
      }
    }
    // Maturity
    if (maturing && inst.principalCents > 0) {
      const amt = inst.principalCents;
      if (inst.kind === 'rcf') {
        // RCF maturity: drawn balance must be repaid from cash.
        if (cash(w) >= amt) {
          repayRcf(w, amt, 'facility maturity');
          inst.status = 'repaid';
        } else res.defaulted.push(inst);
        continue;
      }
      if (ensureCash(w, amt, `maturity of ${inst.name}`)) {
        inst.principalCents = 0;
        inst.status = 'repaid';
        post(w, { description: `Repayment at maturity — ${inst.name}`, sourceType: 'debt_repayment', sourceId: inst.id, cf: { category: 'financing', line: 'debt_repayment' }, lines: [{ account: '2700', amountCents: amt }, { account: '1000', amountCents: -amt }] });
        emit(w, { type: 'debt_repaid', category: 'finance', severity: 'notice', title: `${inst.name} repaid at maturity`, description: `€${(amt / 1e8).toFixed(0)}m repaid.`, causeKind: 'scheduled', entities: [{ type: 'debt', id: inst.id }] });
      } else {
        res.defaulted.push(inst);
      }
    } else if (maturing) {
      inst.status = 'repaid';
    }
  }
  return res;
}

/** Month-end: accrue interest on all instruments; sweep surplus cash into RCF repayment. */
export function monthEndTreasury(w: World): void {
  for (const inst of w.debts) if (inst.status === 'active') accrueInterest(w, inst, `Interest accrual ${w.meta.currentDate.slice(0, 7)} — ${inst.name}`);
  const r = rcf(w);
  if (r && r.principalCents > 0) {
    const surplus = cash(w) - PARAMS.rcfAutoRepayAboveCents;
    if (surplus > 0) repayRcf(w, Math.floor(surplus / 1_000_000_000) * 1_000_000_000, 'surplus cash sweep');
  }
}
