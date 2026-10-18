/** Credit and liquidity metrics derived from authoritative state. */
import type { FinancialSnapshot } from '../../shared/domain';
import type { Cents } from '../../shared/money';
import { monthKey } from '../../shared/dates';
import { bal } from './ledger';
import type { World } from './world';

export function grossDebt(w: World): Cents {
  return w.debts.filter((d) => d.status === 'active').reduce((a, d) => a + d.principalCents, 0) + -bal(w, '2800');
}

export function rcf(w: World) {
  return w.debts.find((d) => d.kind === 'rcf' && d.status === 'active');
}

export function rcfAvailable(w: World): Cents {
  const r = rcf(w);
  if (!r) return 0;
  if (rcfBlocked(w)) return 0;
  if (w.meta.currentDate > r.maturityDate) return 0;
  return Math.max(0, r.limitCents - r.principalCents);
}

/** RCF drawdowns are unavailable while a covenant on it is in (unwaived) breach. */
export function rcfBlocked(w: World): boolean {
  const r = rcf(w);
  if (!r) return true;
  return w.covenants.some((c) => c.instrumentIds.includes(r.id) && c.status === 'breached');
}

export function liquidity(w: World): Cents {
  const r = rcf(w);
  const undrawn = r && !rcfBlocked(w) ? Math.max(0, r.limitCents - r.principalCents) : 0;
  return bal(w, '1000') + undrawn;
}

export function netDebt(w: World): Cents {
  return grossDebt(w) - bal(w, '1000');
}

/** Last-twelve-month sums from monthly snapshots (pre-game months use the FY2026 baseline). */
export function ltm(w: World, field: 'ebitdaCents' | 'interestCents' | 'revenueCents' | 'ebitCents', includeCurrentMtd = false): Cents {
  const months = w.snapshots.filter((s) => s.kind === 'month').sort((a, b) => (a.period < b.period ? -1 : 1));
  const last12 = months.slice(-12);
  return last12.reduce((a, s) => a + s.data[field], 0) + (includeCurrentMtd ? 0 : 0);
}

export function netLeverage(w: World): number {
  const e = ltm(w, 'ebitdaCents');
  if (e <= 0) return 99;
  return netDebt(w) / e;
}

export function interestCover(w: World): number {
  const i = ltm(w, 'interestCents');
  if (i <= 0) return 99;
  return ltm(w, 'ebitdaCents') / i;
}

export function latestSnapshot(w: World): FinancialSnapshot | undefined {
  return [...w.snapshots].filter((s) => s.kind === 'month').sort((a, b) => (a.period < b.period ? 1 : -1))[0];
}

export function currentMonth(w: World): string {
  return monthKey(w.meta.currentDate);
}

export function headcount(w: World): number {
  return w.departments.reduce((a, d) => a + d.headcount, 0);
}

/** Engineering FTE available for projects (engineering headcount − sustaining reserve − project staffing). */
export const SUSTAINING_ENGINEERING_FTE = 1_450;

export function engineeringFreeFte(w: World, excludeProjectId?: string): number {
  const eng = w.departments.filter((d) => d.kind === 'engineering').reduce((a, d) => a + d.headcount, 0);
  const used = w.projects
    .filter((p) => ['active', 'delayed', 'blocked', 'approved'].includes(p.status) && p.id !== excludeProjectId)
    .reduce((a, p) => a + p.staffingFte, 0);
  return eng - SUSTAINING_ENGINEERING_FTE - used;
}
