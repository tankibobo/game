/**
 * The board: quarterly meetings, votes on proposals, confidence in the CEO,
 * and reactions to forecast revisions. Votes are deterministic functions of
 * each director's preferences, the proposal's computed impact, trust in the
 * CEO and a small seeded idiosyncratic term — the LLM only narrates them.
 */
import type { BoardProposal, BoardVote, Character, ForecastSummary } from '../../shared/domain';
import { addDays, diffDays, fourthThursday, month, year, type SimDate } from '../../shared/dates';
import { fmtEur, mEur } from '../../shared/money';
import { difficultyOf } from './difficulty';
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
  /** One-off cash effect of the decision (negative = outflow). */
  cashImpactCents: number;
  minLiquidityAfterCents: number;
  leverageAfter: number;
  /** Recurring yearly effect on operating profit (savings positive, costs negative). */
  annualProfitImpactCents: number;
  jobsImpact: number; // negative = job losses
  ev: number; // -1..1
  growth: number; // -1..1
  dilutionPct: number;
  risk: number; // 0..1
  cfoSupport: number; // -1..1
  /** 0..1 — how unavoidable the decision is (legal compliance, a blocked programme, a crew shortage). */
  necessity?: number;
}

function num(a: Record<string, number | string | null>, k: keyof ProposalAnalysis): number {
  const v = a[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export const DEFAULT_PREFS = { liquidity: 0.2, profitability: 0.2, growth: 0.15, ev: 0.15, jobs: 0.1, dilution: 0.1, risk: 0.1 };

const FACTOR_LABEL: Record<string, string> = { liquidity: 'liquidity', profitability: 'profitability', growth: 'growth', electrification: 'electrification', jobs: 'jobs', dilution: 'dilution', risk: 'risk', necessity: 'necessity' };

/** How stretched the company's liquidity is in the current forecast: 0 comfortable … 1 no headroom. */
export function liquidityTightness(w: World): number {
  const fc = w.meta.lastForecastSummary;
  const low = fc ? (fc.minLiquidity12mCents ?? fc.minLiquidityCents) : mEur(700);
  const plan = w.meta.boardPlan.minLiquidityCents;
  return clamp((plan - low) / Math.max(1, plan), 0, 1);
}

export interface MemberScore {
  score: number;
  reason: string;
  parts: { factor: string; value: number }[];
}

/**
 * A director's view of a proposal. Directors judge what the decision itself
 * changes (its cash, recurring profit, jobs, risk, strategic fit and how
 * unavoidable it is). The company's overall liquidity position does not sink
 * every proposal; it makes directors more sensitive to cash spent — and more
 * appreciative of cash saved — when headroom is thin.
 */
export function memberScore(w: World, m: Character, p: Pick<BoardProposal, 'id' | 'analysis' | 'rationale'>, opts: { noise?: boolean } = {}): MemberScore {
  const prefs = m.boardPrefs ?? DEFAULT_PREFS;
  const a = p.analysis;
  const tight = liquidityTightness(w);
  const cash = num(a, 'cashImpactCents');
  const profit = num(a, 'annualProfitImpactCents');
  const fc = w.meta.lastForecastSummary;
  const low = fc ? (fc.minLiquidity12mCents ?? fc.minLiquidityCents) : mEur(700);
  let L = clamp((cash + 1.5 * profit) / mEur(250), -1, 1) * (0.5 + tight);
  const floor = w.covenants.find((c) => c.metric === 'min_liquidity')?.threshold ?? mEur(400);
  if (low >= floor && low + cash < floor) L -= 0.5; // would push the forecast below the EIB floor
  const lev = num(a, 'leverageAfter');
  const P = clamp(profit / mEur(60), -1, 1) + (lev > 3.25 ? -0.4 : 0);
  const G = clamp(num(a, 'growth'), -1, 1);
  const E = clamp(num(a, 'ev'), -1, 1);
  const J = clamp(num(a, 'jobsImpact') / 600, -1, 1);
  const D = -clamp(num(a, 'dilutionPct') / 10, 0, 1.5);
  const R = -clamp(num(a, 'risk'), 0, 1);
  const N = clamp(num(a, 'necessity'), 0, 1);
  const parts: [string, number][] = [
    ['liquidity', prefs.liquidity * L],
    ['profitability', prefs.profitability * P],
    ['growth', prefs.growth * G],
    ['electrification', prefs.ev * E],
    ['jobs', prefs.jobs * J],
    ['dilution', prefs.dilution * D],
    ['risk', prefs.risk * R],
    ['necessity', 0.3 * N],
  ];
  let s = parts.reduce((x, [, v]) => x + v, 0);
  s += 0.04; // boards tend to back management
  s += (m.trustInCeo - 50) / 250;
  s += (w.meta.boardConfidence - 50) / 300;
  s += 0.06 * clamp(num(a, 'cfoSupport'), -1, 1);
  s += Math.min(0.06, (p.rationale?.trim().length ?? 0) / 4000); // a written case helps, a little
  if (opts.noise !== false) s += 0.04 * (rngFor(w).u(p.id, 'vote', m.id) - 0.5);
  const sorted = [...parts].filter(([, v]) => Math.abs(v) >= 0.01).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
  const phrase = ([k, v]: [string, number]): string => {
    if (k === 'liquidity') return v >= 0 ? `it strengthens liquidity (${fmtEur(cash, { sign: true })} now${profit ? `, ${fmtEur(profit, { sign: true })} a year after that` : ''})` : `the cash it needs (${fmtEur(-cash)}${profit < 0 ? ` plus ${fmtEur(-profit)} a year` : ''})${tight > 0.3 ? ' while liquidity is tight' : ''}`;
    if (k === 'profitability') return v >= 0 ? `the profit it should add (${fmtEur(profit, { sign: true })} a year)` : `the profit it costs (${fmtEur(profit)} a year)`;
    if (k === 'jobs') return v >= 0 ? `the ${Math.round(num(a, 'jobsImpact')).toLocaleString('en-GB')} jobs it creates` : `the ${Math.round(-num(a, 'jobsImpact')).toLocaleString('en-GB')} jobs it cuts`;
    if (k === 'dilution') return `diluting shareholders by ${num(a, 'dilutionPct').toFixed(1)}%`;
    if (k === 'risk') return 'the execution risk';
    if (k === 'necessity') return N >= 0.5 ? 'the fact that it has to be done' : 'the part of it that has to be done';
    if (k === 'electrification') return v >= 0 ? 'its support for electrification' : 'the damage to the electrification strategy';
    return v >= 0 ? `its contribution to ${FACTOR_LABEL[k]}` : `its effect on ${FACTOR_LABEL[k]}`;
  };
  const pos = sorted.filter(([, v]) => v > 0).slice(0, 2).map(phrase);
  const neg = sorted.filter(([, v]) => v < 0).slice(0, 2).map(phrase);
  const reason = s > 0
    ? `For: ${pos.join(' and ') || 'backs management'}${neg.length ? `; reservations about ${neg.join(' and ')}` : ''}.`
    : `Against: ${neg.join(' and ') || 'not persuaded'}${pos.length ? `; sees merit in ${pos.join(' and ')}` : ''}.`;
  return { score: Math.round(s * 1000) / 1000, reason, parts: parts.map(([factor, value]) => ({ factor, value: Math.round(value * 1000) / 1000 })) };
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

export interface VoteOutlook {
  outlook: 'likely_approve' | 'too_close' | 'likely_reject';
  forCount: number;
  againstCount: number;
  leaningCount: number;
  members: { memberId: string; name: string; lean: 'for' | 'against' | 'undecided'; score: number; reason: string }[];
  tips: string[];
}

/** What the board would likely do today, without the vote-day idiosyncrasies. Shown before you submit. */
export function predictVote(w: World, analysis: ProposalAnalysis | Record<string, number>, rationale: string): VoteOutlook {
  const p = { id: 'PREVIEW', analysis: analysis as unknown as Record<string, number>, rationale };
  const members = boardMembers(w).map((m) => {
    const r = memberScore(w, m, p, { noise: false });
    const lean: 'for' | 'against' | 'undecided' = r.score > 0.03 ? 'for' : r.score < -0.03 ? 'against' : 'undecided';
    return { memberId: m.id, name: m.name, lean, score: r.score, reason: r.reason };
  });
  const forCount = members.filter((x) => x.lean === 'for').length;
  const againstCount = members.filter((x) => x.lean === 'against').length;
  const leaningCount = members.length - forCount - againstCount;
  const chair = members.find((x) => x.memberId === 'CHR-DUBREUIL');
  const outlook = forCount > members.length / 2 || (forCount === members.length / 2 && chair?.lean === 'for' && againstCount < forCount)
    ? 'likely_approve'
    : againstCount > members.length / 2 || (againstCount >= forCount + 2)
      ? 'likely_reject'
      : 'too_close';
  const tips: string[] = [];
  const against = members.filter((x) => x.lean !== 'for');
  if (against.length) {
    tips.push(`Meet the directors who are not yet convinced (${against.map((x) => x.name.split(' ').pop()).join(', ')}): their trust in you counts in the vote, and they will tell you what worries them.`);
    if (!rationale || rationale.trim().length < 200) tips.push('Write a fuller case for the board (what it costs, what it saves, the alternatives) — it helps a little.');
    const cashWorry = members.some((x) => x.lean !== 'for' && /cash it needs|profit it costs/.test(x.reason));
    if (cashWorry) tips.push('Directors are worried about cash: securing financing first, or pairing this with savings in a board plan, changes the picture.');
    if (members.some((x) => x.lean !== 'for' && /jobs it cuts/.test(x.reason))) tips.push('Employee-side directors oppose job cuts; a voluntary programme or a smaller reduction softens that.');
  }
  return { outlook, forCount, againstCount, leaningCount, members, tips };
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
  // Honeymoon: a new CEO is judged on the inherited plan only gradually (grace period depends on difficulty).
  const tenure = diffDays(w.meta.currentDate, w.meta.startDate);
  const g = clamp(tenure / difficultyOf(w).graceDays, 0, 1);
  const target = Math.round((55 + (raw - 55) * g) * 10) / 10;
  if (g < 1) f.push({ label: `New-CEO grace period: inherited problems count only ${Math.round(g * 100)}% (full weight from ${addDays(w.meta.startDate, difficultyOf(w).graceDays)})`, delta: target - raw });
  return { target, factors: f };
}

export function monthlyConfidence(w: World): void {
  const { target } = confidenceTarget(w);
  w.meta.boardConfidence = Math.round(clamp(w.meta.boardConfidence + (target - w.meta.boardConfidence) * difficultyOf(w).monthlyPull, 0, 100) * 10) / 10;
}

/** Board reaction to a materially worse forecast (called when a new forecast is stored). */
export function reactToForecast(w: World, prev: ForecastSummary | null, next: ForecastSummary, opts: { ownDecision?: boolean } = {}): string[] {
  if (!prev) return [];
  const reasons: string[] = [];
  // Deterioration the board itself signed off on (approved spending) is expected, not a surprise.
  const allowed = w.out.boardApprovedImpact ?? { cashCents: 0, ebitCents: 0 };
  const ebitDrop = prev.fyEbitCents - next.fyEbitCents - allowed.ebitCents;
  const liqDrop = (prev.minLiquidity12mCents ?? prev.minLiquidityCents) - (next.minLiquidity12mCents ?? next.minLiquidityCents) - allowed.cashCents;
  const prevSop = prev.eonSopForecast ?? prev.eonSopConditional;
  const nextSop = next.eonSopForecast ?? next.eonSopConditional;
  const sopSlip = prevSop && nextSop ? diffDays(nextSop, prevSop) : prevSop && !nextSop ? 999 : 0;
  const plan = w.meta.boardPlan;
  const sameYear = prev.createdDate.slice(0, 4) === next.createdDate.slice(0, 4); // FY figures are not comparable across a year end
  const nextLiq = next.minLiquidity12mCents ?? next.minLiquidityCents;
  // The board only worries when the revision leaves the company short of its plan.
  // A decision of the CEO that trades profit for cash (e.g. building fewer unsold cars) is not a surprise to be alarmed by;
  // it is judged at the next meeting. Profit drops that also cost liquidity are.
  const tradesProfitForCash = !!opts.ownDecision && liqDrop <= 0;
  if (sameYear && !tradesProfitForCash && ebitDrop > mEur(40) && next.fyEbitCents < plan.ebitTargetCents) reasons.push(`FY operating profit forecast down ${fmtEur(prev.fyEbitCents - next.fyEbitCents)} to ${fmtEur(next.fyEbitCents)} (plan ${fmtEur(plan.ebitTargetCents)})`);
  if (liqDrop > mEur(150) && nextLiq < plan.minLiquidityCents * 1.25) {
    const bond = w.debts.find((d) => d.id === 'DEBT-BOND28' && d.status === 'active');
    const entered = bond && diffDays(bond.maturityDate, next.createdDate) <= 366 && diffDays(bond.maturityDate, prev.createdDate) > 366;
    reasons.push(entered ? `the ${fmtEur(bond!.principalCents)} bond repayment on ${bond!.maturityDate} now falls within the 12-month forecast and is not yet refinanced: minimum liquidity ${fmtEur(nextLiq)}` : `12-month minimum liquidity forecast down ${fmtEur((prev.minLiquidity12mCents ?? prev.minLiquidityCents) - nextLiq)} to ${fmtEur(nextLiq)} (plan ≥ ${fmtEur(plan.minLiquidityCents)})`);
  }
  if (sopSlip > 21) reasons.push(nextSop ? `Eon SOP forecast slipped ${sopSlip} days to ${nextSop}` : 'Eon SOP can no longer be forecast (blocked)');
  if (!reasons.length) return [];
  const hit = Math.round(Math.min(10, 3 + reasons.length * 2) * difficultyOf(w).reactionScale);
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
  inbox(w, { kind: 'board', fromId: 'CHR-DUBREUIL', subject: 'The latest forecast', body: `I have read the revised forecast: ${reasons.join('; ')}. The board needs to understand what changed, what you are doing about it, and what it means for liquidity and the refinancing. Please bring a recovery plan to our meeting on ${meeting} — put it to the board at least 7 days before (Decisions → Board → Put a plan to the board), ideally containing the corrective decisions themselves. I would rather hear bad news early than late.`, priority: 'urgent', linked: [] });
  return reasons;
}

export function proposalActionIds(p: BoardProposal): string[] {
  return p.actionIds?.length ? p.actionIds : p.actionId ? [p.actionId] : [];
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
    const ids = proposalActionIds(p);
    minutes.push(`• ${p.title}: ${approved ? 'APPROVED' : 'REJECTED'} (${p.outcomeNote})${ids.length ? (approved ? ` — ${ids.length > 1 ? `its ${ids.length} decisions are` : 'the decision is'} carried out today; anything not yet possible waits under Decisions → In progress.` : ' — nothing will be carried out.') : ' — endorsement only; no decision attached.'}`);
    for (const v of votes.filter((x) => x.vote !== 'for')) minutes.push(`    ${byId(w.characters, v.memberId)?.name}: ${v.vote}. ${v.reason}`);
    for (const v of votes) remember(w, { characterId: v.memberId, kind: 'decision', summary: `Voted ${v.vote} on "${p.title}". ${v.reason}`, importance: 3, sentiment: v.vote === 'for' ? 1 : v.vote === 'against' ? -1 : 0, sourceType: 'board_proposal', sourceId: p.id, entityRefs: [{ type: 'board_proposal', id: p.id }] });
    emit(w, { type: approved ? 'board_approved' : 'board_rejected', category: 'board', severity: approved ? 'notice' : 'warning', title: `Board ${approved ? 'approves' : 'rejects'}: ${p.title}`, description: `${p.outcomeNote} ${votes.filter((v) => v.vote === 'against').map((v) => `${byId(w.characters, v.memberId)?.name}: ${v.reason}`).join(' ')}`.trim(), causeKind: 'causal', cause: { text: 'Board vote.', refs: [{ type: 'board_proposal', id: p.id }] }, entities: [{ type: 'board_proposal', id: p.id }], actionId: p.actionId });
    if (approved) {
      res.approved.push(p);
      for (const id of ids) w.out.approvedActions.push({ actionId: id, proposalId: p.id });
      if (!ids.length) w.meta.boardConfidence = clamp(w.meta.boardConfidence + 3, 0, 100);
    } else {
      res.rejected.push(p);
      for (const id of ids) w.out.actionUpdates.push({ actionId: id, status: 'rejected', note: `Rejected by the board on ${d}: ${p.outcomeNote}` });
      if (!ids.length) w.meta.boardConfidence = clamp(w.meta.boardConfidence - 3, 0, 100);
    }
  }
  // Performance review and confidence update (regular meetings only)
  if (!extraordinary) {
    const { target, factors } = confidenceTarget(w);
    const before = w.meta.boardConfidence;
    const dset = difficultyOf(w);
    w.meta.boardConfidence = Math.round(clamp(before + (target - before) * dset.meetingPull, 0, 100) * 10) / 10;
    minutes.push(`Performance review — board confidence ${before.toFixed(0)} → ${w.meta.boardConfidence.toFixed(0)}. Drivers: ${factors.filter((x) => Math.abs(x.delta) >= 1).map((x) => `${x.label} (${x.delta > 0 ? '+' : ''}${x.delta.toFixed(0)})`).join(', ') || 'none material'}.`);
    if (w.meta.boardConfidence < dset.dismissalThreshold) {
      w.meta.lowConfidenceMeetings += 1;
      if (w.meta.lowConfidenceMeetings >= dset.dismissalMeetings) {
        w.meta.status = 'dismissed';
        w.meta.terminalReason = `The board removed you as CEO on ${d} after confidence stayed below ${dset.dismissalThreshold} for ${w.meta.lowConfidenceMeetings} consecutive meetings.`;
        emit(w, { type: 'ceo_dismissed', category: 'board', severity: 'critical', title: 'The board has dismissed the CEO', description: w.meta.terminalReason, causeKind: 'causal' });
      } else {
        const left = dset.dismissalMeetings - w.meta.lowConfidenceMeetings;
        minutes.push(`The chair warned that the board will consider a change of leadership if confidence is still below ${dset.dismissalThreshold} at ${left === 1 ? 'the next meeting' : `the next ${left} meetings`}.`);
        emit(w, { type: 'board_warning', category: 'board', severity: 'critical', title: 'Board warns the CEO', description: `Board confidence is ${w.meta.boardConfidence.toFixed(0)}/100. ${left === 1 ? 'Another meeting' : `${left} more meetings in a row`} below ${dset.dismissalThreshold} will lead to your dismissal. Ask the Coach (? Guide) what moves confidence fastest.`, causeKind: 'causal' });
      }
    } else {
      // Strikes are consecutive: any meeting at or above the threshold clears them.
      w.meta.lowConfidenceMeetings = 0;
    }
    w.meta.nextBoardMeeting = nextRegularMeeting(d);
  }
  if (extraordinary) w.meta.extraordinaryMeeting = null;
  inbox(w, { kind: 'board', fromId: 'CHR-DUBREUIL', subject: `${extraordinary ? 'Extraordinary b' : 'B'}oard meeting — minutes ${d}`, body: minutes.length ? minutes.join('\n') : 'No proposals were tabled.', priority: 'high', linked: agenda.map((p) => ({ type: 'board_proposal' as const, id: p.id })) });
  emit(w, { type: 'board_meeting', category: 'board', severity: 'info', title: `${extraordinary ? 'Extraordinary b' : 'B'}oard meeting held`, description: minutes.join(' '), causeKind: 'scheduled' });
  return res;
}
