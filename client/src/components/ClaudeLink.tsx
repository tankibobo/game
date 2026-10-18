import { useState } from 'react';
import { api } from '../api';
import { useGame } from '../ctx';

/** Short label for whichever provider voices the characters. */
export function llmLabel(llm: any): string {
  if (!llm) return '…';
  if (llm.provider === 'claude-code') return `Claude · your subscription${llm.model && llm.model !== 'subscription default' ? ` (${llm.model})` : ''}`;
  if (llm.provider === 'anthropic') return `Claude API · ${llm.model}`;
  return 'deterministic characters';
}

/** Connection card: what voices the characters, and a one-click live check. */
export function ClaudeConnection() {
  const { status, refresh } = useGame();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const llm = status?.llm;
  const sub = llm?.provider === 'claude-code';
  const test = async () => {
    setBusy(true);
    setRes(null);
    try {
      setRes(await api.post('/llm/test'));
    } catch (e) {
      setRes({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return (
    <div className="small">
      <div>
        Character voices: <strong>{llmLabel(llm)}</strong>
        {llm && !llm.available && llm.provider !== 'none' && <span className="pill warning" style={{ marginLeft: 6 }}>not connected</span>}
      </div>
      {sub && <div className="tiny muted" style={{ marginTop: 4 }}>Uses the Claude account you are signed in to with Claude Code on this computer — no API key. Each character reply uses a little of your plan’s usage. If Claude is unreachable, characters fall back to the deterministic responder; the simulation is unaffected.</div>}
      {llm?.provider === 'none' && <div className="tiny muted" style={{ marginTop: 4 }}>Set LLM_PROVIDER=claude-code in .env (and sign in with <code>claude</code> → <code>/login</code>) to have Claude voice the characters.</div>}
      {llm?.note && <div className="callout warning tiny" style={{ marginTop: 6 }}>{llm.note}</div>}
      {llm?.provider !== 'none' && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn sm" disabled={busy} onClick={test}>{busy ? 'Asking Claude…' : 'Test Claude connection'}</button>
          {res && (res.ok ? <span className="pill good" title={res.greeting}>Connected · {res.model} · {(res.latencyMs / 1000).toFixed(1)} s</span> : <span className="pill critical">Failed</span>)}
        </div>
      )}
      {res?.ok && <div className="tiny muted" style={{ marginTop: 4 }}>“{res.greeting}”</div>}
      {res && !res.ok && <div className="tiny" style={{ marginTop: 4, color: 'var(--critical-text)' }}>{res.error}</div>}
    </div>
  );
}
