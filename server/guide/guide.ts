/**
 * The in-game guide: answers "how do I…?" questions with step-by-step
 * instructions from the manual. It explains the interface and the rules and
 * never recommends what to do — strategy is the player's job.
 *
 * With Claude available the answer is phrased from the manual (plus a few
 * live facts such as the next board meeting); otherwise the best-matching
 * manual entries are returned as they are.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../db/connection';
import { loadWorld } from '../db/repo';
import { meetingForSubmission, upcomingMeeting } from '../engine/board';
import { engineeringFreeFte } from '../engine/metrics';
import { RULES } from '../engine/params';
import { LlmError, type LlmConfig } from '../llm/provider';
import { parseStructured } from '../llm/schemas';
import { MANUAL, PAGE_LABEL, type GuidePage, type ManualTopic } from './manual';
import { fmtEur } from '../../shared/money';

export interface GuideAnswer {
  answer: string;
  steps: string[];
  notes: string[];
  pages: { page: GuidePage; label: string }[];
  topics: { id: string; title: string }[];
  source: 'claude' | 'manual';
  related: { id: string; title: string }[];
}

const PAGES = Object.keys(PAGE_LABEL) as GuidePage[];
const ADVICE_RE = /\b(should i|what should|best (?:way to win|strategy|move|option|choice)|is it (?:a )?good idea|recommend|which is better|what would you do|help me win|optimal)\b/i;

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9€]+/).filter((t) => t.length > 2 && !STOP.has(t));
}
const STOP = new Set(['how', 'the', 'and', 'can', 'what', 'does', 'for', 'into', 'with', 'from', 'this', 'that', 'there', 'where', 'when', 'why', 'get', 'make', 'want', 'you', 'your', 'are', 'not', 'any', 'more', 'some', 'game', 'need', 'use', 'doing', 'able', 'have', 'has', 'was', 'its', 'our', 'their', 'them', 'they', 'then', 'than', 'out']);

/** Rank manual topics for a question (keyword phrases count most, then shared words). */
export function retrieve(question: string, limit = 3): { topic: ManualTopic; score: number }[] {
  const q = question.toLowerCase();
  const qt = new Set(tokens(question));
  return MANUAL.map((topic) => {
    let score = 0;
    for (const k of topic.keywords) {
      const words = k.split(' ').length;
      const hit = words > 1 ? q.includes(k) : new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q);
      if (hit) score += words > 1 ? 3 + words : 2;
      else for (const t of tokens(k)) if (qt.has(t)) score += 0.5;
    }
    for (const t of tokens(topic.title)) if (qt.has(t)) score += 1;
    return { topic, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function manualText(): string {
  return MANUAL.map((t) => [`[${t.id}] ${t.title}`, t.summary, ...t.steps.map((s, i) => `  ${i + 1}. ${s}`), ...(t.notes ?? []).map((n) => `  Note: ${n}`), `  Pages: ${t.pages.map((p) => PAGE_LABEL[p]).join(', ')}`].join('\n')).join('\n\n');
}

function liveFacts(db: DB | null): string {
  if (!db) return 'No game is loaded yet (the player is on the start screen).';
  try {
    const w = loadWorld(db);
    const drafts = (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'pending_confirmation'").get() as { n: number }).n;
    const waiting = (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'approved'").get() as { n: number }).n;
    return [
      `Simulation date ${w.meta.currentDate}. Next board meeting ${upcomingMeeting(w)}; a decision submitted today is voted on ${meetingForSubmission(w)}.`,
      `CEO authority: spending up to ${fmtEur(RULES.ceoSpendLimitCents)}, bank debt up to ${fmtEur(RULES.ceoFinancingLimitCents)}, hiring up to ${RULES.ceoHiringLimit}, restructuring up to ${RULES.boardRestructuringHeadcount} positions.`,
      `Unassigned engineers: ${Math.max(0, Math.floor(engineeringFreeFte(w)))}. Drafts waiting for the CEO: ${drafts}. Board-approved decisions waiting to be carried out: ${waiting}.`,
    ].join('\n');
  } catch {
    return 'Game facts unavailable.';
  }
}

const GuideSchema = z.object({
  answer: z.string().min(1).max(1500),
  steps: z.preprocess((v) => (Array.isArray(v) ? v.slice(0, 10) : []), z.array(z.string().max(400))),
  pages: z.preprocess((v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string' && (PAGES as string[]).includes(p)).slice(0, 4) : []), z.array(z.enum(PAGES as [GuidePage, ...GuidePage[]]))),
  topic_ids: z.preprocess((v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string' && MANUAL.some((m) => m.id === t)).slice(0, 4) : []), z.array(z.string())),
});

const GUIDE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: { type: 'string', description: 'One to three sentences answering the question.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'Numbered how-to steps naming the exact pages, tabs and buttons from the manual (empty if not a how-to).' },
    pages: { type: 'array', items: { type: 'string', enum: PAGES }, description: 'Pages the player should open.' },
    topic_ids: { type: 'array', items: { type: 'string', enum: MANUAL.map((m) => m.id) }, description: 'Manual entries the answer is based on.' },
  },
  required: ['answer', 'steps', 'pages', 'topic_ids'],
};

const SYSTEM = [
  'You are the in-game help guide of "Automanager", an automotive CEO simulation. You explain HOW to do things in the game: which page, which tab, which button, and what happens afterwards.',
  'Answer only from the MANUAL and the GAME FACTS. Use the exact names of pages, tabs and buttons as written in the manual. If the manual does not cover something, say so briefly and point to the closest entry.',
  'Never give strategic advice: do not say what the player should decide, which option is better, or what would make them win. If asked for advice, say you can only explain how things work and where to find the information needed to decide, then give that how-to.',
  'Never invent features, numbers or rules. Keep it short and practical.',
  'Respond ONLY with JSON matching the schema.',
].join('\n');

function fromManual(question: string): GuideAnswer {
  const hits = retrieve(question);
  const advice = ADVICE_RE.test(question);
  if (!hits.length) {
    const basics = MANUAL.find((t) => t.id === 'basics')!;
    return {
      answer: `${advice ? 'I can only explain how the game works, not what to decide. ' : ''}I could not find that in the manual. Try asking about a specific task — for example “How do I hire more people?”, “How do I get the board to approve a project?” or “How do I send a report to someone?”.`,
      steps: basics.steps,
      notes: [],
      pages: basics.pages.map((p) => ({ page: p, label: PAGE_LABEL[p] })),
      topics: [{ id: basics.id, title: basics.title }],
      source: 'manual',
      related: MANUAL.filter((t) => ['decision-flow', 'hire', 'board-approval', 'share'].includes(t.id)).map((t) => ({ id: t.id, title: t.title })),
    };
  }
  const best = hits[0].topic;
  return {
    answer: `${advice ? 'I can only explain how things work, not what you should decide — but here is how to do it and where to find what you need. ' : ''}${best.summary}`,
    steps: best.steps,
    notes: best.notes ?? [],
    pages: best.pages.map((p) => ({ page: p, label: PAGE_LABEL[p] })),
    topics: [{ id: best.id, title: best.title }],
    source: 'manual',
    related: hits.slice(1).map((h) => ({ id: h.topic.id, title: h.topic.title })),
  };
}

/** Answer a manual topic directly (used when the player clicks a related topic). */
export function topicAnswer(id: string): GuideAnswer | null {
  const t = MANUAL.find((x) => x.id === id);
  if (!t) return null;
  return { answer: t.summary, steps: t.steps, notes: t.notes ?? [], pages: t.pages.map((p) => ({ page: p, label: PAGE_LABEL[p] })), topics: [{ id: t.id, title: t.title }], source: 'manual', related: [] };
}

export async function askGuide(db: DB | null, llm: LlmConfig, question: string, page: string | null): Promise<GuideAnswer> {
  const q = question.trim().slice(0, 600);
  if (!q) return fromManual('how to play');
  const manualAnswer = fromManual(q);
  if (!llm.provider.available) return manualAnswer;
  const t0 = Date.now();
  const user = [`MANUAL:\n${manualText()}`, `GAME FACTS:\n${liveFacts(db)}`, `The player is on the page: ${page && (PAGES as string[]).includes(page) ? PAGE_LABEL[page as GuidePage] : 'unknown'}.`, `QUESTION:\n${q}`].join('\n\n');
  let status = 'ok';
  let error: string | null = null;
  try {
    const res = await llm.provider.complete({ system: SYSTEM, messages: [{ role: 'user', content: user }], schema: GUIDE_JSON_SCHEMA, maxTokens: 1500, timeoutMs: llm.timeoutMs, purpose: 'guide' });
    const parsed = parseStructured(res.text, GuideSchema);
    if (!parsed.ok) {
      status = 'invalid_output';
      error = parsed.error;
      return manualAnswer;
    }
    const v = parsed.value;
    const topics = v.topic_ids.map((id) => MANUAL.find((m) => m.id === id)!).filter(Boolean);
    const notes = topics.flatMap((t) => t.notes ?? []).slice(0, 3);
    return {
      answer: v.answer,
      steps: v.steps,
      notes,
      pages: (v.pages.length ? v.pages : topics.flatMap((t) => t.pages)).filter((p, i, a) => a.indexOf(p) === i).slice(0, 4).map((p) => ({ page: p, label: PAGE_LABEL[p] })),
      topics: topics.map((t) => ({ id: t.id, title: t.title })),
      source: 'claude',
      related: manualAnswer.topics.concat(manualAnswer.related).filter((r) => !topics.some((t) => t.id === r.id)).slice(0, 3),
    };
  } catch (e) {
    status = e instanceof LlmError ? e.kind : 'api_error';
    error = e instanceof Error ? e.message : String(e);
    return manualAnswer;
  } finally {
    if (db) {
      try {
        db.prepare('INSERT INTO llm_calls (id, created_at, purpose, conversation_id, provider, model, status, latency_ms, error, context_tokens, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(`LLM-${randomUUID().slice(0, 8)}`, new Date().toISOString(), 'guide', null, llm.provider.name, llm.provider.model, status, Date.now() - t0, error, Math.ceil(user.length / 3.8), null, null);
      } catch {
        /* logging is best-effort */
      }
    }
  }
}

export { MANUAL };
