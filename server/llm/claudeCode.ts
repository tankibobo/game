/**
 * Claude via your Claude subscription (Pro / Max / Team / Enterprise), not an
 * API key. Requests run through the Claude Agent SDK, which drives the Claude
 * Code engine using the account you logged in with (`claude` → `/login`).
 *
 * The game only needs Claude to voice characters, so the session is locked
 * down: no tools, no MCP servers, no CLAUDE.md/settings from disk, no session
 * files, and a custom system prompt. Output is requested as JSON Schema and is
 * treated as untrusted by the caller exactly like the API provider's output.
 *
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from the child
 * environment: Claude Code prefers an API key over the subscription login, so
 * leaving them in would silently bill an API account instead.
 */
import { tmpdir } from 'node:os';
import { query as sdkQuery, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider';

export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeCodeOptions {
  /** Model alias or ID ('opus', 'sonnet', 'haiku', 'claude-opus-5-5', …). Unset = your account's default. */
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  /** Path to a `claude` executable; unset = the one bundled with the SDK. */
  executable?: string;
  /** Injected for tests. */
  queryFn?: QueryFn;
  env?: NodeJS.ProcessEnv;
}

/** After a login/auth failure, stop trying for a while so play stays snappy. */
const AUTH_COOLDOWN_MS = 2 * 60_000;

const LOGIN_HINT = 'Claude subscription not signed in. Run `claude` in a terminal, type /login, and sign in with your Claude account, then try again.';

export class ClaudeCodeProvider implements LlmProvider {
  readonly name = 'claude-code';
  model: string;
  /** Human-readable connection state for the UI. */
  status: 'untested' | 'ok' | 'auth_failed' | 'error' = 'untested';
  statusNote: string | null = null;
  private authFailedAt = 0;
  private queryFn: QueryFn;

  constructor(private opts: ClaudeCodeOptions = {}) {
    this.model = opts.model || 'subscription default';
    this.queryFn = opts.queryFn ?? (sdkQuery as QueryFn);
  }

  get available(): boolean {
    return !(this.status === 'auth_failed' && Date.now() - this.authFailedAt < AUTH_COOLDOWN_MS);
  }

  private childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...(this.opts.env ?? process.env) };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Allow the game server to be started from inside a Claude Code terminal.
    delete env.CLAUDECODE;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'automanager/1.0.0';
    return env;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.available) throw new LlmError(this.statusNote ?? LOGIN_HINT, 'not_configured');
    const prompt = req.messages.length === 1 ? req.messages[0].content : req.messages.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content}`).join('\n\n');
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), req.timeoutMs);
    const options: Options = {
      systemPrompt: req.system,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      maxTurns: 4,
      outputFormat: { type: 'json_schema', schema: req.schema },
      effort: this.opts.effort ?? 'low',
      abortController,
      cwd: tmpdir(),
      env: this.childEnv(),
    };
    if (this.opts.model) options.model = this.opts.model;
    if (this.opts.executable) options.pathToClaudeCodeExecutable = this.opts.executable;

    let model = this.model;
    let assistantError: string | null = null;
    let authError: string | null = null;
    try {
      for await (const msg of this.queryFn({ prompt, options })) {
        if (msg.type === 'system' && msg.subtype === 'init') model = msg.model || model;
        else if (msg.type === 'auth_status' && msg.error) authError = msg.error;
        else if (msg.type === 'assistant' && msg.error) assistantError = msg.error;
        else if (msg.type === 'result') {
          if (msg.subtype !== 'success') {
            const detail = msg.errors?.join('; ') || msg.subtype;
            if (msg.subtype === 'error_max_structured_output_retries') throw new LlmError(`Claude did not produce valid structured output: ${detail}`, 'invalid_output');
            throw this.classify(assistantError ?? authError, detail);
          }
          if (msg.is_error) throw this.classify(assistantError ?? authError, msg.result);
          const text = msg.structured_output !== undefined && msg.structured_output !== null ? JSON.stringify(msg.structured_output) : msg.result;
          this.model = model;
          this.status = 'ok';
          this.statusNote = null;
          return { text, inputTokens: msg.usage?.input_tokens ?? null, outputTokens: msg.usage?.output_tokens ?? null, model };
        }
      }
      throw this.classify(assistantError ?? authError, 'Claude Code ended without a result.');
    } catch (e) {
      if (abortController.signal.aborted) throw new LlmError('Claude (subscription) timed out.', 'timeout');
      if (e instanceof LlmError) throw e;
      throw this.classify(assistantError ?? authError, e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  private classify(code: string | null, detail: string): LlmError {
    const text = `${code ?? ''} ${detail}`;
    if (/authentication_failed|oauth|not logged in|invalid api key|please run \/login|login/i.test(text)) {
      this.status = 'auth_failed';
      this.authFailedAt = Date.now();
      this.statusNote = LOGIN_HINT;
      return new LlmError(LOGIN_HINT, 'not_configured');
    }
    this.status = 'error';
    this.statusNote = detail.slice(0, 300);
    if (/rate_limit|usage limit|rate limit/i.test(text)) return new LlmError(`Claude subscription usage limit reached: ${detail}`, 'rate_limited');
    if (/ENOENT|spawn|executable/i.test(text)) return new LlmError(`Could not start Claude Code: ${detail}`, 'network');
    if (/refusal/i.test(text)) return new LlmError('Claude declined to respond.', 'refusal');
    return new LlmError(`Claude (subscription) error: ${detail}`, 'api_error');
  }
}
