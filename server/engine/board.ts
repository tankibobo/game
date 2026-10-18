/**
 * The board: quarterly meetings, votes on proposals, confidence in the CEO,
 * and reactions to forecast revisions. Votes are deterministic functions of
 * each director's preferences, the proposal's computed impact, trust in the
 * CEO and a small seeded idiosyncratic term — the LLM only narrates them.
 */
import type { BoardProposal, BoardVote, Character, ForecastSummary } from '../../shared/domain';
import { addDays, diffDays, fourthThursday, month, year, type SimDate } from '../../shared/dates';
import { fmtEur, mEur } from '../../shared/money';
import { PARAMS } from './params';
import { adjustTrust, byId, clamp, emit, inbox, nextId, remember, rngFor, type World } from './world';

export function boardMembers(w: World): Character[] {
  return w.characters.filter((c) => c.isBoardMember && c.active);
}

export function nextRegularMeeting(after: SimDate): SimDate {
  let y = year(after);
  let m = month(after);
  for (let i = 0; i < 8; i++) {
    const qm = [1, 4, 7, 10].find((x) => x >= m);
    if (qm === undefined) {
      y += 1;
      m = 1;
      continue;
    }
    const d = fourthThursday(y, qm);
    if (d > after) return d;
    m = qm + 1;
    if (m > 12) {
      y += 1;
      m = 1;
    }
  }
  return fourthThursday(y + 1, 1);
}

export function upcomingMeeting(w: World): SimDate {
  const x = w.meta.extraordinaryMeeting;
  return x && x < w.meta.nextBoardMeeting ? x : w.meta.nextBoardMeeting;
}

/** Board proposals must be submitted at least 7 days before a meeting. */
export function meetingForSubmission(w: World): SimDate {
  const minDate = addDays(w.meta.currentDate, 7);
  if (w.meta.extraordinaryMeeting && w.meta.extraordinaryMeeting >= minDate && w.meta.extraordinaryMeeting < w.meta.nextBoardMeeting) return w.meta.extraordinaryMeeting;
  if (w.meta.nextBoardMeeting >= minDate) return w.meta.nextBoardMeeting;
  return nextRegularMeeting(w.meta.nextBoardMeeting);
}

export interface ProposalAnalysis {
  cashImpactCents: number; // negative = cash outflow
  minLiquidityAfterCents: number;
  leverageAfter: number;
  annualProfitImpactCents: number;
  jobsImpact: number; // negative = job losses
  ev: number; // -1..1
  growth: number; // -1..1
  dilutionPct: number;
  risk: number; // 0..1
  cfoSupport: number; // -1..1
}

function num(a: Record<string, number | string | null>, k: keyof ProposalAnalysis): number {
  const v = a[k];
  return typeof v === 'number' ? v : 0;
}

export function memberScore(w: World, m: Character, p: BoardProposal): { score: number; reason: string } {
  const prefs = m.boardPrefs ?? { liquidity: 0.2, profitability: 0.2, growth: 0.15, ev: 0.15, jobs: 0.1, dilution: 0.1, risk: 0.1 };
  const a = p.analysis;
  const L = clamp((num(a, 'minLiquidityAfterCents') - mEur(700)) / mEur(700), -1, 1) + clamp(num(a, 'cashImpactCents') / mEur(400), -0.5, 0.5);
  const lev = num(a, 'leverageAfter');
  const P = clamp(num(a, 'annualProfitImpactCents') / mEur(80), -1, 1) + (lev > 3.25 ? -0.4 : 0);
  const G = clamp(num(a, 'growth'), -1, 1);
  const E = clamp(num(a, 'ev'), -1, 1);
  const J = clamp(num(a, 'jobsImpact') / 1000, -1, 1);
  const D = -clamp(num(a, 'dilutionPct') / 10, 0, 1.5);
  const R = -clamp(num(a, 'risk'), 0, 1);
  const parts: [string, number][] = [
    ['liquidity', prefs.liquidity * L],
    ['profitability', prefs.profitability * P],
    ['growth', prefs.growth * G],
    ['electrification', prefs.ev * E],
    ['jobs', prefs.jobs * J],
    ['dilution', prefs.dilution * D],
    ['risk', prefs.risk * R],
  ];
  const rng = rngFor(w);
  let s = parts.reduce((x, [, v]) => x + v, 0);
  s += 0.05; // boards tend to back management
  s += (m.trustInCeo - 50) / 250;
  s += (w.meta.boardConfidence - 50) / 300;
  s += 0.06 * clamp(num(a, 'cfoSupport'), -1, 1);
  s += Math.min(0.06, (p.rationale?.trim().length ?? 0) / 4000); // a written case helps, a little
  s += 0.06 * (rng.u(p.id, 'vote', m.id) - 0.5);
  const sorted = [...parts].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  const [k, v] = sorted[0];
  const reason = `${v >= 0 ? 'Supports' : 'Concerned about'} ${k}${sorted[1] && Math.abs(sorted[1][1]) > 0.03 ? `; ${sorted[1][1] >= 0 ? 'positive on' : 'worried about'} ${sorted[1][0]}` : ''}.`;
  return { score: Math.round(s * 1000) / 1000, reason };
}

export function voteProposal(w: World, p: BoardProposal): { approved: boolean; votes: BoardVote[] } {
  const votes: BoardVote[] = boardMembers(w).map((m) => {
    const { score, reason } = memberScore(w, m, p);
    return { memberId: m.id, vote: Math.abs(score) < 0.015 ? 'abstain' : score > 0 ? 'for' : 'against', score, reason };
  });
  const forV = votes.filter((v) => v.vote === 'for').length;
  const against = votes.filter((v) => v.vote === 'against').length;
  let approved = forV > against;
  if (forV === against) approved = votes.find((v) => v.memberId === 'CHR-DUBREUIL')?.vote === 'for';
  return { approved, votes };
}

/** Target board confidence from the latest forecast, commitments and credit standing. */
export function confidenceTarget(w: World): { target: number; factors: { label: string; delta: number }[] } {
  const f: { label: string; delta: number }[] = [];
  const fc = w.meta.lastForecastSummary;
  const plan = w.meta.boardPlan;
  if (fc) {
    const ebitDelta = clamp(((fc.fyEbitCents - plan.ebitTargetCents) / Math.max(1, Math.abs(plan.ebitTargetCents))) * 20, -15, 8);
    f.push({ label: 'FY operating profit vs plan', delta: ebitDelta });
    const liq12 = fc.minLiquidity12mCents ?? fc.minLiquidityCents;
    if (liq12 < plan.minLiquidityCents) f.push({ label: '12-month liquidity forecast below plan', delta: clamp(-((plan.minLiquidityCents - liq12) / plan.minLiquidityCents) * 30, -20, 0) });
    const sop = fc.eonSopForecast ?? fc.eonSopConditional;
    if (sop) {
      const late = diffDays(sop, plan.eonSopDate);
      f.push({ label: 'Eon SOP forecast vs plan', delta: late > 0 ? clamp(-late * 0.12, -20, 0) : 4 });
      if (!fc.eonSopForecast) f.push({ label: 'Eon battery supply not yet secured', delta: w.meta.currentDate > '2027-04-30' ? -10 : -4 });
    } else f.push({ label: 'Eon SOP cannot be forecast', delta: -18 });
  }
  if (w.covenants.some((c) => c.status === 'breached')) f.push({ label: 'Covenant breach', delta: -20 });
  const recent = w.commitments.filter((c) => c.resolvedDate && diffDays(w.meta.currentDate, c.resolvedDate) < 365 && boardMembers(w).some((m) => m.id === c.promiseeId));
  const kept = recent.filter((c) => c.status === 'fulfilled').length;
  const broken = recent.filter((c) => c.status === 'broken').length;
  if (kept) f.push({ label: 'Commitments to the board kept', delta: kept * 4 });
  if (broken) f.push({ label: 'Commitments to the board broken', delta: -broken * 8 });
  const members = boardMembers(w);
  const avgTrust = members.reduce((a, m) => a + m.trustInCeo, 0) / Math.max(1, members.length);
  f.push({ label: 'Directors’ trust in the CEO', delta: (avgTrust - 50) * 0.4 });
  const raw = clamp(55 + f.reduce((a, x) => a + x.delta, 0), 0, 100);
  // Honeymoon: a new CEO is judged on the inherited plan only gradually (first 150 days).
  const tenure = diffDays(w.meta.currentDate, w.meta.startDate);
  const g = clamp(tenure / 150, 0, 1);
  const target = Math.round((55 + (raw - 55) * g) * 10) / 10;
  if (g < 1) f.push({ label: `New-CEO grace period (${Math.round((1 - g) * 100)}% weight on inherited baseline)`, delta: target - raw });
  return { target, factors: f };
}

export function monthlyConfidence(w: World): void {
  const { target } = confidenceTarget(w);
  w.meta.boardConfidence = Math.round(clamp(w.meta.boardConfidence + (target - w.meta.boardConfidence) * 0.2, 0, 100) * 10) / 10;
}

/** Board reaction to a materially worse forecast (called when a new forecast is stored). */
export function reactToForecast(w: World, prev: ForecastSummary | null, next: ForecastSummary): string[] {
  if (!prev) return [];
  const reasons: string[] = [];
  const ebitDrop = prev.fyEbitCents - next.fyEbitCents;
  const liqDrop = (prev.minLiquidity12mCents ?? prev.minLiquidityCents) - (next.minLiquidity12mCents ?? next.minLiquidityCents);
  const prevSop = prev.eonSopForecast ?? prev.eonSopConditional;
  const nextSop = next.eonSopForecast ?? next.eonSopConditional;
  const sopSlip = prevSop && nextSop ? diffDays(nextSop, prevSop) : prevSop && !nextSop ? 999 : 0;
  if (ebitDrop > mEur(40)) reasons.push(`FY operating profit forecast down ${fmtEur(ebitDrop)} to ${fmtEur(next.fyEbitCents)}`);
  if (liqDrop > mEur(150)) reasons.push(`12-month minimum liquidity forecast down ${fmtEur(liqDrop)} to ${fmtEur(next.minLiquidity12mCents ?? next.minLiquidityCents)}`);
  if (sopSlip > 21) reasons.push(nextSop ? `Eon SOP forecast slipped ${sopSlip} days to ${nextSop}` : 'Eon SOP can no longer be forecast (blocked)');
  if (!reasons.length) return [];
  const hit = Math.min(10, 3 + reasons.length * 2);
  w.meta.boardConfidence = clamp(Math.round((w.meta.boardConfidence - hit) * 10) / 10, 0, 100);
  for (const m of boardMembers(w)) {
    adjustTrust(w, m.id, -1);
    remember(w, { characterId: m.id, kind: 'observation', summary: `Forecast revised: ${reasons.join('; ')}.`, importance: 4, sentiment: -1, sourceType: 'forecast', sourceId: null, entityRefs: [] });
  }
  const meeting = upcomingMeeting(w);
  const hasPlanCommitment = w.commitments.some((c) => c.promiseeId === 'CHR-DUBREUIL' && c.status === 'open' && c.check.type === 'deliver_plan' && c.check.topic === 'recovery');
  if (!hasPlanCommitment) {
    w.commitments.push({ id: nextId(w, 'COM'), promisorId: 'ceo', promiseeId: 'CHR-DUBREUIL', description: `Present a recovery plan addressing the forecast revision at the board meeting on ${meeting} (submit at least one board proposal or approved corrective action).`, dueDate: meeting, conditions: 'Requested by the chair after the forecast revision.', status: 'open', createdDate: w.meta.currentDate, source: 'board', sourceId: null, check: { type: 'deliver_plan', topic: 'recovery' }, resolvedDate: null, notifiedUpcoming: 0, importance: 4 });
  }
  emit(w, { type: 'board_reaction', category: 'board', severity: 'warning', title: 'Board alarmed by forecast revision', description: `${reasons.join('; ')}. Board confidence −${hit}. The chair expects a recovery plan at the ${meeting} meeting.`, causeKind: 'causal', cause: { text: 'Material deterioration between consecutive forecasts.', refs: [] }, entities: [{ type: 'character', id: 'CHR-DUBREUIL' }], followUps: ['Prepare a recovery plan (board proposal) before the next meeting.'] });
  inbox(w, { kind: 'board', fromId: 'CHR-DUBREUIL', subject: 'The latest forecast', body: `I have read the revised forecast: ${reasons.join('; ')}. The board needs to understand what changed, what you are doing about it, and what it means for liquidity and the refinancing. Please bring a recovery plan to our meeting on ${meeting}. I would rather hear bad news early than late.`, priority: 'urgent', linked: [] });
  return reasons;
}

export interface MeetingResult {
  approved: BoardProposal[];
  rejected: BoardProposal[];
}

export function holdBoardMeeting(w: World): MeetingResult {
  const d = w.meta.currentDate;
  const res: MeetingResult = { approved: [], rejected: [] };
  const extraordinary = w.meta.extraordinaryMeeting === d;
  const agenda = w.boardProposals.filter((p) => p.status === 'scheduled' && p.meetingDate <= d);
  const minutes: string[] = [];
  for (const p of agenda) {
    const { approved, votes } = voteProposal(w, p);
    p.votes = votes;
    p.status = approved ? 'approved' : 'rejected';
    p.decidedDate = d;
    p.outcomeNote = `${votes.filter((v) => v.vote === 'for').length} for, ${votes.filter((v) => v.vote === 'against').length} against, ${votes.filter((v) => v.vote === 'abstain').length} abstaining.`;
    minutes.push(`• ${p.title}: ${approved ? 'APPROVED' : 'REJECTED'} (${p.outcomeNote})`);
    for (const v of votes) remember(w, { characterId: v.memberId, kind: 'decision', summary: `Voted ${v.vote} on "${p.title}". ${v.reason}`, importance: 3, sentiment: v.vote === 'for' ? 1 : v.vote === 'against' ? -1 : 0, sourceType: 'board_proposal', sourceId: p.id, entityRefs: [{ type: 'board_proposal', id: p.id }] });
    emit(w, { type: approved ? 'board_approved' : 'board_rejected', category: 'board', severity: approved ? 'notice' : 'warning', title: `Board ${approved ? 'approves' : 'rejects'}: ${p.title}`, description: `${p.outcomeNote} ${votes.filter((v) => v.vote === 'against').map((v) => `${byId(w.characters, v.memberId)?.name}: ${v.reason}`).join(' ')}`.trim(), causeKind: 'causal', cause: { text: 'Board vote.', refs: [{ type: 'board_proposal', id: p.id }] }, entities: [{ type: 'board_proposal', id: p.id }], actionId: p.actionId });
    if (approved) {
      res.approved.push(p);
      if (p.actionId) w.out.approvedActions.push({ actionId: p.actionId, proposalId: p.id });
    } else {
      res.rejected.push(p);
      if (p.actionId) w.out.actionUpdates.push({ actionId: p.actionId, status: 'rejected', note: `Rejected by the board on ${d}: ${p.outcomeNote}` });
    }
  }
  // Performance review and confidence update (regular meetings only)
  if (!extraordinary) {
    const { target, factors } = confidenceTarget(w);
    const before = w.meta.boardConfidence;
    w.meta.boardConfidence = Math.round(clamp(before + (target - before) * 0.5, 0, 100) * 10) / 10;
    minutes.push(`Performance review — board confidence ${before.toFixed(0)} → ${w.meta.boardConfidence.toFixed(0)}. Drivers: ${factors.filter((x) => Math.abs(x.delta) >= 1).map((x) => `${x.label} (${x.delta > 0 ? '+' : ''}${x.delta.toFixed(0)})`).join(', ') || 'none material'}.`);
    if (w.meta.boardConfidence < PARAMS.confidenceDismissalThreshold) {
      w.meta.lowConfidenceMeetings += 1;
      if (w.meta.lowConfidenceMeetings >= PARAMS.confidenceDismissalMeetings) {
        w.meta.status = 'dismissed';
        w.meta.terminalReason = `The board removed you as CEO on ${d} after confidence stayed below ${PARAMS.confidenceDismissalThreshold} for ${w.meta.lowConfidenceMeetings} consecutive meetings.`;
        emit(w, { type: 'ceo_dismissed', category: 'board', severity: 'critical', title: 'The board has dismissed the CEO', description: w.meta.terminalReason, causeKind: 'causal' });
      } else {
        minutes.push('The chair warned that the board will consider a change of leadership if confidence does not recover by the next meeting.');
        emit(w, { type: 'board_warning', category: 'board', severity: 'critical', title: 'Board warns the CEO', description: `Board confidence is ${w.meta.boardConfidence.toFixed(0)}/100. Another meeting below ${PARAMS.confidenceDismissalThreshold} will lead to your dismissal.`, causeKind: 'causal' });
      }
    } else if (w.meta.boardConfidence >= 30) {
      w.meta.lowConfidenceMeetings = 0;
    }
    w.meta.nextBoardMeeting = nextRegularMeeting(d);
  }
  if (extraordinary) w.meta.extraordinaryMeeting = null;
  inbox(w, { kind: 'board', fromId: 'CHR-DUBREUIL', subject: `${extraordinary ? 'Extraordinary b' : 'B'}oard meeting — minutes ${d}`, body: minutes.length ? minutes.join('\n') : 'No proposals were tabled.', priority: 'high', linked: agenda.map((p) => ({ type: 'board_proposal' as const, id: p.id })) });
  emit(w, { type: 'board_meeting', category: 'board', severity: 'info', title: `${extraordinary ? 'Extraordinary b' : 'B'}oard meeting held`, description: minutes.join(' '), causeKind: 'scheduled' });
  return res;
}
