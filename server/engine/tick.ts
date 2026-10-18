/**
 * Time progression. `advanceDay` processes one calendar day in a fixed order:
 *
 *  1. Scheduled items: regulations, supplier capacity changes, hires/leavers,
 *     counterparty decisions, financing reviews
 *  2. Engineering and industrial projects
 *  3. Production (supplier deliveries, line output)
 *  4. Sales & deliveries, receipts, payments, debt service
 *  5. Commitments and contractual obligations
 *  6. Issue upkeep (milestone/issue deadlines, investigations)
 *  7. Event eligibility (causal events and seeded shocks)
 *  8. Board meeting (if scheduled today)
 *  9. Month-end close: accruals, statements, covenant tests
 * 10. Forecast refresh for projects; terminal-condition checks
 *
 * Each day is processed exactly once; recurring monthly items post only at
 * month end from accumulators, so 30 × "advance one day" ≡ "advance 30 days".
 */
import { addDays, isMonthEnd, monthKey, type SimDate } from '../../shared/dates';
import { fmtEur } from '../../shared/money';
import { holdBoardMeeting, monthlyConfidence, upcomingMeeting } from './board';
import { closeMonth } from './close';
import { processCommitments } from './commitments';
import { runEvents, scheduledDevelopments, upkeepIssues } from './events';
import { processFinancing } from './financing';
import { resolvePendingDecisions } from './negotiation';
import { runProduction, updateSupplies } from './operations';
import { PARAMS } from './params';
import { progressProjects, updateProjectForecasts } from './projects';
import { runSales } from './sales';
import { collectReceivables, debtService, payPayables } from './treasury';
import { workforceDaily } from './workforce';
import { emit, type World } from './world';

export interface TickHooks {
  /** Called when the board approved a proposal linked to an action; must commit it on `w`. */
  onBoardApproved?: (w: World, actionId: string, proposalId: string) => void;
}

export interface DayResult {
  date: SimDate;
  produced: Record<string, number>;
  retail: Record<string, number>;
  wholesale: Record<string, number>;
  constraints: string[];
  closedMonth: string | null;
}

export function advanceDay(w: World, hooks: TickHooks = {}): DayResult {
  if (w.meta.status !== 'active') throw new Error(`Game is over: ${w.meta.terminalReason}`);
  const d = w.meta.currentDate;
  const res: DayResult = { date: d, produced: {}, retail: {}, wholesale: {}, constraints: [], closedMonth: null };

  // 1. scheduled
  scheduledDevelopments(w);
  updateSupplies(w);
  workforceDaily(w);
  resolvePendingDecisions(w);
  processFinancing(w);

  // 2. projects
  progressProjects(w);

  // 3. production
  const prod = runProduction(w);
  res.produced = prod.byModel;
  res.constraints = prod.constraints;

  // 4. sales, cash
  const sales = runSales(w);
  res.retail = sales.retail;
  res.wholesale = sales.wholesale;
  collectReceivables(w);
  const pay = payPayables(w);
  const ds = debtService(w);

  // 5–7. obligations, issues, events
  processCommitments(w);
  upkeepIssues(w);
  runEvents(w);

  // 8. board
  if (w.mode === 'live' && upcomingMeeting(w) === d) {
    const before = w.out.approvedActions.length;
    holdBoardMeeting(w);
    for (const a of w.out.approvedActions.slice(before)) hooks.onBoardApproved?.(w, a.actionId, a.proposalId);
  }

  // 9. month end
  if (isMonthEnd(d)) {
    closeMonth(w);
    monthlyConfidence(w);
    res.closedMonth = monthKey(d);
    w.meta.forecastStale = 1;
  }

  // 10. forecasts & terminal checks
  if (w.mode === 'live') updateProjectForecasts(w);
  checkTerminal(w, pay.overdue, ds.defaulted.map((x) => x.name));

  // advance the clock
  const next = addDays(d, 1);
  if (monthKey(next) !== monthKey(d)) w.meta.mtdByAccount = {};
  if (next.slice(0, 4) !== d.slice(0, 4)) w.meta.ytdByAccount = {};
  w.meta.currentDate = next;
  w.meta.version += 1;
  return res;
}

function checkTerminal(w: World, overdue: number, defaulted: string[]): void {
  if (w.meta.status !== 'active') return;
  if (defaulted.length > 0) {
    w.meta.status = 'insolvent';
    w.meta.terminalReason = `Payment default on ${defaulted.join(', ')} on ${w.meta.currentDate}. Cross-default clauses accelerate all debt; the company files for insolvency protection.`;
    emit(w, { type: 'insolvency', category: 'finance', severity: 'critical', title: 'Asterion defaults on its debt', description: w.meta.terminalReason, causeKind: 'causal' });
    return;
  }
  if (overdue > PARAMS.insolvencyOverdueThresholdCents) {
    w.meta.missedPaymentDays += 1;
    if (w.meta.missedPaymentDays === 1) {
      emit(w, { type: 'missed_payments', category: 'finance', severity: 'critical', title: 'Asterion is missing supplier payments', description: `${fmtEur(overdue)} of invoices are overdue and there is no cash or available credit to pay them. Without new liquidity within ${PARAMS.insolvencyMissedPaymentDays} days the company must file for insolvency.`, causeKind: 'causal', followUps: ['Raise emergency financing, sell assets, or cut production immediately.'] });
    }
    if (w.meta.missedPaymentDays >= PARAMS.insolvencyMissedPaymentDays) {
      w.meta.status = 'insolvent';
      w.meta.terminalReason = `Unable to pay ${fmtEur(overdue)} of overdue obligations for ${w.meta.missedPaymentDays} days. The company files for insolvency on ${w.meta.currentDate}.`;
      emit(w, { type: 'insolvency', category: 'finance', severity: 'critical', title: 'Asterion files for insolvency', description: w.meta.terminalReason, causeKind: 'causal' });
    }
  } else {
    w.meta.missedPaymentDays = 0;
  }
}

export function advanceDays(w: World, days: number, hooks: TickHooks = {}): DayResult[] {
  const out: DayResult[] = [];
  for (let i = 0; i < days; i++) {
    if (w.meta.status !== 'active') break;
    out.push(advanceDay(w, hooks));
  }
  return out;
}
