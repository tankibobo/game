import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Empty, Status } from '../components/ui';
import { ClaudeConnection } from '../components/ClaudeLink';
import { useGame } from '../ctx';
import { fmtDate } from '../format';

function useSaves() {
  const { version } = useGame();
  const [saves, setSaves] = useState<any>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    api.get('/saves').then(setSaves).catch(() => setSaves({ saves: [] }));
  }, [version, n]);
  return { saves, reload: () => setN((x) => x + 1) };
}

function SaveList({ onLoaded }: { onLoaded?: () => void }) {
  const { refresh, toast } = useGame();
  const { saves, reload } = useSaves();
  if (!saves) return <Empty>Loading…</Empty>;
  if (!saves.saves.length) return <Empty>No saved games yet.</Empty>;
  return (
    <table>
      <thead><tr><th>Save</th><th>Scenario</th><th>Simulation date</th><th>Status</th><th>Last written</th><th></th></tr></thead>
      <tbody>
        {saves.saves.map((s: any) => (
          <tr key={s.id}>
            <td className="strong">{s.name}{s.active && <span className="pill info" style={{ marginLeft: 6 }}>active</span>}<div className="tiny muted mono">{s.id}</div></td>
            <td className="small">{s.scenario ?? '—'}<div className="tiny muted">{s.difficulty ? `${s.difficulty[0].toUpperCase()}${s.difficulty.slice(1)}` : ''}{s.seed ? ` · seed ${s.seed}` : ''}</div></td>
            <td>{s.currentDate ? fmtDate(s.currentDate, 'long') : '—'}</td>
            <td><Status s={s.status} /></td>
            <td className="small">{new Date(s.updatedAt).toLocaleString()}</td>
            <td>
              <div className="row">
                <button className="btn sm" disabled={s.active} onClick={async () => { await api.post('/saves/load', { id: s.id }); toast(`Loaded “${s.name}”.`, 'success'); refresh(); onLoaded?.(); }}>Load</button>
                <button className="btn sm danger" disabled={s.active} onClick={async () => { if (!confirm(`Delete “${s.name}” permanently?`)) return; try { await api.del(`/saves/${s.id}`); reload(); } catch (e) { toast((e as Error).message, 'error'); } }}>Delete</button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface ScenarioInfo { key: string; name: string; challenge: string; tagline: string; brief: string }
interface DifficultyInfo { key: string; label: string; description: string; passScore: number }

const CHALLENGE_TONE: Record<string, string> = { Gentler: 'good', Standard: 'info', Tougher: 'warning' };

function NewGame({ onCreated }: { onCreated?: () => void }) {
  const { refresh, toast } = useGame();
  const [opts, setOpts] = useState<{ scenarios: ScenarioInfo[]; difficulties: DifficultyInfo[] } | null>(null);
  const [scenario, setScenario] = useState('turnaround');
  const [difficulty, setDifficulty] = useState('standard');
  const [name, setName] = useState('');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/scenarios').then(setOpts).catch(() => setOpts({ scenarios: [], difficulties: [] }));
  }, []);
  const sc = opts?.scenarios.find((x) => x.key === scenario);
  const start = async () => {
    setBusy(true);
    try {
      await api.post('/game/new', { name: name.trim() || `${sc?.name ?? 'Asterion'} (${difficulty})`, seed: seed ? Number(seed) : undefined, scenario, difficulty });
      toast('New game created. Welcome, CEO.', 'success');
      refresh();
      onCreated?.();
      window.location.hash = '/dashboard';
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!opts) return <Empty>Loading scenarios…</Empty>;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div>
        <div className="small strong" style={{ marginBottom: 6 }}>1. Choose a starting situation</div>
        <div className="scenario-grid" role="radiogroup" aria-label="Scenario">
          {opts.scenarios.map((x) => (
            <button key={x.key} role="radio" aria-checked={x.key === scenario} className={`scenario-card${x.key === scenario ? ' selected' : ''}`} onClick={() => setScenario(x.key)}>
              <div className="row" style={{ gap: 6 }}>
                <span className="strong small" style={{ flex: 1, textAlign: 'left' }}>{x.name}</span>
                <span className={`pill ${CHALLENGE_TONE[x.challenge] ?? ''}`}>{x.challenge}</span>
              </div>
              <div className="tiny muted" style={{ textAlign: 'left', marginTop: 4 }}>{x.tagline}</div>
            </button>
          ))}
        </div>
        {sc && (
          <details className="scenario-brief">
            <summary className="small">Read the full briefing for “{sc.name}”</summary>
            <div className="pre small">{sc.brief}</div>
          </details>
        )}
      </div>
      <div>
        <div className="small strong" style={{ marginBottom: 6 }}>2. Choose how strict the board is</div>
        <div className="difficulty-row" role="radiogroup" aria-label="Difficulty">
          {opts.difficulties.map((d) => (
            <button key={d.key} role="radio" aria-checked={d.key === difficulty} className={`scenario-card${d.key === difficulty ? ' selected' : ''}`} onClick={() => setDifficulty(d.key)}>
              <div className="strong small" style={{ textAlign: 'left' }}>{d.label}</div>
              <div className="tiny muted" style={{ textAlign: 'left', marginTop: 4 }}>{d.description} Renewal at the end of the mandate needs {d.passScore}/100.</div>
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="small strong" style={{ marginBottom: 6 }}>3. Name and seed</div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${sc?.name ?? 'Asterion'} (${difficulty})`} aria-label="Save name" />
          <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="seed (optional)" style={{ width: 150 }} aria-label="Random seed" />
          <button className="btn sm" onClick={() => setSeed(String(1 + Math.floor(Math.random() * 999_999_999)))} title="The seed decides random events (market shocks, breakdowns, timing). The same seed and choices replay the same game.">Random seed</button>
        </div>
        <div className="tiny muted" style={{ marginTop: 4 }}>The seed decides chance events (market shocks, breakdowns, the timing of surprises). Leave it empty for the standard game; the same seed replays the same luck.</div>
      </div>
      <div><button className="btn primary" disabled={busy} onClick={start}>{busy ? 'Creating…' : 'Start new game'}</button></div>
    </div>
  );
}

export function Saves() {
  const { toast, refresh, status } = useGame();
  const [as, setAs] = useState('');
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Saves</h1>
          <p>Progress is written to the active save continuously (every decision and every day). “Save as” snapshots it to a separate slot you can return to.</p>
        </div>
      </div>
      <div className="stack">
        <Card title="Save the current game as…">
          <div className="row">
            <input type="text" value={as} onChange={(e) => setAs(e.target.value)} placeholder="e.g. Before the April board" aria-label="Snapshot name" />
            <button className="btn" disabled={!as.trim()} onClick={async () => { try { await api.post('/saves/save-as', { name: as.trim() }); toast('Snapshot saved.', 'success'); setAs(''); refresh(); } catch (e) { toast((e as Error).message, 'error'); } }}>Save snapshot</button>
            <span className="small muted">Active: {status?.activeSave}</span>
          </div>
        </Card>
        <Card title="Saved games" flush><SaveList /></Card>
        <Card title="Claude"><ClaudeConnection /></Card>
        <Card title="Start a new game"><NewGame /></Card>
      </div>
    </div>
  );
}

export function Setup() {
  return (
    <div className="setup">
      <div className="hero">Automanager</div>
      <div className="sub" style={{ fontSize: 15, marginBottom: 18 }}>The weight of decisions — an automotive CEO simulator</div>
      <Card title="How it works">
        <div className="small sub">
          You are the new CEO of Asterion Automotive, a European carmaker in trouble. You have a three-year mandate from the board. Talk to your executives, the board, the union, banks and suppliers in natural language. They answer in character — but nothing they say changes the company. Every decision is a validated action with calculated consequences, and the simulation engine alone decides what happens to cash, production, projects and people. Time only moves when you advance it. Stuck? Open <strong>? Guide → Coach</strong> at any time for advice on what to fix first.
        </div>
        <div style={{ marginTop: 10 }}><ClaudeConnection /></div>
      </Card>
      <div style={{ height: 14 }} />
      <Card title="Start a new game"><NewGame /></Card>
      <div style={{ height: 14 }} />
      <Card title="Or load a saved game" flush><SaveList /></Card>
    </div>
  );
}
