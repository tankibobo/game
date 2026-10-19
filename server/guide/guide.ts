/**
 * The Coach: a guide who sits outside the game. Ask it anything about the
 * game — how to do something, how a mechanism works, why the company is
 * losing money, what to do next. It answers "how do I…?" from the manual,
 * "what should I do?" from its analysis of the live game (advisor.ts), and
 * "why…?" from the company's own reports. It gives advice and hints; it does
 * not play the game for you. Nobody inside the game hears what it says.
 *
 * With Claude available the answer is phrased from all of that; otherwise the
 * best-matching manual entry, report finding or advice is returned as it is.
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
import { coachReport, type CoachReport } from './advisor';
import { fmtEur } from '../../shared/money';
import { buildReport, reportToText } from '../reports/catalog';
import type { Report } from '../../shared/report';

export interface GuideAnswer {
  answer: string;
  steps: string[];
  notes: string[];
  pages: { page: GuidePage; label: string }[];
  topics: { id: string; title: string }[];
  source: 'claude' | 'manual';
  related: { id: string; title: string }[];
  /** Ready-made decisions from the Coach that the player can preview. */
  actions?: { type: string; payload: Record<string, unknown>; label: string; rationale?: string }[];
}

const PAGES = Object.keys(PAGE_LABEL) as GuidePage[];
export const ADVICE_RE = /\b(should i|what should|what (?:do|can) i do|what now|next step|best (?:way|strategy|move|option|choice)|is it (?:a )?good idea|recommend|advi[cs]e|which is better|what would you do|help me|win|winning|losing|lose|keep getting fired|fired|dismiss|struggl|stuck|priorit|counsel|tips?|strategy|why is the board|board (?:is )?(?:unhappy|angry)|confidence (?:is )?(?:low|dropping|falling))/i;

/** "Why…?" questions answered from the company's own figures: which report explains it, and who to ask in the game. */
const INSIGHTS: { re: RegExp; report: string; ask: string; page: GuidePage }[] = [
  { re: /losing money|lose money|\blos(s|ses)\b|unprofitable|not profitable|where (does|did) (the|my|our) money|money go|break.?even|\bmargins?\b|\bcosts?\b|profit/i, report: 'pnl', ask: 'CHR-HOLM', page: 'finance' },
  { re: /marketing|campaign|advertis/i, report: 'marketing', ask: 'CHR-GARNIER', page: 'products' },
  { re: /\bsales\b|selling|sell (more|less|enough)|demand|market share|competitor/i, report: 'sales', ask: 'CHR-GARNIER', page: 'products' },
  { re: /\bcash\b|liquidity|run out of money|insolv|covenant/i, report: 'cash', ask: 'CHR-HOLM', page: 'finance' },
  { re: /production|stock|inventory|\bplants?\b|factor(y|ies)|output/i, report: 'production', ask: 'CHR-MARCHETTI', page: 'operations' },
  { re: /workforce|morale|strike|union|absentee/i, report: 'workforce', ask: 'CHR-OKAFOR', page: 'company' },
  { re: /supplier|battery|supply|shortage/i, report: 'supply', ask: 'CHR-LINDQVIST', page: 'operations' },
];
const WHY_RE = /\b(why|how come|what'?s wrong|what is wrong|explain|understand|decode|break ?down|where does|what happened to|is .* working|does .* work|useful)\b/i;

function insightFor(question: string) {
  return INSIGHTS.find((x) => x.re.test(question)) ?? null;
}

function whoIs(db: DB | null, id: string): string {
  try {
    const c = db ? loadWorld(db).characters.find((x) => x.id === id) : null;
    return c ? `${c.name} (${c.title})` : 'the executive in charge';
  } catch {
    return 'the executive in charge';
  }
}

function safeReport(db: DB | null, key: string): Report | null {
  if (!db) return null;
  try {
    return buildReport(db, loadWorld(db), key, null, 'coach');
  } catch {
    return null;
  }
}

/** A coach's answer to a "why…?" question, from the report that explains it. */
function fromReport(r: Report, ins: NonNullable<ReturnType<typeof insightFor>>, question: string, who: string): GuideAnswer {
  const findings = r.blocks.flatMap((b) => (b.kind === 'bullets' ? b.items : [])).filter((f) => !r.summary.includes(f.text.slice(4, 40))).sort((a, b) => (b.tone === 'critical' ? 2 : b.tone === 'warning' ? 1 : 0) - (a.tone === 'critical' ? 2 : a.tone === 'warning' ? 1 : 0));
  return {
    answer: `${r.summary}${findings.length ? ` What stands out: ${findings.slice(0, 3).map((f) => f.text.replace(/\.$/, '')).join('; ')}.` : ''}`,
    steps: [],
    notes: [`Open ${PAGE_LABEL[ins.page]} for the full “${r.title}”, or ask ${who} with “Ask someone” — they will send you the report and their view.`],
    pages: [{ page: ins.page, label: PAGE_LABEL[ins.page] }],
    topics: [],
    source: 'manual',
    related: retrieve(question, 2).map((h) => ({ id: h.topic.id, title: h.topic.title })),
  };
}

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

function coachText(r: CoachReport): string {
  const c = r.confidence;
  return [
    `Headline: ${r.headline}`,
    `Board confidence ${Math.round(c.now)} now, heading for ${Math.round(c.target)}; ≈${Math.round(c.projectedNextMeeting)} after the ${c.nextMeeting} meeting. Dismissal: below ${c.threshold} at ${c.strikesAllowed} regular meetings in a row (strikes so far: ${c.strikes}).`,
    `Confidence drivers: ${c.drivers.map((d) => `${d.label} ${d.delta > 0 ? '+' : ''}${d.delta.toFixed(0)}`).join('; ') || 'none material'}.`,
    `Mandate score ${r.mandate.score}/100 (renewal at ${r.mandate.passScore}); final review ${r.mandate.termEnd}. Objectives: ${r.mandate.objectives.map((o) => `${o.label} ${Math.round(o.score * o.weight)}/${o.weight} (${o.state}: ${o.detail})`).join('; ')}.`,
    'Advice, most urgent first:',
    ...r.advice.slice(0, 10).map((a, i) => `${i + 1}. [priority ${a.priority}] ${a.title} — ${a.why} Steps: ${a.steps.join(' / ')}${a.action ? ` (one-click: ${a.action.label})` : ''}${a.deadline ? ` Deadline ${a.deadline}.` : ''}`),
    `Principles: ${r.principles.join(' ')}`,
  ].join('\n');
}

function safeCoach(db: DB | null): CoachReport | null {
  if (!db) return null;
  try {
    return coachReport(db, loadWorld(db));
  } catch {
    return null;
  }
}

/** Advice answer built directly from the Coach report (no LLM). */
function fromCoach(r: CoachReport): GuideAnswer {
  const top = r.advice.slice(0, 3);
  const c = r.confidence;
  const answer = `${r.headline} What weighs most on the board right now: ${c.drivers.filter((d) => d.delta < 0).slice(0, 3).map((d) => `${/^[A-Z][a-z]/.test(d.label) ? d.label.charAt(0).toLowerCase() + d.label.slice(1) : d.label} (${d.delta.toFixed(0)})`).join(', ') || 'nothing negative'}.${top.length ? ` Where I'd look first: ${top.map((a, i) => `${i + 1}) ${a.title}`).join('; ')}.` : ''}`;
  const best = top[0];
  return {
    answer,
    steps: best ? [`Why “${best.title}” first: ${best.why}`] : [],
    notes: ['That is the direction, not the whole route: ask me “how do I …?” for the steps, or open “Show me how” in my read of your company above.'],
    pages: best?.link ? [{ page: best.link.page as GuidePage, label: PAGE_LABEL[best.link.page as GuidePage] ?? best.link.label }] : [],
    topics: [],
    source: 'manual',
    related: MANUAL.filter((t) => ['how-to-win', 'board-confidence'].includes(t.id)).map((t) => ({ id: t.id, title: t.title })),
    actions: top.filter((a) => a.action).map((a) => a.action!),
  };
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
    answer: { type: 'string', description: 'Two to five sentences answering the question as a coach.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'Numbered how-to steps naming the exact pages, tabs and buttons from the manual (empty unless the player asked how to do something).' },
    pages: { type: 'array', items: { type: 'string', enum: PAGES }, description: 'Pages the player should open.' },
    topic_ids: { type: 'array', items: { type: 'string', enum: MANUAL.map((m) => m.id) }, description: 'Manual entries the answer is based on.' },
  },
  required: ['answer', 'steps', 'pages', 'topic_ids'],
};

const SYSTEM = [
  'You are the Coach of "Automanager", an automotive CEO simulation. You are NOT part of the game: no character hears you and nothing you say changes the company. You are a friendly, experienced coach sitting beside the player.',
  'Answer ANY question about the game: how to do something (which page, tab and button), how a mechanism works, why something is happening in their company, what to do next, or general strategy.',
  'For how-to questions, give the steps from the MANUAL using the exact names of pages, tabs and buttons written there.',
  'For "why" questions about the company, explain the cause from the COMPANY FIGURES and the COACH ANALYSIS in plain words with one or two numbers, and say who in the game to ask or which report to open for more.',
  'For "what should I do" questions, use the COACH ANALYSIS: point to the two or three things that matter most and why. Give direction and hints — the mechanism and what to look at — rather than a complete walkthrough; offer the detailed steps if they want them ("ask me how"). Never claim certainty about the future.',
  'Never invent features, numbers or rules that are not in the MANUAL, GAME FACTS, COMPANY FIGURES or COACH ANALYSIS. If something is not covered, say so briefly. Keep it short and practical — a few sentences.',
  'Respond ONLY with JSON matching the schema.',
].join('\n');

function fromManual(question: string): GuideAnswer {
  const hits = retrieve(question);
  if (!hits.length) {
    const basics = MANUAL.find((t) => t.id === 'basics')!;
    return {
      answer: `I could not find that in the manual. Try asking about a specific task — for example “How do I hire more people?”, “How do I get the board to approve a project?” or “How do I send a report to someone?”.`,
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
    answer: best.summary,
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
  const howTo = /^\s*(how (?:do|can|to|should)\b|where (?:do|can|is)\b)/i.test(q) && !/^\s*how come\b/i.test(q);
  const wantsAdvice = ADVICE_RE.test(q) && !howTo;
  const coach = safeCoach(db);
  const ins = insightFor(q);
  const wantsWhy = !howTo && !!ins && (WHY_RE.test(q) || !retrieve(q).length);
  const insightReport = ins ? safeReport(db, ins.report) : null;
  const manualAnswer = wantsWhy && insightReport ? fromReport(insightReport, ins!, q, whoIs(db, ins!.ask)) : wantsAdvice && coach ? fromCoach(coach) : fromManual(q);
  if (!llm.provider.available) return manualAnswer;
  const t0 = Date.now();
  const figures = db ? [safeReport(db, 'pnl'), safeReport(db, 'unit_economics'), insightReport && !['pnl', 'unit_economics'].includes(insightReport.key) ? insightReport : null].filter(Boolean).map((r) => reportToText(r!, 1800)).join('\n\n') : '';
  const user = [`MANUAL:\n${manualText()}`, `GAME FACTS:\n${liveFacts(db)}`, ...(figures ? [`COMPANY FIGURES:\n${figures}`] : []), ...(coach ? [`COACH ANALYSIS:\n${coachText(coach)}`] : []), `The player is on the page: ${page && (PAGES as string[]).includes(page) ? PAGE_LABEL[page as GuidePage] : 'unknown'}.`, `QUESTION:\n${q}`].join('\n\n');
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
      actions: wantsAdvice ? manualAnswer.actions : undefined,
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
