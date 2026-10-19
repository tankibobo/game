/**
 * Output contracts for LLM calls. The JSON Schemas are sent to the model as
 * structured-output formats; the Zod schemas re-validate every response on
 * the server (LLM output is untrusted input).
 */
import { z } from 'zod';

export const STANCES = ['supportive', 'neutral', 'skeptical', 'opposed'] as const;
export const BASES = ['fact', 'estimate', 'belief', 'rumor', 'unknown'] as const;
export const MEMORY_KINDS = ['conversation', 'promise', 'grievance', 'praise', 'observation', 'decision', 'negotiation'] as const;

/*
 * The Zod schemas below are the server-side gate. They repair harmless slips
 * instead of discarding a whole in-character reply over one detail: numbers
 * are rounded and clamped into range, over-long text is trimmed, extra list
 * items are dropped and an unknown label becomes the most cautious value
 * (e.g. an unrecognised claim basis becomes "unknown"). A reply is rejected
 * only when it is not JSON or has no usable dialogue. Everything that
 * survives is still validated again downstream (actions, IDs, dates, facts).
 */
const clampInt = (min: number, max: number, fallback: number) =>
  z.preprocess((v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  }, z.number().int().min(min).max(max));
const text = (max: number, fallback = '') => z.preprocess((v) => (typeof v === 'string' ? v.slice(0, max) : v === null || v === undefined ? fallback : String(v).slice(0, max)), z.string().max(max));
const list = <T extends z.ZodType>(item: T, max: number) => z.preprocess((v) => (Array.isArray(v) ? v.slice(0, max) : []), z.array(item).max(max));
const oneOf = <const T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) => z.preprocess((v) => (typeof v === 'string' && (values as readonly string[]).includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : fallback), z.enum(values));
const nullableText = (max: number) => z.preprocess((v) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null), z.string().max(max).nullable());

export const CharacterTurnSchema = z.object({
  dialogue: z.preprocess((v) => (typeof v === 'string' ? v.trim().slice(0, 4000) : v), z.string().min(1).max(4000)),
  emotion: text(60, 'neutral'),
  perspective: z.preprocess(
    (v) => (v && typeof v === 'object' ? v : {}),
    z.object({ stance: oneOf(STANCES, 'neutral'), concerns: list(text(300), 6), interests: list(text(300), 6) }),
  ),
  proposed_actions: list(z.object({ type: text(40), params_json: z.preprocess((v) => (typeof v === 'string' ? v : JSON.stringify(v ?? {})), z.string().max(3000)), rationale: text(800) }), 4),
  claims: list(z.object({ statement: text(400), basis: oneOf(BASES, 'unknown'), entity_ids: list(text(40), 8) }), 8),
  memory_candidates: list(z.object({ summary: text(400), importance: clampInt(1, 5, 2), sentiment: clampInt(-2, 2, 0), kind: oneOf(MEMORY_KINDS, 'observation') }), 4),
  ceo_commitments: list(z.object({ description: text(400), due_date: nullableText(40), promisee_id: text(40) }), 3),
  event_proposals: list(z.object({ event_key: text(60), entity_id: nullableText(40), rationale: text(300) }), 2),
  trust_delta: clampInt(-3, 3, 0),
  trust_reason: text(300),
  follow_up_questions: list(text(300), 3),
  summary_update: text(1200),
  attach_reports: list(text(80), 3),
  request_reports: list(z.object({ report: text(80), reason: text(300) }), 2),
  share_reports: list(z.object({ report: text(80), recipient_ids: list(text(40), 6), note: text(400) }), 2),
});
export type CharacterTurn = z.infer<typeof CharacterTurnSchema>;

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });

export const CHARACTER_TURN_JSON_SCHEMA = obj({
  dialogue: { type: 'string', description: 'What the character says, in their own voice. Plain prose, no stage directions.' },
  emotion: { type: 'string', description: 'One or two words.' },
  perspective: obj({ stance: { type: 'string', enum: [...STANCES] }, concerns: strArr, interests: strArr }),
  proposed_actions: {
    type: 'array',
    description: 'Concrete actions the character proposes (validated by the simulation; the CEO decides). Empty if none.',
    items: obj({ type: { type: 'string', description: 'An action type from the ACTION CATALOG.' }, params_json: { type: 'string', description: 'JSON object with the action parameters, using IDs from the context.' }, rationale: str }),
  },
  claims: { type: 'array', description: 'Factual claims made in the dialogue, with their epistemic basis and the entity IDs they concern.', items: obj({ statement: str, basis: { type: 'string', enum: [...BASES] }, entity_ids: strArr }) },
  memory_candidates: { type: 'array', description: 'What this character would remember from this exchange (0–2 items).', items: obj({ summary: str, importance: { type: 'integer', enum: [1, 2, 3, 4, 5], description: '1 (trivial) … 5 (unforgettable)' }, sentiment: { type: 'integer', enum: [-2, -1, 0, 1, 2], description: '-2 (very negative) … +2 (very positive); never outside this range' }, kind: { type: 'string', enum: [...MEMORY_KINDS] } }) },
  ceo_commitments: { type: 'array', description: 'Explicit promises the CEO made in their latest message (not the character’s). Empty if none.', items: obj({ description: str, due_date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'YYYY-MM-DD or null' }, promisee_id: str }) },
  event_proposals: { type: 'array', description: 'Rarely: an escalation this character would initiate (e.g. union_strike_notice). Must be an event key from the context. Usually empty.', items: obj({ event_key: str, entity_id: { anyOf: [{ type: 'string' }, { type: 'null' }] }, rationale: str }) },
  trust_delta: { type: 'integer', enum: [-3, -2, -1, 0, 1, 2, 3], description: 'Change in the character’s trust in the CEO from this message, −3…+3.' },
  trust_reason: str,
  follow_up_questions: strArr,
  summary_update: { type: 'string', description: 'Updated running summary of this conversation (≤ 1,000 characters), facts and agreements first.' },
  attach_reports: { type: 'array', items: str, description: 'Reports from YOUR REPORTS (by key, e.g. "pnl" or "project:PRJ-EON") to attach to this answer so the CEO sees the figures and charts. Attach when you give numbers or analysis. Empty if none.' },
  request_reports: { type: 'array', description: 'Reports you need from the CEO to answer well (keys from the REPORT CATALOGUE only). Empty if none.', items: obj({ report: str, reason: str }) },
  share_reports: { type: 'array', description: 'Only when the CEO asks you to: send one of YOUR REPORTS to colleagues (their character IDs). Empty otherwise.', items: obj({ report: str, recipient_ids: strArr, note: str }) },
});

export const ArgumentAssessmentSchema = z.object({
  quality: z.enum(['weak', 'moderate', 'strong']),
  evidence_entity_ids: list(text(40), 8),
  reasoning: text(600),
});
export type ArgumentAssessment = z.infer<typeof ArgumentAssessmentSchema>;

export const ARGUMENT_JSON_SCHEMA = obj({
  quality: { type: 'string', enum: ['weak', 'moderate', 'strong'] },
  evidence_entity_ids: { type: 'array', items: str, description: 'IDs of entities from the context that the CEO’s argument relies on.' },
  reasoning: str,
});

/** Parse model text into JSON (tolerating code fences), then validate. */
export function parseStructured<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, value: r.data };
}
