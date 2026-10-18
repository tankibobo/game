/**
 * The registry of every state-changing action. Nothing — not the UI, not an
 * LLM character — can change authoritative state except through one of these
 * typed, validated definitions.
 */
import { fmtEur } from '../../shared/money';
import type { World } from '../engine/world';
import { byId } from '../engine/world';
import { RULES } from '../engine/params';
import { callBoardMeeting, issueBoardProposal } from './defs/board';
import { negotiateContract, openNegotiation, signContract } from './defs/deals';
import { acceptFinancing, declineFinancing, requestFinancing } from './defs/finance';
import { adjustProduction, changePrice, scheduleDowntime, setMarketingBudget } from './defs/operations';
import { hireStaff, makePromise, resolveCommitmentAction, restructureWorkforce } from './defs/people';
import { addressIssue, approveProject, cancelProject, changeProjectScope, proposeBudget, startProject } from './defs/projects';
import type { ActionDef, ApprovalRequirement, Preview } from './types';

export const ACTIONS: ActionDef[] = [
  changePrice,
  adjustProduction,
  scheduleDowntime,
  setMarketingBudget,
  hireStaff,
  restructureWorkforce,
  makePromise,
  resolveCommitmentAction,
  approveProject,
  startProject,
  changeProjectScope,
  proposeBudget,
  cancelProject,
  addressIssue,
  requestFinancing,
  acceptFinancing,
  declineFinancing,
  openNegotiation,
  negotiateContract,
  signContract,
  issueBoardProposal,
  callBoardMeeting,
];

export const ACTION_BY_TYPE = new Map(ACTIONS.map((a) => [a.type, a]));

/** Special action types handled by the service rather than a definition. */
export const SERVICE_ACTIONS = ['advance_time', 'approve_budget'];

export function blockingApprovals(preview: Preview): ApprovalRequirement[] {
  return preview.approvals.filter((a) => !a.informational && a.approver === 'board');
}

/**
 * Authority check: may `approverId` commit this action (as opposed to merely
 * proposing it)? The CEO may commit anything that does not need the board;
 * other characters only within their `authority` (action types + limits).
 */
export function checkAuthority(w: World, def: ActionDef, payload: unknown, approverId: string, preview: Preview): { allowed: boolean; reason: string } {
  const board = blockingApprovals(preview);
  const amount = def.amountCents ? def.amountCents(w, payload) : 0;
  if (approverId === 'ceo') {
    if (board.length) return { allowed: false, reason: `Requires board approval: ${board.map((b) => b.reason).join(' ')}` };
    return { allowed: true, reason: 'Within CEO authority.' };
  }
  const c = byId(w.characters, approverId);
  if (!c || !c.active) return { allowed: false, reason: `${approverId} is not an active member of the organisation.` };
  if (c.org !== 'asterion') return { allowed: false, reason: `${c.name} (${c.orgName}) has no authority over Asterion decisions.` };
  if (board.length) return { allowed: false, reason: `${c.name} cannot approve this: it requires board approval.` };
  if (!c.authority.canApprove.includes(def.type)) return { allowed: false, reason: `${c.name} (${c.title}) is not authorised to approve “${def.label}”. ${c.authority.notes}` };
  const limit = def.financing ? c.authority.financingLimitCents : c.authority.spendLimitCents;
  if (amount > limit) return { allowed: false, reason: `${c.name}'s approval limit is ${fmtEur(limit)}; this commits ${fmtEur(amount)}. Escalate to the CEO${amount > RULES.ceoSpendLimitCents ? ' and the board' : ''}.` };
  return { allowed: true, reason: `Within ${c.name}'s delegated authority.` };
}

export function actionCatalogForLlm(): { type: string; description: string; schema: string }[] {
  return ACTIONS.filter((a) => a.llmProposable).map((a) => ({ type: a.type, description: a.description, schema: describeSchema(a) }));
}

function describeSchema(a: ActionDef): string {
  const S: Record<string, string> = {
    change_price: '{ modelId, netPriceCents (integer cents), reason? }',
    adjust_production: '{ lineId, plannedDailyRate (integer), reason? }',
    schedule_downtime: '{ factoryId, startDate (YYYY-MM-DD), endDate, reason }',
    set_marketing_budget: '{ monthlyCents, reason? }',
    hire_staff: '{ departmentId, headcount, reason? }',
    restructure_workforce: "{ departmentId, reduction, mode: 'voluntary'|'compulsory', severancePerHeadCents?, reason? }",
    make_promise: "{ promiseeId, description, dueDate? (YYYY-MM-DD), conditions?, importance? (1-5), check? ({type:'freeform'} | {type:'milestone_completed_by', milestoneId} | {type:'project_completed_by', projectId} | {type:'no_headcount_reduction', departmentIds} | {type:'min_liquidity', amountCents} | {type:'price_floor', modelId, minNetPriceCents}) }",
    approve_project: '{ projectId }',
    start_project: '{ templateKey }',
    change_project_scope: '{ projectId, newTargetDate?, staffingDelta?, budgetDeltaCents?, descopePct? (0-0.3), reason }',
    propose_budget: '{ projectId, amountCents, reason }',
    cancel_project: '{ projectId, reason }',
    address_issue: '{ issueId, optionKey }',
    request_financing: "{ kind: 'rcf_draw'|'rcf_repay'|'bank_term_loan'|'bond'|'rights_issue'|'shareholder_loan'|'ceo_contribution'|'sale_leaseback'|'covenant_waiver', amountCents, tenorYears?, rationale }",
    accept_financing: '{ financingId }',
    open_negotiation: '{ templateKey }',
    negotiate_contract: '{ negotiationId, terms: { termKey: number }, message }',
    sign_contract: '{ contractId }',
    issue_board_proposal: "{ title, kind: 'strategy'|'recovery_plan'|'other', rationale }",
    call_board_meeting: '{ date, reason }',
  };
  return S[a.type] ?? '{}';
}
