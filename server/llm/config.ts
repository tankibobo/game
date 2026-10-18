/**
 * Chooses the character-dialogue provider from the server environment.
 *
 *   LLM_PROVIDER=claude-code  (default) Claude through your Claude subscription
 *                             login — no API key involved.
 *   LLM_PROVIDER=anthropic    Claude API with ANTHROPIC_API_KEY.
 *   LLM_PROVIDER=none         Deterministic characters only.
 *
 * Whatever is chosen, a failed call falls back to the deterministic responder.
 */
import { ClaudeCodeProvider } from './claudeCode';
import { AnthropicProvider, NoneProvider, type LlmConfig } from './provider';

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const choice = (env.LLM_PROVIDER || 'claude-code').toLowerCase();
  if (['claude-code', 'claude', 'subscription'].includes(choice)) {
    const effort = (env.CLAUDE_EFFORT || 'low') as 'low' | 'medium' | 'high';
    return {
      provider: new ClaudeCodeProvider({ model: env.CLAUDE_MODEL || undefined, effort, executable: env.CLAUDE_CODE_PATH || undefined }),
      timeoutMs: Number(env.LLM_TIMEOUT_MS || 120_000),
    };
  }
  const timeoutMs = Number(env.LLM_TIMEOUT_MS || 60_000);
  if (choice === 'anthropic' && env.ANTHROPIC_API_KEY) {
    const effort = (env.ANTHROPIC_EFFORT || 'low') as 'low' | 'medium' | 'high';
    return { provider: new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || 'claude-opus-5-5', effort, (env.ANTHROPIC_FALLBACKS ?? 'on') !== 'off'), timeoutMs };
  }
  return { provider: new NoneProvider(), timeoutMs };
}
