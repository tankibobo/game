/**
 * Output contracts for LLM calls. The JSON Schemas are sent to the model as
 * structured-output formats; the Zod schemas re-validate every response on
 * the server (LLM output is untrusted input).
 */
import { z } from 'zod';

export const STANCES = ['supportive', 'neutral', 'skeptical', 'opposed'] as const;
export const BASES = ['fact', 'estimate', 'belief', 'rumor', 'unknown'] as const;
export const MEMORY_KINDS = ['conversation', 'promise', 'grievance', 'praise', 'observation', 'decision', 'negotiation'] as const;

export const CharacterTurnSchema = z.object({
  dialogue: z.string().min(1).max(4000),
  emotion: z.string().max(60),
  perspective: z.object({ stance: z.enum(STANCES), concerns: z.array(z.string().max(300)).max(6), interests: z.array(z.string().max(300)).max(6) }),
  proposed_actions: z.array(z.object({ type: z.string().max(40), params_json: z.string().max(3000), rationale: z.string().max(800) })).max(4),
  claims: z.array(z.object({ statement: z.string().max(400), basis: z.enum(BASES), entity_ids: z.array(z.string().max(40)).max(8) })).max(8),
  memory_candidates: z.array(z.object({ summary: z.string().max(400), importance: z.number().int().min(1).max(5), sentiment: z.number().int().min(-2).max(2), kind: z.enum(MEMORY_KINDS) })).max(4),
  ceo_commitments: z.array(z.object({ description: z.string().max(400), due_date: z.string().nullable(), promisee_id: z.string().max(40) })).max(3),
  event_proposals: z.array(z.object({ event_key: z.string().max(60), entity_id: z.string().max(40).nullable(), rationale: z.string().max(300) })).max(2),
  trust_delta: z.number().int().min(-3).max(3),
  trust_reason: z.string().max(300),
  follow_up_questions: z.array(z.string().max(300)).max(3),
  summary_update: z.string().max(1200),
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
  memory_candidates: { type: 'array', description: 'What this character would remember from this exchange (0–2 items).', items: obj({ summary: str, importance: { type: 'integer' }, sentiment: { type: 'integer' }, kind: { type: 'string', enum: [...MEMORY_KINDS] } }) },
  ceo_commitments: { type: 'array', description: 'Explicit promises the CEO made in their latest message (not the character’s). Empty if none.', items: obj({ description: str, due_date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'YYYY-MM-DD or null' }, promisee_id: str }) },
  event_proposals: { type: 'array', description: 'Rarely: an escalation this character would initiate (e.g. union_strike_notice). Must be an event key from the context. Usually empty.', items: obj({ event_key: str, entity_id: { anyOf: [{ type: 'string' }, { type: 'null' }] }, rationale: str }) },
  trust_delta: { type: 'integer', description: 'Change in the character’s trust in the CEO from this message, −3…+3.' },
  trust_reason: str,
  follow_up_questions: strArr,
  summary_update: { type: 'string', description: 'Updated running summary of this conversation (≤ 1,000 characters), facts and agreements first.' },
});

export const ArgumentAssessmentSchema = z.object({
  quality: z.enum(['weak', 'moderate', 'strong']),
  evidence_entity_ids: z.array(z.string().max(40)).max(8),
  reasoning: z.string().max(600),
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
