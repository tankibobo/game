import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { sendMessage, startConversation } from '../server/llm/conversation';
import { ClaudeCodeProvider, type QueryFn } from '../server/llm/claudeCode';
import { providerFromEnv } from '../server/llm/config';
import { CHARACTER_TURN_JSON_SCHEMA } from '../server/llm/schemas';
import { LlmError } from '../server/llm/provider';
import { newGameDb, withProvider } from './helpers';

/** Fake Claude Code session: records the call and replays the given messages. */
function fakeQuery(script: (options: Options) => Partial<SDKMessage>[] | Promise<never>) {
  const calls: { prompt: string; options: Options }[] = [];
  const fn: QueryFn = (params) => {
    const options = params.options ?? {};
    calls.push({ prompt: params.prompt, options });
    return (async function* () {
      const msgs = await script(options);
      for (const m of msgs) yield m as SDKMessage;
    })();
  };
  return { fn, calls };
}

const init = (model = 'claude-opus-5-5') => ({ type: 'system', subtype: 'init', model }) as Partial<SDKMessage>;
const success = (structured: unknown, result = '') => ({ type: 'result', subtype: 'success', is_error: false, result, structured_output: structured, usage: { input_tokens: 1200, output_tokens: 90 } }) as unknown as Partial<SDKMessage>;
const req = (over: Partial<Parameters<ClaudeCodeProvider['complete']>[0]> = {}) => ({ system: 'You are Marta.', messages: [{ role: 'user' as const, content: 'Hello' }], schema: { type: 'object' }, maxTokens: 500, timeoutMs: 2000, purpose: 'test', ...over });

describe('Claude subscription provider (Claude Agent SDK)', () => {
  it('runs a locked-down, tool-less session on the subscription login and returns the structured output', async () => {
    const q = fakeQuery(() => [init(), success({ dialogue: 'Morning.' })]);
    const p = new ClaudeCodeProvider({ queryFn: q.fn, env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-should-not-leak', ANTHROPIC_AUTH_TOKEN: 'tok', CLAUDECODE: '1' } });
    const r = await p.complete(req());
    expect(JSON.parse(r.text)).toEqual({ dialogue: 'Morning.' });
    expect(r.model).toBe('claude-opus-5-5');
    expect(r.inputTokens).toBe(1200);
    expect(p.status).toBe('ok');
    const o = q.calls[0].options;
    expect(q.calls[0].prompt).toBe('Hello');
    expect(o.systemPrompt).toBe('You are Marta.');
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.mcpServers).toEqual({});
    expect(o.strictMcpConfig).toBe(true);
    expect(o.persistSession).toBe(false);
    expect(o.outputFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
    // An API key would take precedence over the subscription login, so it must never reach the child.
    expect(o.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(o.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(o.env?.CLAUDECODE).toBeUndefined();
    expect(o.env?.PATH).toBe('/usr/bin');
    expect(o.model).toBeUndefined();
  });

  it('passes a chosen model and falls back to the result text when no structured output is attached', async () => {
    const q = fakeQuery(() => [init('claude-sonnet-5-5'), success(undefined, '{"dialogue":"Fine."}')]);
    const p = new ClaudeCodeProvider({ queryFn: q.fn, model: 'sonnet', env: {} });
    const r = await p.complete(req());
    expect(q.calls[0].options.model).toBe('sonnet');
    expect(r.text).toBe('{"dialogue":"Fine."}');
    expect(p.model).toBe('claude-sonnet-5-5');
  });

  it('reports a missing login clearly and pauses retries instead of stalling every meeting', async () => {
    const q = fakeQuery(() => [
      { type: 'assistant', error: 'authentication_failed', message: { content: [] } } as unknown as Partial<SDKMessage>,
      { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' } as unknown as Partial<SDKMessage>,
    ]);
    const p = new ClaudeCodeProvider({ queryFn: q.fn, env: {} });
    await expect(p.complete(req())).rejects.toMatchObject({ kind: 'not_configured' });
    expect(p.available).toBe(false);
    expect(p.statusNote).toMatch(/\/login/);
    await expect(p.complete(req())).rejects.toBeInstanceOf(LlmError);
    expect(q.calls).toHaveLength(1); // second attempt short-circuited during the cool-down
  });

  it('maps usage limits, structured-output failures and timeouts', async () => {
    const limited = new ClaudeCodeProvider({ queryFn: fakeQuery(() => [{ type: 'assistant', error: 'rate_limit', message: { content: [] } } as unknown as Partial<SDKMessage>, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['usage limit reached'] } as unknown as Partial<SDKMessage>]).fn, env: {} });
    await expect(limited.complete(req())).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(limited.available).toBe(true);

    const bad = new ClaudeCodeProvider({ queryFn: fakeQuery(() => [{ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, errors: [] } as unknown as Partial<SDKMessage>]).fn, env: {} });
    await expect(bad.complete(req())).rejects.toMatchObject({ kind: 'invalid_output' });

    const slow = new ClaudeCodeProvider({
      queryFn: fakeQuery(
        (o) =>
          new Promise<never>((_, reject) => {
            o.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ).fn,
      env: {},
    });
    await expect(slow.complete(req({ timeoutMs: 50 }))).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('voices a character end-to-end; the engine still validates everything it proposes', async () => {
    const turn = {
      dialogue: 'Liquidity is fine for now, but the 2028 notes worry me.',
      emotion: 'concerned',
      perspective: { stance: 'skeptical', concerns: ['refinancing'], interests: [] },
      proposed_actions: [{ type: 'set_marketing_budget', params_json: JSON.stringify({ monthlyCents: -5 }), rationale: 'nonsense amount' }],
      claims: [],
      memory_candidates: [],
      ceo_commitments: [],
      event_proposals: [],
      trust_delta: 0,
      trust_reason: 'routine',
      follow_up_questions: [],
      summary_update: 'Discussed runway.',
    };
    const q = fakeQuery(() => [init(), success(turn)]);
    const { db } = newGameDb();
    const conv = startConversation(db, 'CHR-HOLM');
    const r = await sendMessage(db, withProvider(new ClaudeCodeProvider({ queryFn: q.fn, env: {} })), conv.id, 'How much runway do we have?');
    expect(r.mode).toBe('llm');
    expect(r.reply.content).toContain('2028 notes');
    expect(q.calls[0].options.outputFormat).toEqual({ type: 'json_schema', schema: CHARACTER_TURN_JSON_SCHEMA });
    expect(r.actions.every((a) => a.status !== 'committed')).toBe(true);
  });

  it('defaults to the subscription provider; the API needs an explicit opt-in', () => {
    expect(providerFromEnv({}).provider.name).toBe('claude-code');
    expect(providerFromEnv({ ANTHROPIC_API_KEY: 'sk-x' }).provider.name).toBe('claude-code');
    expect(providerFromEnv({ LLM_PROVIDER: 'subscription', CLAUDE_MODEL: 'opus' }).provider.model).toBe('opus');
    expect(providerFromEnv({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' }).provider.name).toBe('anthropic');
    expect(providerFromEnv({ LLM_PROVIDER: 'none' }).provider.available).toBe(false);
    expect(providerFromEnv({}).timeoutMs).toBe(120_000);
  });
});
