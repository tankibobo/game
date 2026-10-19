import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { DB } from '../db/connection';
import { openDb } from '../db/connection';
import { GameError, actionView, advanceTime, confirmAction, createNewGame, executeApproved, forceForecast, getAction, modifyAction, proposeAction, rejectAction } from '../game/game';
import { actionCatalog, company, conversationView, dashboard, finance, history, inboxView, journal, latestForecast, operations, products, projectsView, statement, worldView } from '../game/queries';
import type { SaveManager } from '../game/saves';
import { sendMessage, startConversation, submitOffer } from '../llm/conversation';
import { LlmError, type LlmConfig } from '../llm/provider';
import { isSimDate } from '../../shared/dates';
import { SCENARIO_BRIEF } from '../scenario/initial';
import { SCENARIOS, scenarioOf } from '../scenario/scenarios';
import { DIFFICULTIES } from '../engine/difficulty';
import { loadWorld } from '../db/repo';
import { DOCUMENT_TYPES, recentDocuments, shareDocument } from '../game/documents';
import { decisionsView } from '../game/decisions';
import { MANUAL, askGuide, topicAnswer } from '../guide/guide';
import { coachReport } from '../guide/advisor';

export function buildApi(saves: SaveManager, llm: LlmConfig): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));
  const db = (): DB => saves.db();
  const body = <T>(schema: z.ZodType<T>, req: Request): T => {
    const p = schema.safeParse(req.body ?? {});
    if (!p.success) throw new GameError(p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return p.data;
  };

  const llmStatus = () => ({ provider: llm.provider.name, model: llm.provider.model, available: llm.provider.available, note: llm.provider.statusNote ?? null });

  /** One tiny round-trip to check that Claude answers (uses a sliver of your plan's usage). */
  r.post('/llm/test', async (_req, res) => {
    const t0 = Date.now();
    try {
      const out = await llm.provider.complete({
        system: 'You are a connectivity check for a business simulation game. Reply with the requested JSON only.',
        messages: [{ role: 'user', content: 'Return {"ok": true, "greeting": "<one short sentence greeting the CEO of Asterion Automotive>"}.' }],
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, greeting: { type: 'string' } }, required: ['ok', 'greeting'], additionalProperties: false },
        maxTokens: 200,
        timeoutMs: llm.timeoutMs,
        purpose: 'connection_test',
      });
      let greeting = out.text;
      try {
        greeting = String((JSON.parse(out.text) as { greeting?: unknown }).greeting ?? out.text);
      } catch {
        /* keep raw text */
      }
      res.json({ ok: true, model: out.model, latencyMs: Date.now() - t0, greeting, llm: llmStatus() });
    } catch (e) {
      res.json({ ok: false, error: e instanceof Error ? e.message : String(e), kind: e instanceof LlmError ? e.kind : 'api_error', latencyMs: Date.now() - t0, llm: llmStatus() });
    }
  });

  r.get('/status', (_req, res) => {
    const active = saves.activeId();
    let game = null;
    if (active) {
      const m = db().prepare('SELECT "current_date", status, terminal_reason, company_name, version, scenario_key, difficulty, seed, term_end_date, mandate FROM game_meta').get() as Record<string, unknown> | undefined;
      if (m && typeof m.mandate === 'string') {
        try {
          m.mandate = JSON.parse(m.mandate);
        } catch {
          m.mandate = null;
        }
      }
      game = m ?? null;
    }
    const sc = scenarioOf((game as { scenario_key?: string } | null)?.scenario_key);
    res.json({ activeSave: active, game, llm: llmStatus(), brief: game ? sc.brief : SCENARIO_BRIEF, scenario: game ? { key: sc.key, name: sc.name } : null });
  });

  r.get('/scenarios', (_req, res) =>
    res.json({
      scenarios: SCENARIOS.map((x) => ({ key: x.key, name: x.name, challenge: x.challenge, tagline: x.tagline, brief: x.brief })),
      difficulties: Object.entries(DIFFICULTIES).map(([key, d]) => ({ key, label: d.label, description: d.description, passScore: d.passScore })),
    }),
  );

  // ------------------------------------------------------------- saves
  r.get('/saves', (_req, res) => res.json({ saves: saves.list(), active: saves.activeId() }));
  r.post('/game/new', (req, res) => {
    const b = body(z.object({ name: z.string().max(60).optional(), seed: z.number().int().min(1).max(2_000_000_000).optional(), scenario: z.string().max(40).optional(), difficulty: z.enum(['relaxed', 'standard', 'hard']).optional() }), req);
    const name = b.name?.trim() || `Asterion ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const id = saves.newSlotId(name);
    const d = openDb(saves.fileFor(id));
    try {
      createNewGame(d, b.seed, { scenario: b.scenario, difficulty: b.difficulty });
    } finally {
      d.close();
    }
    saves.register(id, name, true);
    res.json({ id });
  });
  r.post('/saves/save-as', (req, res) => {
    const b = body(z.object({ name: z.string().min(1).max(60) }), req);
    res.json({ id: saves.saveAs(b.name) });
  });
  r.post('/saves/load', (req, res) => {
    const b = body(z.object({ id: z.string() }), req);
    saves.setActive(b.id);
    res.json({ ok: true });
  });
  r.delete('/saves/:id', (req, res) => {
    saves.delete(String(req.params.id));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- views
  r.get('/dashboard', (_req, res) => res.json(dashboard(db())));
  r.get('/company', (_req, res) => res.json(company(db())));
  r.get('/products', (_req, res) => res.json(products(db())));
  r.get('/projects', (_req, res) => res.json(projectsView(db())));
  r.get('/operations', (_req, res) => res.json(operations(db())));
  r.get('/finance', (_req, res) => res.json(finance(db())));
  r.get('/world', (_req, res) => res.json(worldView(db())));
  r.get('/inbox', (_req, res) => res.json(inboxView(db())));
  r.get('/forecast', (_req, res) => res.json(latestForecast(db())));
  r.post('/forecast/refresh', (_req, res) => {
    forceForecast(db());
    res.json(latestForecast(db()));
  });
  r.get('/statements', (req, res) => {
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    if (!isSimDate(from) || !isSimDate(to)) throw new GameError('from/to must be YYYY-MM-DD');
    res.json(statement(db(), from, to));
  });
  r.get('/journal', (req, res) => res.json(journal(db(), String(req.query.from ?? '0000-01-01'), String(req.query.to ?? '9999-12-31'))));
  r.get('/history', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(history(db(), { q: q.q, type: q.type, category: q.category, severity: q.severity, entity: q.entity, from: q.from, to: q.to, limit: q.limit ? Number(q.limit) : undefined }));
  });
  r.get('/catalog/actions', (_req, res) => res.json(actionCatalog()));

  // ------------------------------------------------------------- time
  r.post('/time/advance', (req, res) => {
    const b = body(z.object({ days: z.number().int().min(1).max(92), idempotencyKey: z.string().min(8).max(100).optional() }), req);
    res.json(advanceTime(db(), b.days, b.idempotencyKey));
  });

  // ------------------------------------------------------------- actions
  r.post('/actions/propose', (req, res) => {
    const b = body(z.object({ type: z.string(), payload: z.unknown(), idempotencyKey: z.string().min(8).max(100).optional(), rationale: z.string().max(2000).optional() }), req);
    res.json(actionView(db(), proposeAction(db(), { type: b.type, payload: b.payload, idempotencyKey: b.idempotencyKey, rationale: b.rationale ?? null, actorId: 'ceo', source: 'player' })));
  });
  r.get('/actions/:id', (req, res) => res.json(actionView(db(), getAction(db(), String(req.params.id)))));
  r.post('/actions/:id/confirm', (req, res) => {
    const b = body(z.object({ rationale: z.string().max(4000).optional() }), req);
    const out = confirmAction(db(), String(req.params.id), 'ceo', { boardRationale: b.rationale });
    res.json({ ...out, action: actionView(db(), out.action) });
  });
  r.post('/actions/:id/execute', (req, res) => {
    const out = executeApproved(db(), String(req.params.id));
    res.json({ ...out, action: actionView(db(), out.action) });
  });
  r.post('/actions/:id/reject', (req, res) => {
    const b = body(z.object({ reason: z.string().max(500).optional() }), req);
    res.json(actionView(db(), rejectAction(db(), String(req.params.id), b.reason)));
  });
  r.post('/actions/:id/modify', (req, res) => {
    const b = body(z.object({ payload: z.unknown() }), req);
    res.json(actionView(db(), modifyAction(db(), String(req.params.id), b.payload)));
  });

  // ------------------------------------------------------------- conversations & negotiations
  r.post('/conversations', (req, res) => {
    const b = body(z.object({ characterId: z.string(), title: z.string().max(120).optional() }), req);
    res.json(startConversation(db(), b.characterId, b.title));
  });
  r.get('/conversations/:id', (req, res) => res.json(conversationView(db(), String(req.params.id))));
  r.post('/conversations/:id/messages', async (req, res) => {
    const b = body(z.object({ text: z.string().min(1).max(4000) }), req);
    const result = await sendMessage(db(), llm, String(req.params.id), b.text);
    res.json(result);
  });
  r.post('/negotiations/:id/offer', async (req, res) => {
    const b = body(z.object({ terms: z.record(z.string(), z.number()), message: z.string().max(2000).default(''), conversationId: z.string().nullable().optional(), idempotencyKey: z.string().min(8).max(100).optional() }), req);
    res.json(await submitOffer(db(), llm, String(req.params.id), b.terms, b.message, b.conversationId ?? null, b.idempotencyKey));
  });
  r.get('/decisions', (_req, res) => res.json(decisionsView(db())));

  // ------------------------------------------------------------- how-to guide
  r.get('/guide/topics', (_req, res) => res.json({ topics: MANUAL.map((t) => ({ id: t.id, title: t.title })) }));
  r.get('/guide/topics/:id', (req, res) => {
    const a = topicAnswer(String(req.params.id));
    if (!a) throw new GameError('Unknown guide topic', 404);
    res.json(a);
  });
  r.get('/coach', (_req, res) => {
    const d = db();
    res.json(coachReport(d, loadWorld(d)));
  });
  r.post('/guide/ask', async (req, res) => {
    const b = body(z.object({ question: z.string().min(1).max(600), page: z.string().max(40).nullable().optional() }), req);
    res.json(await askGuide(saves.activeId() ? db() : null, llm, b.question, b.page ?? null));
  });

  // ------------------------------------------------------------- documents & memos
  r.get('/documents', (_req, res) => {
    const w = loadWorld(db());
    res.json({
      types: DOCUMENT_TYPES,
      options: {
        project: w.projects.filter((p) => p.status !== 'cancelled').map((p) => ({ id: p.id, label: p.name })),
        negotiation: w.negotiations.map((n) => ({ id: n.id, label: n.title })),
        board_proposal: w.boardProposals.filter((b) => b.status !== 'withdrawn').map((b) => ({ id: b.id, label: `${b.title} (${b.status})` })),
      },
      recent: recentDocuments(db(), '0000-00-00', 40),
    });
  });
  r.post('/documents/share', (req, res) => {
    const b = body(z.object({ docKey: z.string(), param: z.string().nullable().optional(), recipientIds: z.array(z.string()).min(1).max(20), note: z.string().max(2000).optional(), conversationId: z.string().nullable().optional() }), req);
    res.json(shareDocument(db(), b));
  });

  r.post('/inbox/:id/read', (req, res) => {
    db().prepare('UPDATE inbox SET read = 1 WHERE id = ?').run(String(req.params.id));
    res.json({ ok: true });
  });
  r.post('/inbox/read-all', (_req, res) => {
    db().prepare('UPDATE inbox SET read = 1').run();
    res.json({ ok: true });
  });

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GameError) return res.status(err.status).json({ error: err.message });
    const msg = err instanceof Error ? err.message : String(err);
    if (/No active game/.test(msg)) return res.status(409).json({ error: msg });
    console.error(err);
    res.status(500).json({ error: msg });
  });
  return r;
}
