import { z } from 'zod';
import { addDays, diffDays, isSimDate } from '../../../shared/dates';
import { meetingForSubmission } from '../../engine/board';
import { liquidity, netLeverage } from '../../engine/metrics';
import { RULES } from '../../engine/params';
import { adjustTrust, emit, nextId } from '../../engine/world';
import type { Consequence } from '../../../shared/domain';
import { ok, type ActionDef } from '../types';

export interface BoardPlanPayload {
  title: string;
  kind: 'strategy' | 'recovery_plan' | 'other';
  rationale: string;
  evAlignment?: number;
  growth?: number;
  /** Drafted decisions (actions awaiting your confirmation) carried out automatically if the board approves. */
  actionIds?: string[];
  /** Server-computed: combined analysis and labels of the included decisions. */
  packageAnalysis?: Record<string, number>;
  packageItems?: { id: string; summary: string }[];
}

export const issueBoardProposal: ActionDef<BoardPlanPayload> = {
  type: 'issue_board_proposal',
  label: 'Put a plan to the board',
  description: 'Put a plan or strategy to the board at the next meeting (submitted ≥7 days before). Include drafted decisions (actionIds of actions awaiting confirmation) to have them carried out automatically if the board approves; without them the vote is an endorsement only and changes nothing by itself. Single decisions that need the board are submitted automatically when confirmed — no plan needed.',
  llmProposable: true,
  schema: z.object({ title: z.string().min(5).max(160), kind: z.enum(['strategy', 'recovery_plan', 'other']), rationale: z.string().min(20).max(4000), evAlignment: z.number().min(-1).max(1).optional(), growth: z.number().min(-1).max(1).optional(), actionIds: z.array(z.string()).max(8).optional() }),
  validate: (w, p) => {
    if (w.boardProposals.some((b) => b.status === 'scheduled' && b.title.toLowerCase() === p.title.toLowerCase())) return { errors: ['An identical proposal is already on the agenda.'], warnings: [] };
    const v = ok();
    if (!p.actionIds?.length) v.warnings.push('Endorsement only: this plan contains no concrete decisions, so approval will not start, fund or change anything. Prepare the decisions first (they appear as drafts) and include them if you want the board vote to put them into effect.');
    return v;
  },
  preview: (w, p) => {
    const meeting = meetingForSubmission(w);
    const items = p.packageItems ?? [];
    const consequences: Consequence[] = items.length
      ? [
          { label: `Voted at the board meeting on ${meeting}. If approved, these ${items.length} decision${items.length > 1 ? 's are' : ' is'} carried out the same day:`, kind: 'approval' },
          ...items.map((i) => ({ label: `• ${i.summary} (${i.id})`, kind: 'info' as const })),
          { label: 'If rejected, none of them happen; you can revise and resubmit.', kind: 'info' },
        ]
      : [
          { label: `Voted at the board meeting on ${meeting}.`, kind: 'approval' },
          { label: 'Endorsement only — nothing starts, is funded or changes when the board approves. Approval: board confidence +3. Rejection: −3.', kind: 'risk' },
        ];
    const financing = Number(p.packageAnalysis?.containsFinancing ?? 0) === 1;
    const asked = w.commitments.filter((c) => ['open', 'due'].includes(c.status) && c.check.type === 'deliver_plan' && c.promiseeId === 'CHR-DUBREUIL' && (c.check.topic === 'recovery' || (c.check.topic === 'refinancing' && financing)));
    for (const c of asked) consequences.push({ label: `Counts towards the chair’s request: “${c.description}”`, kind: 'people' });
    return { summary: `Board plan: ${p.title}`, consequences, approvals: [] };
  },
  commit: (w, p, ctx) => {
    const id = nextId(w, 'BP');
    const fc = w.meta.lastForecastSummary;
    const pkg = p.packageAnalysis;
    const analysis = pkg
      ? { ...pkg }
      : { cashImpactCents: 0, minLiquidityAfterCents: fc?.minLiquidityCents ?? liquidity(w), leverageAfter: netLeverage(w), annualProfitImpactCents: 0, jobsImpact: 0, ev: p.evAlignment ?? 0, growth: p.growth ?? 0, dilutionPct: 0, risk: 0.1, cfoSupport: 0.3, necessity: w.commitments.some((c) => ['open', 'due'].includes(c.status) && c.check.type === 'deliver_plan' && c.promiseeId === 'CHR-DUBREUIL' && c.check.topic === 'recovery') ? 0.6 : 0 };
    const meeting = meetingForSubmission(w);
    w.boardProposals.push({
      id, title: p.title, kind: p.kind, actionId: null, actionIds: p.actionIds ?? [], summary: p.title, rationale: p.rationale,
      analysis, submittedDate: w.meta.currentDate, meetingDate: meeting, status: 'scheduled', votes: [], decidedDate: null, outcomeNote: null,
    });
    emit(w, { type: 'board_proposal_tabled', category: 'board', severity: 'info', title: `Board plan tabled: ${p.title}`, description: `For the meeting on ${meeting}. ${p.actionIds?.length ? `Carries ${p.actionIds.length} decision(s) that take effect if approved.` : 'Endorsement only.'}`, causeKind: 'player_action', source: 'action', actionId: ctx.actionId, entities: [{ type: 'board_proposal', id }] });
    return { summary: `Plan tabled for ${meeting}`, details: [id], result: { proposalId: id } };
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
