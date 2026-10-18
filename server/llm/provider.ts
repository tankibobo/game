/**
 * LLM provider abstraction. Providers return raw JSON text for a structured
 * request; callers treat it as untrusted and validate it. API keys are read
 * from the server environment only and never sent to the browser.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface LlmRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** JSON Schema the response must follow. */
  schema: Record<string, unknown>;
  maxTokens: number;
  timeoutMs: number;
  purpose: string;
}

export interface LlmResponse {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly available: boolean;
  /** Optional human-readable connection problem, shown in the UI. */
  readonly statusNote?: string | null;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_configured' | 'timeout' | 'rate_limited' | 'api_error' | 'refusal' | 'invalid_output' | 'network',
  ) {
    super(message);
  }
}

export class NoneProvider implements LlmProvider {
  readonly name = 'none';
  readonly model = 'deterministic-fallback';
  readonly available = false;
  async complete(): Promise<LlmResponse> {
    throw new LlmError('No LLM provider configured (deterministic mode).', 'not_configured');
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly available = true;
  private client: Anthropic;
  constructor(
    apiKey: string,
    readonly model: string,
    private effort: 'low' | 'medium' | 'high',
    private fallbacks: boolean,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 1 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      output_config: { effort: this.effort, format: { type: 'json_schema', schema: req.schema } },
    };
    try {
      let msg;
      try {
        msg = this.fallbacks
          ? await this.client.beta.messages.create({ ...(body as object), betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as never, { timeout: req.timeoutMs })
          : await this.client.messages.create(body as never, { timeout: req.timeoutMs });
      } catch (e) {
        // If the account/model rejects the fallback beta, retry once without it.
        if (this.fallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
          this.fallbacks = false;
          msg = await this.client.messages.create(body as never, { timeout: req.timeoutMs });
        } else throw e;
      }
      const m = msg as unknown as { stop_reason: string; content: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; model: string };
      if (m.stop_reason === 'refusal') throw new LlmError('The model declined to respond.', 'refusal');
      if (m.stop_reason === 'max_tokens') throw new LlmError('Response truncated (max_tokens).', 'invalid_output');
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      return { text, inputTokens: m.usage?.input_tokens ?? null, outputTokens: m.usage?.output_tokens ?? null, model: m.model };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new LlmError('LLM request timed out.', 'timeout');
      if (e instanceof Anthropic.RateLimitError) throw new LlmError('LLM rate limit reached.', 'rate_limited');
      if (e instanceof Anthropic.AuthenticationError) throw new LlmError('LLM authentication failed (check ANTHROPIC_API_KEY).', 'not_configured');
      if (e instanceof Anthropic.APIConnectionError) throw new LlmError(`LLM connection failed: ${e.message}`, 'network');
      if (e instanceof Anthropic.APIError) throw new LlmError(`LLM API error ${e.status}: ${e.message}`, 'api_error');
      throw new LlmError(`LLM call failed: ${e instanceof Error ? e.message : String(e)}`, 'api_error');
    }
  }
}

/** Test double: returns scripted outputs (or throws) in order. */
export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly model = 'scripted';
  readonly available = true;
  calls: LlmRequest[] = [];
  constructor(private script: (string | Error | ((req: LlmRequest) => string))[]) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const next = this.script.shift();
    if (next === undefined) throw new LlmError('script exhausted', 'api_error');
    if (next instanceof Error) throw next;
    const text = typeof next === 'function' ? next(req) : next;
    return { text, inputTokens: null, outputTokens: null, model: 'scripted' };
  }
}

export interface LlmConfig {
  provider: LlmProvider;
  timeoutMs: number;
}
