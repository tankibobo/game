/**
 * Game service: the only code path that mutates a save file.
 *
 *  propose → (validate, authority, preview) → pending_confirmation
 *  confirm → re-validate → board? → pending_approval (board proposal created)
 *                       → commit atomically (world + action + ledger + events)
 *  reject / modify (supersede)
 *
 * Every consequential call accepts an idempotency key; a retried request
 * returns the original result instead of applying the action twice.
 */
import { randomUUID } from 'node:crypto';
import type { ActionRecord, BoardProposal } from '../../shared/domain';
import type { DB } from '../db/connection';
import { initGame, loadWorld, rowToAction, writeWorld } from '../db/repo';
import { meetingForSubmission, predictVote, proposalActionIds, reactToForecast, type ProposalAnalysis, type VoteOutlook } from '../engine/board';
import { buildBriefing } from '../engine/briefing';
import { buildForecast } from '../engine/forecast';
import { cash } from '../engine/ledger';
import { engineeringFreeFte, liquidity, netLeverage } from '../engine/metrics';
import { updateProjectForecasts } from '../engine/projects';
import { advanceDays } from '../engine/tick';
import { byId, emit, inbox, nextId, type World } from '../engine/world';
import { templateByKey } from '../actions/templates';
import { addDays } from '../../shared/dates';
import { fmtEur } from '../../shared/money';
import { ACTION_BY_TYPE, blockingApprovals, checkAuthority } from '../actions/registry';
import type { ActionDef } from '../actions/types';
import { DEFAULT_SEED, buildInitialWorld } from '../scenario/initial';
import { addIntroInbox } from '../scenario/intro';

export class GameError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- new game & forecasts

export function refreshForecast(w: World, trigger: string): void {
  const fc = buildForecast(w, trigger);
  w.out.forecasts.push(fc);
  const base = fc.data.scenarios.find((s) => s.key === 'base')!.summary;
  const prev = w.meta.lastForecastSummary;
  w.meta.lastForecastSummary = base;
  w.meta.forecastStale = 0;
  reactToForecast(w, prev, base);
}

export function createNewGame(db: DB, seed = DEFAULT_SEED): World {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='game_meta'").get();
  if (has && db.prepare('SELECT COUNT(*) AS n FROM game_meta').get() && (db.prepare('SELECT COUNT(*) AS n FROM game_meta').get() as { n: number }).n > 0) throw new GameError('This save already contains a game.');
  const w = buildInitialWorld(seed);
  updateProjectForecasts(w);
  addIntroInbox(w);
  emit(w, { type: 'game_started', category: 'system', severity: 'info', title: 'You take office as CEO of Asterion Automotive', description: 'Opening position: cash €1.2bn, debt €2.4bn, Eon programme delayed, wage agreement expiring 31 March.', causeKind: 'system', source: 'scenario' });
  refreshForecast(w, 'new_game');
  initGame(db, w);
  return w;
}

// ---------------------------------------------------------------- action records

function insertAction(db: DB, a: ActionRecord): void {
  db.prepare(`INSERT INTO actions (id, idempotency_key, type, actor_id, source, payload, status, sim_date, created_at, updated_at, summary, errors, warnings, consequences, approvals, result, conversation_id, rationale, superseded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(a.id, a.idempotencyKey, a.type, a.actorId, a.source, JSON.stringify(a.payload), a.status, a.simDate, a.createdAt, a.updatedAt, a.summary, JSON.stringify(a.errors), JSON.stringify(a.warnings), JSON.stringify(a.consequences), JSON.stringify(a.approvals), a.result ? JSON.stringify(a.result) : null, a.conversationId, a.rationale, a.supersededBy);
}

function updateAction(db: DB, id: string, patch: Partial<ActionRecord>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = { status: 'status', summary: 'summary', errors: 'errors', warnings: 'warnings', consequences: 'consequences', approvals: 'approvals', result: 'result', supersededBy: 'superseded_by' };
  for (const [k, col] of Object.entries(map)) {
    if (!(k in patch)) continue;
    const v = (patch as Record<string, unknown>)[k];
    sets.push(`${col} = ?`);
    vals.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  }
  sets.push('updated_at = ?');
  vals.push(nowIso());
  db.prepare(`UPDATE actions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

export function getAction(db: DB, id: string): ActionRecord {
  const r = db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) throw new GameError(`Action ${id} not found`, 404);
  return rowToAction(r);
}

function findByKey(db: DB, key: string): ActionRecord | null {
  const r = db.prepare('SELECT * FROM actions WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
  return r ? rowToAction(r) : null;
}

// ---------------------------------------------------------------- propose

export interface ProposeInput {
  type: string;
  payload: unknown;
  actorId?: string;
  source?: ActionRecord['source'];
  conversationId?: string | null;
  idempotencyKey?: string;
  rationale?: string | null;
  /** Fields computed by the server (e.g. assessed argument quality) merged after client fields are stripped. */
  serverPayload?: Record<string, unknown>;
}

export function proposeAction(db: DB, input: ProposeInput, preloaded?: World): ActionRecord {
  const key = input.idempotencyKey ?? randomUUID();
  const existing = findByKey(db, key);
  if (existing) return existing;
  const actorId = input.actorId ?? 'ceo';
  const w = preloaded ?? loadWorld(db);
  const base: ActionRecord = {
    id: `ACT-${randomUUID().slice(0, 8)}`,
    idempotencyKey: key,
    type: input.type,
    actorId,
    source: input.source ?? 'player',
    payload: (input.payload ?? {}) as Record<string, unknown>,
    status: 'pending_confirmation',
    simDate: w.meta.currentDate,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    summary: input.type,
    errors: [],
    warnings: [],
    consequences: [],
    approvals: [],
    result: null,
    conversationId: input.conversationId ?? null,
    rationale: input.rationale ?? null,
    supersededBy: null,
  };
  if (input.type === 'approve_budget') {
    const target = typeof (input.payload as { actionId?: unknown })?.actionId === 'string' ? String((input.payload as { actionId: string }).actionId) : '';
    const t = target ? (db.prepare('SELECT * FROM actions WHERE id = ?').get(target) as Record<string, unknown> | undefined) : undefined;
    base.summary = `Approve pending action ${target}`;
    if (!t) base.errors = [`Unknown action ${target || '(missing actionId)'}.`];
    else if (t.status !== 'pending_confirmation') base.errors = [`Action ${target} is ${String(t.status)}, not awaiting approval.`];
    if (base.errors.length) base.status = 'invalid';
    insertAction(db, base);
    return base;
  }
  const def = ACTION_BY_TYPE.get(input.type);
  if (!def) {
    base.status = 'invalid';
    base.errors = [`Unknown action type "${input.type}". Allowed: ${[...ACTION_BY_TYPE.keys()].join(', ')}.`];
    insertAction(db, base);
    return base;
  }
  if (w.meta.status !== 'active') {
    base.status = 'invalid';
    base.errors = [`The game is over: ${w.meta.terminalReason}`];
    insertAction(db, base);
    return base;
  }
  const parsed = def.schema.safeParse(input.payload ?? {});
  if (!parsed.success) {
    base.status = 'invalid';
    base.summary = def.label;
    base.errors = parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`);
    insertAction(db, base);
    return base;
  }
  const payload = parsed.data as Record<string, unknown>;
  // The argument-quality modifier for negotiations is computed server-side only.
  if (def.type === 'negotiate_contract') delete payload.argumentQuality;
  Object.assign(payload, input.serverPayload ?? {});
  if (def.type === 'issue_board_proposal') {
    const pkg = buildPackage(db, w, (payload.actionIds as string[] | undefined) ?? []);
    delete payload.packageAnalysis;
    delete payload.packageItems;
    if (pkg.errors.length) {
      base.payload = payload;
      base.status = 'invalid';
      base.summary = def.label;
      base.errors = pkg.errors;
      insertAction(db, base);
      return base;
    }
    if (pkg.items.length) Object.assign(payload, { packageAnalysis: pkg.analysis, packageItems: pkg.items });
    base.warnings.push(...pkg.warnings);
  }
  base.payload = payload;
  const v = safe(() => def.validate(w, payload, actorId), (e) => ({ errors: [String(e)], warnings: [] }));
  base.errors = v.errors;
  base.warnings = [...base.warnings, ...v.warnings];
  base.summary = def.label;
  if (v.errors.length === 0) {
    const ew = engineerWarning(db, w, engineersNeeded(w, def.type, payload));
    if (ew) base.warnings.push(ew);
    const pv = safe(() => def.preview(w, payload), (e) => ({ summary: def.label, consequences: [{ label: `Preview unavailable: ${String(e)}`, kind: 'info' as const }], approvals: [] }));
    base.summary = pv.summary;
    base.consequences = pv.consequences;
    base.approvals = pv.approvals.map((a) => ({ approver: a.approver, kind: a.informational ? 'process' : 'required', status: 'required', ref: a.approverId ?? null, note: a.reason }));
  } else base.status = 'invalid';
  insertAction(db, base);
  return base;
}

function safe<T>(fn: () => T, onErr: (e: unknown) => T): T {
  try {
    return fn();
  } catch (e) {
    return onErr(e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------- engineers claimed by decisions in flight

/** Engineers a decision would take from the free pool. */
function engineersNeeded(w: World, type: string, payload: Record<string, unknown>): number {
  if (type === 'start_project') return templateByKey(String(payload.templateKey ?? ''))?.fte ?? 0;
  if (type === 'approve_project') return Math.round(byId(w.projects, String(payload.projectId ?? ''))?.staffingFte ?? 0);
  if (type === 'change_project_scope') return Math.max(0, Math.round(Number(payload.staffingDelta ?? 0)));
  return 0;
}

/** Decisions already waiting for (or approved by) the board that will need engineers when carried out. */
function engineerClaims(db: DB, w: World, exclude: string[] = []): { total: number; items: string[] } {
  const rows = (db.prepare("SELECT * FROM actions WHERE status IN ('pending_approval','approved') AND type IN ('start_project','approve_project','change_project_scope')").all() as Record<string, unknown>[]).map(rowToAction).filter((a) => !exclude.includes(a.id));
  const items: string[] = [];
  let total = 0;
  for (const a of rows) {
    const n = engineersNeeded(w, a.type, a.payload);
    if (n > 0) {
      total += n;
      items.push(`${a.summary} (${n})`);
    }
  }
  return { total, items };
}

function engineerWarning(db: DB, w: World, need: number, exclude: string[] = []): string | null {
  if (need <= 0) return null;
  const free = Math.max(0, Math.floor(engineeringFreeFte(w)));
  const claims = engineerClaims(db, w, exclude);
  if (claims.total + need <= free) return null;
  return claims.total > 0
    ? `Engineers: this needs ${need}, and decisions already waiting for the board need ${claims.total} (${claims.items.join('; ')}) — ${need + claims.total} in total, but only ${free} are free. Whatever is carried out last will wait until engineers are free (hire engineers or release them from another project).`
    : `Engineers: this needs ${need}, but only ${free} are free.`;
}

// ---------------------------------------------------------------- board plans (packages)

/** Action types that cannot be bundled into a board plan. */
const NOT_PACKAGEABLE = new Set(['issue_board_proposal', 'call_board_meeting', 'approve_budget', 'advance_time', 'negotiate_contract', 'make_promise', 'resolve_commitment']);

/** Check the drafted decisions included in a board plan and combine their analyses. */
export function buildPackage(db: DB, w: World, ids: string[]): { errors: string[]; warnings: string[]; items: { id: string; summary: string }[]; analysis: Record<string, number> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let engineers = 0;
  const items: { id: string; summary: string }[] = [];
  const parts: ProposalAnalysis[] = [];
  let financing = false;
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const r = db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) {
      errors.push(`Unknown decision ${id}.`);
      continue;
    }
    const a = rowToAction(r);
    if (a.status !== 'pending_confirmation') {
      errors.push(`${a.summary} (${id}) is ${a.status.replace('_', ' ')}; only drafts awaiting your confirmation can be included.`);
      continue;
    }
    if (NOT_PACKAGEABLE.has(a.type)) {
      errors.push(`${a.summary} cannot be part of a board plan.`);
      continue;
    }
    const def = ACTION_BY_TYPE.get(a.type)!;
    const v = def.validate(w, a.payload, a.actorId);
    if (v.errors.length) {
      errors.push(`${a.summary} is no longer valid: ${v.errors.join(' ')}`);
      continue;
    }
    items.push({ id, summary: a.summary });
    engineers += engineersNeeded(w, a.type, a.payload);
    if (a.type === 'request_financing' && ['bank_term_loan', 'bond', 'rights_issue', 'sale_leaseback', 'shareholder_loan'].includes(String(a.payload.kind))) financing = true;
    parts.push(def.boardAnalysis ? def.boardAnalysis(w, a.payload) : { ...defaultAnalysis(w), cashImpactCents: -(def.amountCents?.(w, a.payload) ?? 0), risk: 0.15 });
  }
  const sum = (k: keyof ProposalAnalysis) => parts.reduce((x, p) => x + (Number(p[k]) || 0), 0);
  const max = (k: keyof ProposalAnalysis) => parts.reduce((x, p) => Math.max(x, Number(p[k]) || 0), 0);
  const avg = (k: keyof ProposalAnalysis) => (parts.length ? sum(k) / parts.length : 0);
  const analysis: Record<string, number> = parts.length
    ? {
        cashImpactCents: Math.round(sum('cashImpactCents')),
        minLiquidityAfterCents: (w.meta.lastForecastSummary?.minLiquidityCents ?? liquidity(w)) + Math.round(sum('cashImpactCents')),
        leverageAfter: max('leverageAfter'),
        annualProfitImpactCents: Math.round(sum('annualProfitImpactCents')),
        jobsImpact: Math.round(sum('jobsImpact')),
        ev: Math.max(-1, Math.min(1, avg('ev') + 0.1 * Math.sign(max('ev')))),
        growth: Math.max(-1, Math.min(1, avg('growth'))),
        dilutionPct: sum('dilutionPct'),
        risk: Math.min(1, max('risk') + 0.05 * (parts.length - 1)),
        cfoSupport: avg('cfoSupport'),
        necessity: max('necessity'),
        containsFinancing: financing ? 1 : 0,
      }
    : {};
  const ew = engineerWarning(db, w, engineers, unique);
  if (ew) warnings.push(ew.replace('this needs', 'the decisions in this plan need'));
  return { errors, warnings, items, analysis };
}

// ---------------------------------------------------------------- confirm / approve

export interface ConfirmResult {
  action: ActionRecord;
  ok: boolean;
  message: string;
}

function defaultAnalysis(w: World): ProposalAnalysis {
  return { cashImpactCents: 0, minLiquidityAfterCents: w.meta.lastForecastSummary?.minLiquidityCents ?? liquidity(w), leverageAfter: netLeverage(w), annualProfitImpactCents: 0, jobsImpact: 0, ev: 0, growth: 0, dilutionPct: 0, risk: 0.3, cfoSupport: 0 };
}

export function confirmAction(db: DB, actionId: string, approverId = 'ceo', opts: { boardRationale?: string } = {}): ConfirmResult {
  const a = getAction(db, actionId);
  if (a.status === 'committed') return { action: a, ok: true, message: 'Already committed (idempotent).' };
  if (a.status === 'pending_approval') return { action: a, ok: true, message: 'Already awaiting board approval.' };
  if (a.status !== 'pending_confirmation') throw new GameError(`Action is ${a.status}; it cannot be confirmed.`);
  if (a.type === 'approve_budget') return approveBudgetAction(db, a, approverId);
  const def = ACTION_BY_TYPE.get(a.type)!;
  const w = loadWorld(db);
  if (a.type === 'issue_board_proposal') {
    const ids = (a.payload.actionIds as string[] | undefined) ?? [];
    const pkg = buildPackage(db, w, ids);
    if (pkg.errors.length) {
      updateAction(db, a.id, { status: 'invalid', errors: pkg.errors });
      return { action: getAction(db, a.id), ok: false, message: `The plan can no longer be tabled: ${pkg.errors.join(' ')}` };
    }
  }
  const v = def.validate(w, a.payload, a.actorId);
  if (v.errors.length) {
    updateAction(db, a.id, { status: 'invalid', errors: v.errors, warnings: v.warnings });
    return { action: getAction(db, a.id), ok: false, message: `No longer valid: ${v.errors.join(' ')}` };
  }
  const pv = def.preview(w, a.payload);
  const auth = checkAuthority(w, def, a.payload, approverId, pv);
  if (!auth.allowed) {
    if (approverId === 'ceo' && blockingApprovals(pv).length) return submitToBoard(db, w, a, def, opts.boardRationale);
    const approvals = [...a.approvals, { approver: approverId, kind: 'attempt', status: 'denied' as const, ref: approverId, note: auth.reason }];
    updateAction(db, a.id, { approvals });
    return { action: getAction(db, a.id), ok: false, message: auth.reason };
  }
  return commitNow(db, w, a, def, approverId);
}

function commitNow(db: DB, w: World, a: ActionRecord, def: ActionDef, approverId: string): ConfirmResult {
  try {
    let result: ReturnType<ActionDef['commit']> | null = null;
    db.transaction(() => {
      result = def.commit(w, a.payload, { actionId: a.id, approverId, actorId: a.actorId });
      if (def.affectsForecast) refreshForecast(w, `action:${a.type}`);
      writeWorld(db, w);
      updateAction(db, a.id, { status: 'committed', result: { ...(result as unknown as Record<string, unknown>), approvedBy: approverId, committedDate: w.meta.currentDate } });
      if (a.type === 'issue_board_proposal') {
        const proposalId = String((result as unknown as { result?: { proposalId?: string } })?.result?.proposalId ?? '');
        const meeting = w.boardProposals.find((b) => b.id === proposalId)?.meetingDate ?? '';
        for (const id of (a.payload.actionIds as string[] | undefined) ?? []) {
          const inc = getAction(db, id);
          updateAction(db, id, { status: 'pending_approval', approvals: [...inc.approvals.filter((x) => x.approver !== 'board'), { approver: 'board', kind: 'required', status: 'required', ref: proposalId, note: `Part of the board plan “${String(a.payload.title)}” (${proposalId}), voted on ${meeting}.` }] });
        }
      }
    })();
    const r = result as { summary: string; details?: string[] } | null;
    return { action: getAction(db, a.id), ok: true, message: r ? `Done: ${[r.summary, ...(r.details ?? []).filter((x) => !/^[A-Z]{2,4}-\d+$/.test(x))].join(' — ')}` : 'Done.' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    updateAction(db, a.id, { status: 'failed', errors: [...a.errors, `Commit failed and was rolled back: ${msg}`] });
    return { action: getAction(db, a.id), ok: false, message: `Commit failed (no changes were made): ${msg}` };
  }
}

function submitToBoard(db: DB, w: World, a: ActionRecord, def: ActionDef, rationale?: string): ConfirmResult {
  const proposal: BoardProposal = {
    id: nextId(w, 'BP'),
    title: a.summary,
    kind: a.type,
    actionId: a.id,
    actionIds: [a.id],
    summary: a.summary,
    rationale: rationale ?? a.rationale ?? '',
    analysis: { ...(def.boardAnalysis ? def.boardAnalysis(w, a.payload) : defaultAnalysis(w)) } as unknown as Record<string, number>,
    submittedDate: w.meta.currentDate,
    meetingDate: meetingForSubmission(w),
    status: 'scheduled',
    votes: [],
    decidedDate: null,
    outcomeNote: null,
  };
  w.boardProposals.push(proposal);
  emit(w, { type: 'board_proposal_submitted', category: 'board', severity: 'info', title: `Submitted to the board: ${a.summary}`, description: `To be voted on ${proposal.meetingDate}. Nothing happens until the board approves.`, causeKind: 'player_action', source: 'action', actionId: a.id, entities: [{ type: 'board_proposal', id: proposal.id }] });
  db.transaction(() => {
    writeWorld(db, w);
    updateAction(db, a.id, { status: 'pending_approval', approvals: [...a.approvals.map((x) => (x.approver === 'board' ? { ...x, ref: proposal.id } : x))] });
  })();
  return { action: getAction(db, a.id), ok: true, message: `Requires board approval — submitted for the meeting on ${proposal.meetingDate}.` };
}

/** `approve_budget`: a character (or the CEO) approves another pending action within their authority. */
function approveBudgetAction(db: DB, a: ActionRecord, approverId: string): ConfirmResult {
  const target = String((a.payload as { actionId?: string }).actionId ?? '');
  const res = confirmAction(db, target, a.actorId === 'ceo' ? approverId : a.actorId);
  updateAction(db, a.id, { status: res.ok ? 'committed' : 'rejected', result: { target, message: res.message } });
  return { action: getAction(db, a.id), ok: res.ok, message: res.message };
}

/** How long a board approval stays valid while the decision cannot be carried out yet. */
export const APPROVAL_VALID_DAYS = 90;

/**
 * Called from the tick when the board approves a proposal, and again for
 * approved decisions still waiting to be carried out. Returns true when the
 * decision was executed. If it is not possible yet (e.g. the engineers it
 * needs are busy), it stays "approved — waiting" with the reason, is retried
 * after every time advance and can be executed by hand from Decisions.
 */
export function commitApprovedOnWorld(db: DB, w: World, actionId: string, proposalId?: string): boolean {
  const r = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as Record<string, unknown> | undefined;
  if (!r) return false;
  const a = rowToAction(r);
  if (a.status !== 'pending_approval' && a.status !== 'approved') return false;
  const def = ACTION_BY_TYPE.get(a.type);
  if (!def) return false;
  const v = def.validate(w, a.payload, a.actorId);
  const prior = (a.result ?? {}) as { approvedDate?: string; proposalId?: string };
  const approvedDate = prior.approvedDate ?? w.meta.currentDate;
  if (v.errors.length) {
    if (a.status === 'pending_approval') {
      const until = addDays(approvedDate, APPROVAL_VALID_DAYS);
      w.out.actionUpdates.push({ actionId, status: 'approved', result: { approvedDate, proposalId: proposalId ?? prior.proposalId ?? null, blockedBy: v.errors, validUntil: until } });
      emit(w, { type: 'approved_action_waiting', category: 'board', severity: 'warning', title: `Approved by the board, not yet possible: ${a.summary}`, description: `${v.errors.join(' ')} It will be carried out automatically once this is fixed (approval valid until ${until}).`, causeKind: 'causal', actionId, entities: proposalId ? [{ type: 'board_proposal', id: proposalId }] : [] });
      inbox(w, { kind: 'warning', fromId: null, subject: `Board-approved, waiting: ${a.summary}`, body: `The board approved “${a.summary}”, but it cannot be carried out yet:\n• ${v.errors.join('\n• ')}\n\nWhat happens now: it is retried automatically every time you advance time and runs as soon as it becomes possible. You can also run it yourself from Decisions → In progress → “Execute now” after fixing the cause. The approval stays valid until ${until}; after that you would need to submit it again.`, priority: 'urgent', linked: [{ type: 'action', id: actionId }] });
    }
    return false;
  }
  const expected = def.boardAnalysis ? def.boardAnalysis(w, a.payload) : null;
  const res = def.commit(w, a.payload, { actionId, approverId: 'board', actorId: a.actorId });
  if (def.affectsForecast) w.meta.forecastStale = 1;
  if (expected) {
    w.out.boardApprovedImpact.cashCents += Math.max(0, -expected.cashImpactCents);
    w.out.boardApprovedImpact.ebitCents += Math.max(0, -expected.annualProfitImpactCents) + Math.round(Math.max(0, -expected.cashImpactCents) * 0.5);
  }
  w.out.actionUpdates.push({ actionId, status: 'committed', result: { ...res, approvedBy: 'board', approvedDate, committedDate: w.meta.currentDate } as unknown as Record<string, unknown> });
  emit(w, { type: 'approved_action_executed', category: 'board', severity: 'notice', title: `Board decision carried out: ${a.summary}`, description: [res.summary, ...res.details].filter(Boolean).join(' · '), causeKind: 'causal', actionId, entities: proposalId ? [{ type: 'board_proposal', id: proposalId }] : [] });
  inbox(w, { kind: 'report', fromId: null, subject: `Done: ${a.summary}`, body: `Approved by the board${approvedDate !== w.meta.currentDate ? ` on ${approvedDate}` : ''} and carried out on ${w.meta.currentDate}.\n${[res.summary, ...res.details].filter(Boolean).map((x) => `• ${x}`).join('\n')}`, priority: 'normal', linked: [{ type: 'action', id: actionId }] });
  return true;
}

/** Retry board-approved decisions that were waiting; expire stale approvals. Runs at the end of each time advance. */
function retryApproved(db: DB, w: World, waiting: ActionRecord[]): void {
  for (const a of waiting) {
    if (commitApprovedOnWorld(db, w, a.id)) continue;
    const res = (a.result ?? {}) as { approvedDate?: string };
    const until = addDays(res.approvedDate ?? a.simDate, APPROVAL_VALID_DAYS);
    if (w.meta.currentDate > until) {
      w.out.actionUpdates.push({ actionId: a.id, status: 'expired', note: `The board approval lapsed on ${until} because the decision could not be carried out.` });
      inbox(w, { kind: 'warning', fromId: null, subject: `Board approval lapsed: ${a.summary}`, body: `The approval for “${a.summary}” expired on ${until} because it could never be carried out. Prepare it again and resubmit it to the board if it is still needed.`, priority: 'high', linked: [{ type: 'action', id: a.id }] });
    }
  }
}

/** Execute a board-approved decision that was waiting, now (after the player fixed the cause). */
export function executeApproved(db: DB, actionId: string): ConfirmResult {
  const a = getAction(db, actionId);
  if (a.status === 'committed') return { action: a, ok: true, message: 'Already carried out.' };
  if (a.status !== 'approved') throw new GameError(`Only board-approved decisions that are waiting can be executed here (this one is ${a.status}).`);
  const w = loadWorld(db);
  if (w.meta.status !== 'active') throw new GameError(`The game is over: ${w.meta.terminalReason}`);
  const def = ACTION_BY_TYPE.get(a.type)!;
  const v = def.validate(w, a.payload, a.actorId);
  if (v.errors.length) return { action: a, ok: false, message: `Still not possible: ${v.errors.join(' ')}` };
  let ok = false;
  db.transaction(() => {
    ok = commitApprovedOnWorld(db, w, actionId);
    if (ok && w.meta.forecastStale) refreshForecast(w, `action:${a.type}`);
    writeWorld(db, w);
  })();
  return { action: getAction(db, actionId), ok, message: ok ? 'Carried out.' : 'Could not be carried out.' };
}

export function rejectAction(db: DB, actionId: string, reason = 'Rejected by the CEO'): ActionRecord {
  const a = getAction(db, actionId);
  if (a.status === 'pending_confirmation') {
    updateAction(db, a.id, { status: 'rejected', result: { reason } });
  } else if (a.status === 'pending_approval') {
    const w = loadWorld(db);
    const p = w.boardProposals.find((b) => b.actionId === a.id && b.status === 'scheduled');
    if (p) p.status = 'withdrawn';
    db.transaction(() => {
      writeWorld(db, w);
      updateAction(db, a.id, { status: 'cancelled', result: { reason: `Withdrawn from the board agenda: ${reason}` } });
    })();
  } else if (a.status === 'approved') {
    updateAction(db, a.id, { status: 'cancelled', result: { ...(a.result ?? {}), reason: `Not carried out: ${reason}` } });
  } else throw new GameError(`Action is ${a.status}; nothing to reject.`);
  return getAction(db, a.id);
}

export function modifyAction(db: DB, actionId: string, payload: unknown): ActionRecord {
  const a = getAction(db, actionId);
  if (a.status !== 'pending_confirmation' && a.status !== 'invalid') throw new GameError(`Only pending proposals can be modified (status ${a.status}).`);
  const n = proposeAction(db, { type: a.type, payload, actorId: a.actorId, source: a.source, conversationId: a.conversationId, rationale: a.rationale });
  updateAction(db, a.id, { status: 'superseded', supersededBy: n.id });
  return n;
}

/** Has the chair asked for a plan that this proposal would satisfy (recovery: any plan; refinancing: one with financing)? */
export function chairAskedForPlan(w: World, containsFinancing: boolean): boolean {
  return w.commitments.some((c) => ['open', 'due'].includes(c.status) && c.check.type === 'deliver_plan' && c.promiseeId === 'CHR-DUBREUIL' && (c.check.topic === 'recovery' || (c.check.topic === 'refinancing' && containsFinancing)));
}

// ---------------------------------------------------------------- client view of an action

export interface ActionView extends ActionRecord {
  /** When it took effect (board-approved decisions take effect on the meeting day). */
  effectiveDate: string;
  needsBoard: boolean;
  nextStep: string;
  boardOutlook: VoteOutlook | null;
  meetingDate: string | null;
}

/** An action plus plain-language "what happens next" and, for board items, the board's likely vote. */
export function actionView(db: DB, a: ActionRecord, preloaded?: World): ActionView {
  const w = preloaded ?? loadWorld(db);
  const def = ACTION_BY_TYPE.get(a.type);
  const needsBoard = a.approvals.some((x) => x.approver === 'board' && x.kind === 'required');
  const proposal = w.boardProposals.find((b) => proposalActionIds(b).includes(a.id) && b.status === 'scheduled') ?? (a.type === 'issue_board_proposal' ? w.boardProposals.find((b) => b.id === (a.result as { result?: { proposalId?: string } } | null)?.result?.proposalId) : undefined);
  let boardOutlook: VoteOutlook | null = null;
  let meetingDate: string | null = null;
  try {
    if (def && a.status === 'pending_confirmation' && needsBoard && def.boardAnalysis) boardOutlook = predictVote(w, def.boardAnalysis(w, a.payload), a.rationale ?? '');
    if (def && a.status === 'pending_confirmation' && a.type === 'issue_board_proposal') {
      const pkg = a.payload.packageAnalysis as Record<string, number> | undefined;
      const endorsement = { cashImpactCents: 0, minLiquidityAfterCents: 0, leverageAfter: 0, annualProfitImpactCents: 0, jobsImpact: 0, ev: Number(a.payload.evAlignment ?? 0), growth: Number(a.payload.growth ?? 0), dilutionPct: 0, risk: 0.1, cfoSupport: 0.3, necessity: chairAskedForPlan(w, false) ? 0.6 : 0 };
      boardOutlook = predictVote(w, pkg ?? endorsement, String(a.payload.rationale ?? ''));
    }
    if (proposal?.status === 'scheduled' && def && a.type !== 'issue_board_proposal') boardOutlook = predictVote(w, proposal.analysis as Record<string, number>, proposal.rationale);
  } catch {
    boardOutlook = null;
  }
  if (a.status === 'pending_confirmation' && (needsBoard || a.type === 'issue_board_proposal')) meetingDate = meetingForSubmission(w);
  if (proposal) meetingDate = proposal.meetingDate;
  const res = (a.result ?? {}) as { blockedBy?: string[]; validUntil?: string; approvedDate?: string; note?: string; summary?: string };
  let nextStep = '';
  switch (a.status) {
    case 'invalid':
      nextStep = 'Nothing will happen: the simulation rejected this decision for the reasons shown. Change the parameters (Modify) or choose something else.';
      break;
    case 'pending_confirmation':
      nextStep = a.type === 'issue_board_proposal'
        ? `“Put to the board” schedules it for the meeting on ${meetingDate}. ${(a.payload.actionIds as string[] | undefined)?.length ? 'If approved, the decisions it contains are carried out that day; if rejected, none of them happen.' : 'It contains no decisions, so even if approved nothing changes except board confidence.'}`
        : needsBoard
          ? `This is above your authority. “Submit to the board” puts it on the agenda for the meeting on ${meetingDate}. Nothing changes until then; if the board approves, it is carried out that day automatically. If it is rejected, nothing happens and you can revise it.`
          : '“Approve & execute” carries it out immediately. Effects with a date (arrivals, effective dates, payments) then happen automatically as time advances.';
      break;
    case 'pending_approval':
      nextStep = `Waiting for the board meeting on ${meetingDate ?? 'the next meeting'}${proposal ? ` (${proposal.id})` : ''}. If approved, it is carried out that day; you will get a message either way. You can still withdraw it.`;
      break;
    case 'approved':
      nextStep = `Approved by the board${res.approvedDate ? ` on ${res.approvedDate}` : ''}, but not possible yet: ${(res.blockedBy ?? []).join(' ')} It is retried automatically after every time advance; once fixed you can also run it with “Execute now”. Approval valid until ${res.validUntil ?? '—'}.`;
      break;
    case 'committed': {
      const r = (a.result ?? {}) as { summary?: string; details?: string[]; approvedBy?: string; approvedDate?: string };
      const what = [r.summary, ...(r.details ?? []).filter((x) => !/^[A-Z]{2,4}-\d+$/.test(x))].filter(Boolean).join(' — ');
      nextStep = `${r.approvedBy === 'board' ? `Approved by the board${r.approvedDate ? ` on ${r.approvedDate}` : ''} and carried out` : 'Carried out'}${what ? `: ${what}` : ''}. Follow its effects on the related page and in History.`;
      break;
    }
    case 'rejected':
      nextStep = res.note?.startsWith('Rejected by the board') ? `${res.note} Nothing was carried out. Revise it (for example a smaller scope, or after building support with the directors) and submit again.` : 'Rejected — nothing was changed.';
      break;
    case 'expired':
      nextStep = 'The board approval lapsed because it could not be carried out in time. Prepare it again if it is still needed.';
      break;
    default:
      nextStep = '';
  }
  const rr = (a.result ?? {}) as { committedDate?: string; approvedDate?: string };
  const effectiveDate = a.status === 'committed' ? String(rr.committedDate ?? rr.approvedDate ?? a.simDate) : a.simDate;
  return { ...a, effectiveDate, needsBoard, nextStep, boardOutlook, meetingDate };
}

// ---------------------------------------------------------------- time

/** At each year end the board approves the new year's budget: an operating-profit target a little above the fresh forecast. */
function setAnnualBudget(w: World): void {
  const fc = w.meta.lastForecastSummary;
  if (!fc) return;
  const yr = w.meta.currentDate.slice(0, 4);
  const target = Math.round((fc.fyEbitCents + Math.max(Math.abs(fc.fyEbitCents) * 0.08, 2_000_000_000)) / 100_000_000) * 100_000_000;
  const old = w.meta.boardPlan.ebitTargetCents;
  w.meta.boardPlan = { ...w.meta.boardPlan, ebitTargetCents: target };
  emit(w, { type: 'budget_approved', category: 'board', severity: 'notice', title: `Board sets the ${yr} budget: operating profit ${fmtEur(target)}`, description: `The ${yr} target replaces last year's ${fmtEur(old)}. It is based on the year-end forecast (${fmtEur(fc.fyEbitCents)}) plus a stretch. Minimum liquidity stays at ${fmtEur(w.meta.boardPlan.minLiquidityCents)}.`, causeKind: 'scheduled', entities: [{ type: 'character', id: 'CHR-DUBREUIL' }] });
  inbox(w, { kind: 'board', fromId: 'CHR-DUBREUIL', subject: `The ${yr} budget`, body: `The board has approved the ${yr} budget. Operating profit target: ${fmtEur(target)} (the year-end forecast is ${fmtEur(fc.fyEbitCents)}). We also still expect liquidity above ${fmtEur(w.meta.boardPlan.minLiquidityCents)} and the Eon on plan. Board confidence will be judged against these figures from now on.`, priority: 'normal', linked: [] });
}

export interface AdvanceResult {
  from: string;
  to: string;
  days: number;
  briefing: { subject: string; body: string };
  events: { id: string; date: string; title: string; severity: string }[];
  status: string;
  terminalReason: string | null;
  replayed: boolean;
}

export function advanceTime(db: DB, days: number, idempotencyKey?: string): AdvanceResult {
  if (!Number.isInteger(days) || days < 1 || days > 92) throw new GameError('You can advance between 1 and 92 days at a time.');
  const key = idempotencyKey ?? randomUUID();
  const prior = findByKey(db, key);
  if (prior) {
    if (prior.status === 'committed' && prior.result) return { ...(prior.result as unknown as AdvanceResult), replayed: true };
    throw new GameError('A time advance with this key is in progress or failed.');
  }
  const w = loadWorld(db);
  if (w.meta.status !== 'active') throw new GameError(`The game is over: ${w.meta.terminalReason}`);
  const from = w.meta.currentDate;
  const cashBefore = cash(w);
  const waiting = (db.prepare("SELECT * FROM actions WHERE status = 'approved' ORDER BY created_at").all() as Record<string, unknown>[]).map(rowToAction);
  let result: AdvanceResult | null = null;
  db.transaction(() => {
    const results = advanceDays(w, days, { onBoardApproved: (ww, actionId, proposalId) => void commitApprovedOnWorld(db, ww, actionId, proposalId) });
    if (w.meta.status === 'active') retryApproved(db, w, waiting);
    const newYear = from.slice(0, 4) !== w.meta.currentDate.slice(0, 4);
    if ((w.meta.forecastStale || newYear) && w.meta.status === 'active') refreshForecast(w, 'period_close');
    if (newYear && w.meta.status === 'active') setAnnualBudget(w);
    const events = [...w.out.events];
    const briefing = buildBriefing(w, from, results, events, cashBefore);
    inbox(w, { kind: 'briefing', fromId: null, subject: briefing.subject, body: briefing.body, priority: events.some((e) => e.severity === 'critical') ? 'high' : 'normal', linked: [] });
    result = {
      from,
      to: w.meta.currentDate,
      days: results.length,
      briefing,
      events: events.filter((e) => e.severity !== 'info').map((e) => ({ id: e.id, date: e.date, title: e.title, severity: e.severity })),
      status: w.meta.status,
      terminalReason: w.meta.terminalReason,
      replayed: false,
    };
    writeWorld(db, w);
    insertAction(db, {
      id: `ACT-${randomUUID().slice(0, 8)}`,
      idempotencyKey: key,
      type: 'advance_time',
      actorId: 'ceo',
      source: 'player',
      payload: { days },
      status: 'committed',
      simDate: from,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      summary: `Advance ${days} day${days > 1 ? 's' : ''} (${from} → ${w.meta.currentDate})`,
      errors: [],
      warnings: [],
      consequences: [],
      approvals: [],
      result: result as unknown as Record<string, unknown>,
      conversationId: null,
      rationale: null,
      supersededBy: null,
    });
  })();
  return result!;
}

/** Re-run the forecast on demand (e.g. after loading an old save). */
export function forceForecast(db: DB): void {
  const w = loadWorld(db);
  db.transaction(() => {
    refreshForecast(w, 'manual');
    writeWorld(db, w);
  })();
}
