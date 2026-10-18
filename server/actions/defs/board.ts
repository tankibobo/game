import { z } from 'zod';
import { addDays, diffDays, isSimDate } from '../../../shared/dates';
import { meetingForSubmission } from '../../engine/board';
import { liquidity, netLeverage } from '../../engine/metrics';
import { RULES } from '../../engine/params';
import { adjustTrust, emit, nextId } from '../../engine/world';
import { ok, type ActionDef } from '../types';

export const issueBoardProposal: ActionDef<{ title: string; kind: 'strategy' | 'recovery_plan' | 'other'; rationale: string; evAlignment?: number; growth?: number }> = {
  type: 'issue_board_proposal',
  label: 'Table a board proposal',
  description: 'Put a strategy, recovery plan or other resolution to the board for the next meeting (submitted ≥7 days before). Proposals that require board approval for a specific action are created automatically.',
  llmProposable: true,
  schema: z.object({ title: z.string().min(5).max(160), kind: z.enum(['strategy', 'recovery_plan', 'other']), rationale: z.string().min(20).max(4000), evAlignment: z.number().min(-1).max(1).optional(), growth: z.number().min(-1).max(1).optional() }),
  validate: (w, p) => {
    if (w.boardProposals.some((b) => b.status === 'scheduled' && b.title.toLowerCase() === p.title.toLowerCase())) return { errors: ['An identical proposal is already on the agenda.'], warnings: [] };
    return ok();
  },
  preview: (w, p) => ({ summary: `Board proposal: ${p.title}`, consequences: [{ label: `Will be voted at the meeting on ${meetingForSubmission(w)}. Approval raises board confidence; rejection lowers it.`, kind: 'approval' }], approvals: [] }),
  commit: (w, p, ctx) => {
    const id = nextId(w, 'BP');
    const fc = w.meta.lastForecastSummary;
    w.boardProposals.push({
      id, title: p.title, kind: p.kind, actionId: null, summary: p.title, rationale: p.rationale,
      analysis: { cashImpactCents: 0, minLiquidityAfterCents: fc?.minLiquidityCents ?? liquidity(w), leverageAfter: netLeverage(w), annualProfitImpactCents: 0, jobsImpact: 0, ev: p.evAlignment ?? 0, growth: p.growth ?? 0, dilutionPct: 0, risk: 0.2, cfoSupport: 0.3 },
      submittedDate: w.meta.currentDate, meetingDate: meetingForSubmission(w), status: 'scheduled', votes: [], decidedDate: null, outcomeNote: null,
    });
    emit(w, { type: 'board_proposal_tabled', category: 'board', severity: 'info', title: `Board proposal tabled: ${p.title}`, description: `For the meeting on ${meetingForSubmission(w)}.`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'board_proposal', id }] });
    return { summary: 'Proposal tabled', details: [id], result: { proposalId: id } };
  },
};

export const callBoardMeeting: ActionDef<{ date: string; reason: string }> = {
  type: 'call_board_meeting',
  label: 'Call an extraordinary board meeting',
  description: 'Convene the board before the next regular meeting (at least 7 days’ notice).',
  llmProposable: true,
  schema: z.object({ date: z.string(), reason: z.string().min(5).max(500) }),
  validate: (w, p) => {
    const v = ok();
    if (!isSimDate(p.date)) return { errors: ['Date must be YYYY-MM-DD.'], warnings: [] };
    if (p.date < addDays(w.meta.currentDate, RULES.extraordinaryMeetingNoticeDays)) v.errors.push(`At least ${RULES.extraordinaryMeetingNoticeDays} days’ notice is required.`);
    if (p.date >= w.meta.nextBoardMeeting) v.errors.push(`The next regular meeting is on ${w.meta.nextBoardMeeting}.`);
    if (w.meta.extraordinaryMeeting) v.errors.push(`An extraordinary meeting is already convened for ${w.meta.extraordinaryMeeting}.`);
    if (diffDays(w.meta.nextBoardMeeting, p.date) < 21) v.warnings.push('So close to a regular meeting, the chair may see this as poor planning.');
    return v;
  },
  preview: (_w, p) => ({ summary: `Extraordinary board meeting on ${p.date}`, consequences: [{ label: 'Proposals submitted ≥7 days before will be voted then.', kind: 'approval' }], approvals: [] }),
  commit: (w, p, ctx) => {
    w.meta.extraordinaryMeeting = p.date;
    if (diffDays(w.meta.nextBoardMeeting, p.date) < 21) adjustTrust(w, 'CHR-DUBREUIL', -2);
    emit(w, { type: 'board_meeting_called', category: 'board', severity: 'info', title: `Extraordinary board meeting convened for ${p.date}`, description: p.reason, causeKind: 'player_action', source: 'action', actionId: ctx.actionId });
    return { summary: 'Meeting convened', details: [] };
  },
};
