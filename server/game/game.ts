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
import { meetingForSubmission, reactToForecast, type ProposalAnalysis } from '../engine/board';
import { buildBriefing } from '../engine/briefing';
import { buildForecast } from '../engine/forecast';
import { cash } from '../engine/ledger';
import { liquidity, netLeverage } from '../engine/metrics';
import { updateProjectForecasts } from '../engine/projects';
import { advanceDays } from '../engine/tick';
import { emit, inbox, nextId, type World } from '../engine/world';
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
  base.payload = payload;
  const v = safe(() => def.validate(w, payload, actorId), (e) => ({ errors: [String(e)], warnings: [] }));
  base.errors = v.errors;
  base.warnings = v.warnings;
  base.summary = def.label;
  if (v.errors.length === 0) {
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
      updateAction(db, a.id, { status: 'committed', result: { ...(result as unknown as Record<string, unknown>), approvedBy: approverId } });
    })();
    return { action: getAction(db, a.id), ok: true, message: (result as { summary: string } | null)?.summary ?? 'Committed' };
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

/** Called from the tick when the board approves a proposal linked to an action. */
export function commitApprovedOnWorld(db: DB, w: World, actionId: string): void {
  const r = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as Record<string, unknown> | undefined;
  if (!r) return;
  const a = rowToAction(r);
  if (a.status !== 'pending_approval') return;
  const def = ACTION_BY_TYPE.get(a.type);
  if (!def) return;
  const v = def.validate(w, a.payload, a.actorId);
  if (v.errors.length) {
    w.out.actionUpdates.push({ actionId, status: 'failed', note: `Approved by the board but no longer valid: ${v.errors.join(' ')}` });
    emit(w, { type: 'approved_action_invalid', category: 'board', severity: 'warning', title: `Board-approved action could not be executed: ${a.summary}`, description: v.errors.join(' '), causeKind: 'causal', actionId });
    return;
  }
  const res = def.commit(w, a.payload, { actionId, approverId: 'board', actorId: a.actorId });
  if (def.affectsForecast) w.meta.forecastStale = 1;
  w.out.actionUpdates.push({ actionId, status: 'committed', result: { ...res, approvedBy: 'board' } as unknown as Record<string, unknown> });
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

// ---------------------------------------------------------------- time

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
  let result: AdvanceResult | null = null;
  db.transaction(() => {
    const results = advanceDays(w, days, { onBoardApproved: (ww, actionId) => commitApprovedOnWorld(db, ww, actionId) });
    if (w.meta.forecastStale && w.meta.status === 'active') refreshForecast(w, 'period_close');
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
