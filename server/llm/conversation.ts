/**
 * Conversations with characters. The LLM supplies language and judgement;
 * everything it returns is untrusted and goes through validation:
 *  - proposed actions → the action pipeline (pending CEO confirmation)
 *  - commitments the CEO made → recorded as `make_promise` actions
 *  - memories / trust changes → bounded and written in one transaction
 *  - escalation events → engine eligibility check, processed at next tick
 *  - factual claims → cross-checked against the database and flagged
 * A failed or malformed LLM call falls back to the deterministic responder;
 * the game state is never left half-updated.
 */
import { randomUUID } from 'node:crypto';
import type { ActionRecord, Character, Conversation, ConversationMessage } from '../../shared/domain';
import { isSimDate } from '../../shared/dates';
import type { DB } from '../db/connection';
import { loadWorld, rowToConversation, rowToMessage, writeWorld } from '../db/repo';
import { proposeEvent } from '../engine/events';
import { NEGOTIATION_TEMPLATES, heuristicArgumentQuality } from '../engine/negotiation';
import { adjustTrust, byId, clamp, remember, type World } from '../engine/world';
import { GameError, confirmAction, proposeAction } from '../game/game';
import { buildContext, estimateTokens, mentionedEntities } from './context';
import { ACTION_BY_TYPE } from '../actions/registry';
import { REPORT_BY_KEY } from '../reports/catalog';
import { recordDocument, rowToSharedDocument } from '../game/documents';
import { fallbackNegotiationLine, fallbackTurn } from './fallback';
import { LlmError, type LlmConfig } from './provider';
import { ARGUMENT_JSON_SCHEMA, ArgumentAssessmentSchema, CHARACTER_TURN_JSON_SCHEMA, CharacterTurnSchema, parseStructured, type CharacterTurn } from './schemas';

const nowIso = () => new Date().toISOString();

export function getConversation(db: DB, id: string): Conversation {
  const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) throw new GameError(`Conversation ${id} not found`, 404);
  return rowToConversation(r);
}

export function listMessages(db: DB, conversationId: string): ConversationMessage[] {
  return (db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(conversationId) as Record<string, unknown>[]).map(rowToMessage);
}

export function startConversation(db: DB, characterId: string, title?: string, negotiationId?: string | null): Conversation {
  const w = loadWorld(db);
  const c = byId(w.characters, characterId);
  if (!c) throw new GameError(`Unknown character ${characterId}`, 404);
  if (!c.active) throw new GameError(`${c.name} is no longer with the organisation.`);
  const conv: Conversation = { id: `CNV-${randomUUID().slice(0, 8)}`, characterId, title: title ?? `Meeting with ${c.name}`, startedDate: w.meta.currentDate, lastDate: w.meta.currentDate, status: 'open', summary: '', negotiationId: negotiationId ?? null, createdAt: nowIso() };
  db.prepare('INSERT INTO conversations (id, character_id, title, started_date, last_date, status, summary, negotiation_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(conv.id, conv.characterId, conv.title, conv.startedDate, conv.lastDate, conv.status, conv.summary, conv.negotiationId, conv.createdAt);
  return conv;
}

function insertMessage(db: DB, m: Omit<ConversationMessage, 'id' | 'createdAt'>): ConversationMessage {
  const full: ConversationMessage = { ...m, id: `MSGC-${randomUUID().slice(0, 8)}`, createdAt: nowIso() };
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, sim_date, created_at, structured) VALUES (?,?,?,?,?,?,?)').run(full.id, full.conversationId, full.role, full.content, full.simDate, full.createdAt, full.structured ? JSON.stringify(full.structured) : null);
  return full;
}

function logCall(db: DB, row: { purpose: string; conversationId: string | null; provider: string; model: string; status: string; latencyMs: number; error: string | null; contextTokens: number | null; inputTokens: number | null; outputTokens: number | null }) {
  db.prepare('INSERT INTO llm_calls (id, created_at, purpose, conversation_id, provider, model, status, latency_ms, error, context_tokens, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(`LLM-${randomUUID().slice(0, 8)}`, nowIso(), row.purpose, row.conversationId, row.provider, row.model, row.status, row.latencyMs, row.error, row.contextTokens, row.inputTokens, row.outputTokens);
}

export function systemPrompt(c: Character): string {
  return [
    `You are role-playing ${c.name}, ${c.title}, in "Automanager", a rules-based simulation of an automotive company. The user is the CEO.`,
    'Speak only as this character: their personality, incentives, knowledge, mood and relationship with the CEO. Be realistic, not uniformly agreeable: disagree, push back, ask for resources or evidence, or refuse when your character would. Keep dialogue concise (typically 60–180 words).',
    'Ground every factual statement in the CONTEXT. Distinguish facts, estimates, beliefs and rumours, and say "I don’t know" when the context does not tell you. Never invent numbers, dates, people, contracts or events.',
    'You cannot change the world. Never claim that something happened (a contract signed, money transferred, a milestone completed, an approval granted) unless the context states it as [FACT]. To get something done, propose an action from the ACTION CATALOG; the simulation validates it and the CEO decides.',
    'Your private walk-away limits in any negotiation must never be stated as numbers.',
    'Only ask the CEO for things listed under WHAT THE CEO CAN DO. If you need information, request a report from the REPORT CATALOGUE by its key (request_reports); never ask for anything else, and never offer to send something later.',
    'When you give figures or analysis from your own department, quote YOUR REPORTS precisely and attach the report (attach_reports) so the CEO sees the tables and charts. When the CEO asks you to send something to a colleague, use share_reports with one of your reports.',
    'You know what COMPANY KNOWLEDGE says about decisions, the board agenda and the CEO’s meetings with colleagues; stay consistent with it.',
    'Respond ONLY with JSON matching the provided schema.',
  ].join('\n');
}

async function callCharacterLlm(db: DB, llm: LlmConfig, c: Character, ctxText: string, transcript: ConversationMessage[], summary: string, playerMessage: string, conversationId: string, ctxTokens: number): Promise<{ turn: CharacterTurn | null; error: string | null }> {
  if (!llm.provider.available) return { turn: null, error: llm.provider.statusNote ?? 'deterministic mode (no LLM configured)' };
  const lines = transcript.slice(-10).map((m) => (m.role === 'system' ? `[${m.content.replace(/^You shared/, 'The CEO shared')} — see DOCUMENTS THE CEO SENT YOU]` : `${m.role === 'player' ? 'CEO' : c.name}: ${m.content}`));
  const user = [
    '=== CONTEXT (assembled from the simulation database) ===',
    ctxText,
    '',
    '=== CONVERSATION SO FAR ===',
    summary ? `Summary of earlier parts: ${summary}` : '(new conversation)',
    ...lines,
    '',
    `=== CEO'S NEW MESSAGE ===`,
    playerMessage,
  ].join('\n');
  const t0 = Date.now();
  try {
    const res = await llm.provider.complete({ system: systemPrompt(c), messages: [{ role: 'user', content: user }], schema: CHARACTER_TURN_JSON_SCHEMA, maxTokens: 4000, timeoutMs: llm.timeoutMs, purpose: 'character_turn' });
    const parsed = parseStructured(res.text, CharacterTurnSchema);
    logCall(db, { purpose: 'character_turn', conversationId, provider: llm.provider.name, model: res.model, status: parsed.ok ? 'ok' : 'invalid_output', latencyMs: Date.now() - t0, error: parsed.ok ? null : parsed.error, contextTokens: ctxTokens, inputTokens: res.inputTokens, outputTokens: res.outputTokens });
    return parsed.ok ? { turn: parsed.value, error: null } : { turn: null, error: `malformed LLM output (${parsed.error})` };
  } catch (e) {
    const kind = e instanceof LlmError ? e.kind : 'api_error';
    logCall(db, { purpose: 'character_turn', conversationId, provider: llm.provider.name, model: llm.provider.model, status: kind, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e), contextTokens: ctxTokens, inputTokens: null, outputTokens: null });
    return { turn: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- fact guard

export interface ClaimCheck {
  statement: string;
  basis: string;
  verified: 'consistent' | 'unverified' | 'contradicted';
  note: string | null;
}

const STATUS_CLAIMS: { re: RegExp; check: (w: World, text: string) => string | null }[] = [
  {
    re: /\b(contract|agreement|amendment|deal)\b[^.]{0,60}\b(is|has been|was|now)\s+(signed|executed|in force)/i,
    check: (w, text) => {
      const ids = mentionedEntities(w, text);
      const signed = w.contracts.filter((c) => c.status === 'active' && c.signedDate && c.signedDate >= '2027-01-01');
      const relevant = signed.filter((c) => ids.includes(c.counterpartyId ?? '') || ids.some((i) => byId(w.negotiations, i)?.contractId === c.id) || (c.templateKey === 'voltaris_supply' && ids.includes('SUP-VOLTARIS')) || (c.kind === 'labor' && ids.includes('NEG-UNION')));
      return relevant.length ? null : 'The simulation has no record of such a signed contract.';
    },
  },
  {
    re: /\b(milestone|validation|homologation|type approval|sop|start of production|tests?)\b[^.]{0,60}\b(is|has been|was|now)\s+(completed|complete|passed|granted|achieved|done|signed off)/i,
    check: (w, text) => {
      const t = text.toLowerCase();
      const candidates = w.milestones.filter((m) => t.includes(m.name.toLowerCase()) || (/validation|tests?/.test(t) && m.id === 'MS-EON-3') || (/homologation|type approval/.test(t) && m.id === 'MS-EON-6') || (/sop|start of production/.test(t) && m.id === 'MS-EON-8'));
      if (!candidates.length) return null;
      return candidates.some((m) => m.status === 'completed') ? null : `Not completed according to the project record (${candidates.map((m) => `${m.name}: ${m.status}`).join('; ')}).`;
    },
  },
  {
    re: /(€\s?\d[\d.,]*\s?(m|bn|million|billion)?)[^.]{0,50}\b(transferred|wired|paid|received|deposited|injected)\b/i,
    check: () => 'No such payment appears in the ledger for this conversation; money only moves through executed transactions.',
  },
  {
    re: /\b(board|credit committee|bank|lenders?)\b[^.]{0,40}\b(has|have)\s+(approved|agreed|signed off)/i,
    check: (w, text) => {
      const recent = w.boardProposals.some((p) => p.status === 'approved') || w.financing.some((f) => ['offered', 'executed'].includes(f.status));
      return recent ? null : 'No such approval exists in the simulation record.';
    },
  },
];

export function checkClaims(w: World, turn: CharacterTurn): { claims: ClaimCheck[]; warnings: string[] } {
  const warnings: string[] = [];
  const knownIds = new Set([...w.projects, ...w.milestones, ...w.issues, ...w.models, ...w.suppliers, ...w.supplies, ...w.factories, ...w.lines, ...w.characters, ...w.contracts, ...w.negotiations, ...w.financing, ...w.debts, ...w.commitments, ...w.departments, ...w.regulations].map((e) => e.id));
  const claims: ClaimCheck[] = turn.claims.map((cl) => {
    const unknown = cl.entity_ids.filter((id) => !knownIds.has(id));
    let verified: ClaimCheck['verified'] = 'consistent';
    let note: string | null = null;
    if (unknown.length) {
      verified = 'unverified';
      note = `References unknown entities: ${unknown.join(', ')}.`;
    }
    for (const sc of STATUS_CLAIMS) {
      if (sc.re.test(cl.statement)) {
        const why = sc.check(w, cl.statement);
        if (why) {
          verified = 'contradicted';
          note = why;
        }
      }
    }
    return { statement: cl.statement, basis: verified === 'consistent' ? cl.basis : 'belief', verified, note };
  });
  const sentences = turn.dialogue.split(/(?<=[.!?])\s+/);
  for (const s of sentences) for (const sc of STATUS_CLAIMS) if (sc.re.test(s)) {
    const why = sc.check(w, s);
    if (why) warnings.push(`“${s.slice(0, 140)}” — ${why}`);
  }
  return { claims, warnings: [...new Set(warnings)].slice(0, 4) };
}

// ---------------------------------------------------------------- send message

export interface TurnResult {
  playerMessage: ConversationMessage;
  reply: ConversationMessage;
  actions: ActionRecord[];
  mode: 'llm' | 'fallback';
  fallbackReason: string | null;
}

export async function sendMessage(db: DB, llm: LlmConfig, conversationId: string, text: string): Promise<TurnResult> {
  const conv = getConversation(db, conversationId);
  const trimmed = text.trim();
  if (!trimmed) throw new GameError('Message is empty.');
  if (trimmed.length > 4000) throw new GameError('Message is too long (max 4,000 characters).');
  const w = loadWorld(db);
  if (w.meta.status !== 'active') throw new GameError(`The game is over: ${w.meta.terminalReason}`);
  const c = byId(w.characters, conv.characterId);
  if (!c || !c.active) throw new GameError('This person is no longer available.');
  const history = listMessages(db, conversationId);
  const playerMessage = insertMessage(db, { conversationId, role: 'player', content: trimmed, simDate: w.meta.currentDate, structured: null });

  const ctx = buildContext(db, w, { characterId: c.id, conversationId, playerMessage: trimmed });
  const llmRes = await callCharacterLlm(db, llm, c, ctx.text, history, conv.summary, trimmed, conversationId, ctx.tokens);
  const mode: 'llm' | 'fallback' = llmRes.turn ? 'llm' : 'fallback';
  const turn = llmRes.turn ?? fallbackTurn(w, c, trimmed, conv.summary);

  return finalizeTurn(db, conv, c, turn, mode, llmRes.error, playerMessage, ctx.tokens, ctx.sections.filter((s) => s.included).map((s) => s.name));
}

async function finalizeTurn(db: DB, conv: Conversation, c: Character, turn: CharacterTurn, mode: 'llm' | 'fallback', fallbackReason: string | null, playerMessage: ConversationMessage, ctxTokens: number, ctxSections: string[], extra: Record<string, unknown> = {}): Promise<TurnResult> {
  const actions: ActionRecord[] = [];
  const rejectedProposals: { type: string; reason: string }[] = [];
  const internal = c.org === 'asterion' || c.org === 'board';

  // 1. Proposed actions → validator (never committed here).
  for (const p of turn.proposed_actions) {
    let payload: unknown;
    try {
      payload = JSON.parse(p.params_json || '{}');
    } catch {
      rejectedProposals.push({ type: p.type, reason: 'Parameters were not valid JSON.' });
      continue;
    }
    if (!internal && p.type !== 'make_promise') {
      rejectedProposals.push({ type: p.type, reason: `${c.name} is external and cannot propose Asterion decisions.` });
      continue;
    }
    if (p.type === 'advance_time') {
      rejectedProposals.push({ type: p.type, reason: 'Only the CEO controls time.' });
      continue;
    }
    const rec = proposeAction(db, { type: p.type, payload, actorId: internal && c.org === 'asterion' ? c.id : 'ceo', source: 'llm_proposal', conversationId: conv.id, rationale: p.rationale });
    actions.push(rec);
  }

  // 2. Commitments the CEO explicitly made → recorded (validated) as make_promise.
  const recorded: string[] = [];
  for (const cm of turn.ceo_commitments) {
    const due = cm.due_date && isSimDate(cm.due_date) ? cm.due_date : null;
    const rec = proposeAction(db, { type: 'make_promise', payload: { promiseeId: c.id, description: cm.description, dueDate: due, importance: 3 }, actorId: 'ceo', source: 'llm_proposal', conversationId: conv.id, rationale: 'Promise detected in conversation' });
    if (rec.status === 'pending_confirmation') {
      const res = confirmAction(db, rec.id, 'ceo');
      if (res.ok) recorded.push(String((res.action.result as { result?: { commitmentId?: string } } | null)?.result?.commitmentId ?? res.action.id));
      actions.push(res.action);
    } else actions.push(rec);
  }

  // 3. Interpersonal effects — bounded, validated, single transaction on fresh state.
  const w = loadWorld(db);
  const claimCheck = checkClaims(w, turn);
  const eventResults: { key: string; accepted: boolean; reason: string }[] = [];
  const attachments: { key: string; docId: string }[] = [];
  const reportRequests: { key: string; param: string | null; title: string; reason: string; needsParam: string | null }[] = [];
  const sharedDocs: { docId: string; title: string; recipients: string[] }[] = [];
  db.transaction(() => {
    const ch = byId(w.characters, c.id)!;
    const delta = clamp(turn.trust_delta, -2, 2);
    if (delta) adjustTrust(w, ch.id, delta);
    for (const m of turn.memory_candidates.slice(0, 2)) {
      remember(w, { characterId: ch.id, kind: m.kind, summary: m.summary.slice(0, 400), importance: clamp(m.importance, 1, 5), sentiment: clamp(m.sentiment, -2, 2), sourceType: 'conversation', sourceId: conv.id, entityRefs: [] });
    }
    for (const ep of turn.event_proposals.slice(0, 1)) {
      const r = proposeEvent(w, ep.event_key, ep.entity_id, ep.rationale);
      eventResults.push({ key: ep.event_key, ...r });
    }
    // Reports: attached to the answer, asked for, or sent on to colleagues (information only).
    const parseRef = (ref: string) => {
      const [key, param] = ref.trim().replace(/^"|"$/g, '').split(':');
      return { key, param: param || null };
    };
    const owns = (key: string) => internal && c.org === 'asterion' && !!REPORT_BY_KEY.get(key)?.ownerIds.includes(c.id);
    for (const ref of turn.attach_reports.slice(0, 3)) {
      const { key, param } = parseRef(ref);
      if (!owns(key) || attachments.some((a) => a.key === key)) continue;
      try {
        const doc = recordDocument(db, w, { reports: [{ key, param }], recipientIds: ['ceo'], senderId: c.id, conversationId: conv.id, quiet: true });
        attachments.push({ key, docId: doc.id });
      } catch {
        /* report not available (e.g. missing parameter) — the answer stands without it */
      }
    }
    for (const r of turn.request_reports.slice(0, 2)) {
      const { key, param } = parseRef(r.report);
      const def = REPORT_BY_KEY.get(key);
      if (def) reportRequests.push({ key, param, title: def.title, reason: r.reason.slice(0, 300), needsParam: def.param ?? null });
    }
    for (const sh of turn.share_reports.slice(0, 2)) {
      const { key, param } = parseRef(sh.report);
      if (!owns(key)) continue;
      const to = sh.recipient_ids.filter((id) => id !== c.id && ['asterion', 'board'].includes(byId(w.characters, id)?.org ?? '') && byId(w.characters, id)?.active);
      if (!to.length) continue;
      try {
        const doc = recordDocument(db, w, { reports: [{ key, param }], memo: sh.note, recipientIds: to, senderId: c.id, conversationId: conv.id });
        sharedDocs.push({ docId: doc.id, title: doc.title, recipients: to.map((id) => byId(w.characters, id)!.name) });
      } catch {
        /* not available */
      }
    }
    writeWorld(db, w);
    db.prepare('UPDATE conversations SET summary = ?, last_date = ? WHERE id = ?').run(turn.summary_update.slice(0, 1200), w.meta.currentDate, conv.id);
  })();

  const reply = insertMessage(db, {
    conversationId: conv.id,
    role: 'character',
    content: turn.dialogue,
    simDate: w.meta.currentDate,
    structured: {
      mode,
      fallbackReason,
      emotion: turn.emotion,
      perspective: turn.perspective,
      claims: claimCheck.claims,
      factWarnings: claimCheck.warnings,
      actionIds: actions.map((a) => a.id),
      rejectedProposals,
      commitmentsRecorded: recorded,
      eventProposals: eventResults,
      trustDelta: clamp(turn.trust_delta, -2, 2),
      trustReason: turn.trust_reason,
      followUps: turn.follow_up_questions,
      attachments: attachments.map((a) => a.docId),
      reportRequests,
      sharedDocs,
      context: { tokens: ctxTokens, sections: ctxSections },
      ...extra,
    },
  });
  return { playerMessage, reply, actions, mode, fallbackReason };
}

// ---------------------------------------------------------------- quick questions

/**
 * Ask someone a quick question without setting up a meeting. Questions to the
 * same person are kept in one running "Quick questions" thread (which can be
 * continued as a meeting); the answer comes back with any reports attached.
 */
export async function quickQuestion(db: DB, llm: LlmConfig, characterId: string, question: string): Promise<TurnResult & { conversationId: string; documents: ReturnType<typeof rowToSharedDocument>[] }> {
  const w = loadWorld(db);
  const c = byId(w.characters, characterId);
  if (!c || !c.active) throw new GameError('This person is not available.');
  const row = db.prepare("SELECT * FROM conversations WHERE character_id = ? AND title LIKE 'Quick questions%' ORDER BY created_at DESC LIMIT 1").get(characterId) as Record<string, unknown> | undefined;
  const conv = row ? rowToConversation(row) : startConversation(db, characterId, `Quick questions — ${c.name}`);
  const result = await sendMessage(db, llm, conv.id, question);
  const ids = ((result.reply.structured as { attachments?: string[] } | null)?.attachments ?? []);
  const documents = ids.length ? (db.prepare(`SELECT * FROM shared_documents WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Record<string, unknown>[]).map(rowToSharedDocument) : [];
  return { ...result, conversationId: conv.id, documents };
}

// ---------------------------------------------------------------- negotiation offers

async function assessArgument(db: DB, llm: LlmConfig, w: World, c: Character, message: string, conversationId: string): Promise<{ quality: number; source: string; evidence: string[] }> {
  const n = w.negotiations.find((x) => x.counterpartyId === c.id && x.status === 'open');
  const heuristic = n ? heuristicArgumentQuality(message, w, n) : 0;
  if (!llm.provider.available || message.trim().length < 15) return { quality: heuristic, source: 'heuristic', evidence: [] };
  const ctx = buildContext(db, w, { characterId: c.id, conversationId, playerMessage: message, budgetTokens: 3500 });
  const t0 = Date.now();
  try {
    const res = await llm.provider.complete({
      system: `You assess negotiation arguments for a business simulation. Judge the CEO's message to ${c.name} (${c.title}) on substance: specific, verifiable facts, credible alternatives, mutual benefit, and fit with the counterparty's interests. Bluster, threats and vague promises are weak. Only cite entity IDs that appear in the context. Respond with JSON.`,
      messages: [{ role: 'user', content: `CONTEXT:\n${ctx.text}\n\nCEO MESSAGE:\n${message}` }],
      schema: ARGUMENT_JSON_SCHEMA,
      maxTokens: 1200,
      timeoutMs: llm.timeoutMs,
      purpose: 'argument_assessment',
    });
    const parsed = parseStructured(res.text, ArgumentAssessmentSchema);
    logCall(db, { purpose: 'argument_assessment', conversationId, provider: llm.provider.name, model: res.model, status: parsed.ok ? 'ok' : 'invalid_output', latencyMs: Date.now() - t0, error: parsed.ok ? null : parsed.error, contextTokens: ctx.tokens, inputTokens: res.inputTokens, outputTokens: res.outputTokens });
    if (!parsed.ok) return { quality: heuristic, source: 'heuristic (LLM output invalid)', evidence: [] };
    const known = new Set([...w.projects, ...w.issues, ...w.suppliers, ...w.supplies, ...w.contracts, ...w.negotiations, ...w.models, ...w.financing, ...w.debts].map((e) => e.id));
    const evidence = parsed.value.evidence_entity_ids.filter((id) => known.has(id));
    let q = parsed.value.quality === 'strong' ? 0.06 : parsed.value.quality === 'moderate' ? 0.02 : -0.03;
    if (parsed.value.quality === 'strong' && evidence.length === 0) q = 0.02; // strong claims need verifiable evidence
    if (evidence.length) q += 0.02;
    return { quality: clamp(q, -0.05, 0.1), source: 'llm', evidence };
  } catch (e) {
    logCall(db, { purpose: 'argument_assessment', conversationId, provider: llm.provider.name, model: llm.provider.model, status: e instanceof LlmError ? e.kind : 'api_error', latencyMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e), contextTokens: ctx.tokens, inputTokens: null, outputTokens: null });
    return { quality: heuristic, source: 'heuristic (LLM unavailable)', evidence: [] };
  }
}

export interface OfferResultView extends TurnResult {
  outcome: string;
}

export async function submitOffer(db: DB, llm: LlmConfig, negotiationId: string, terms: Record<string, number>, message: string, conversationId?: string | null, idempotencyKey?: string): Promise<OfferResultView> {
  const w0 = loadWorld(db);
  const n = byId(w0.negotiations, negotiationId);
  if (!n) throw new GameError('Unknown negotiation', 404);
  const c = byId(w0.characters, n.counterpartyId)!;
  const tpl = NEGOTIATION_TEMPLATES[n.templateKey];
  let conv: Conversation;
  if (conversationId) conv = getConversation(db, conversationId);
  else {
    const existing = db.prepare('SELECT * FROM conversations WHERE negotiation_id = ? ORDER BY created_at DESC LIMIT 1').get(negotiationId) as Record<string, unknown> | undefined;
    conv = existing ? rowToConversation(existing) : startConversation(db, c.id, `Negotiation: ${n.title}`, negotiationId);
  }
  const text = `${message.trim() ? `${message.trim()}\n\n` : ''}[Formal offer] ${tpl.describe(terms)}`;
  // Validate before recording anything (no side effects).
  const def = ACTION_BY_TYPE.get('negotiate_contract')!;
  const parsedOffer = def.schema.safeParse({ negotiationId, terms, message });
  if (!parsedOffer.success) throw new GameError(parsedOffer.error.issues.map((i) => i.message).join(' '));
  const pre = def.validate(w0, parsedOffer.data, 'ceo');
  if (pre.errors.length) throw new GameError(pre.errors.join(' '));

  const playerMessage = insertMessage(db, { conversationId: conv.id, role: 'player', content: text, simDate: w0.meta.currentDate, structured: { offer: terms } });
  const arg = await assessArgument(db, llm, w0, c, message, conv.id);
  const rec = proposeAction(db, { type: 'negotiate_contract', payload: { negotiationId, terms, message }, serverPayload: { argumentQuality: arg.quality }, actorId: 'ceo', source: 'player', conversationId: conv.id, idempotencyKey });
  if (rec.status !== 'pending_confirmation') throw new GameError(rec.errors.join(' ') || `Offer could not be processed (${rec.status}).`);
  const res = confirmAction(db, rec.id, 'ceo');
  if (!res.ok) throw new GameError(res.message);
  const r = (res.action.result ?? {}) as { summary?: string; result?: { outcome?: string; counter?: Record<string, number> | null; evaluation?: { notes?: string[]; violations?: string[] } } };
  const outcome = r.result?.outcome ?? 'countered';
  const engineSummary = r.summary ?? '';

  // Narrate the already-determined outcome.
  const w = loadWorld(db);
  const ctx = buildContext(db, w, { characterId: c.id, conversationId: conv.id, playerMessage: message });
  let turn: CharacterTurn | null = null;
  let fallbackReason: string | null = null;
  if (llm.provider.available) {
    const narration = `${message}\n\n[The CEO formally offered: ${tpl.describe(terms)}]\n[SIMULATION OUTCOME — already decided, narrate it faithfully, do not change it: ${outcome}. ${engineSummary} ${(r.result?.evaluation?.notes ?? []).join(' ')}]`;
    const llmRes = await callCharacterLlm(db, llm, c, ctx.text, listMessages(db, conv.id).slice(0, -1), conv.summary, narration, conv.id, ctx.tokens);
    turn = llmRes.turn;
    fallbackReason = llmRes.error;
    if (turn) turn = { ...turn, proposed_actions: [], event_proposals: [] };
  } else fallbackReason = 'deterministic mode (no LLM configured)';
  const mode: 'llm' | 'fallback' = turn ? 'llm' : 'fallback';
  if (!turn) {
    turn = fallbackTurn(w, c, message || 'offer', conv.summary);
    turn = { ...turn, dialogue: fallbackNegotiationLine(c, outcome, engineSummary), proposed_actions: [], ceo_commitments: [], event_proposals: [], trust_delta: 0 };
  }
  const result = await finalizeTurn(db, conv, c, turn, mode, fallbackReason, playerMessage, ctx.tokens, ctx.sections.filter((s) => s.included).map((s) => s.name), {
    negotiation: { id: negotiationId, outcome, engineSummary, counter: r.result?.counter ?? null, notes: r.result?.evaluation?.notes ?? [], violations: r.result?.evaluation?.violations ?? [], argumentQuality: arg.quality, argumentSource: arg.source, evidence: arg.evidence },
  });
  result.actions.unshift(res.action);
  return { ...result, outcome };
}

export { estimateTokens };
