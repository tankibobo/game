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
      <thead><tr><th>Save</th><th>Simulation date</th><th>Status</th><th>Last written</th><th></th></tr></thead>
      <tbody>
        {saves.saves.map((s: any) => (
          <tr key={s.id}>
            <td className="strong">{s.name}{s.active && <span className="pill info" style={{ marginLeft: 6 }}>active</span>}<div className="tiny muted mono">{s.id}</div></td>
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

function NewGame({ onCreated }: { onCreated?: () => void }) {
  const { refresh, toast } = useGame();
  const [name, setName] = useState('Asterion turnaround');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="row">
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Save name" />
      <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="seed (optional)" style={{ width: 150 }} aria-label="Random seed" />
      <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await api.post('/game/new', { name, seed: seed ? Number(seed) : undefined }); toast('New game created. Welcome, CEO.', 'success'); refresh(); onCreated?.(); window.location.hash = '/dashboard'; } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); } }}>{busy ? 'Creating…' : 'Start new game'}</button>
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
        <Card title="New game"><NewGame /></Card>
      </div>
    </div>
  );
}

export function Setup() {
  const { status } = useGame();
  return (
    <div className="setup">
      <div className="hero">Automanager</div>
      <div className="sub" style={{ fontSize: 15, marginBottom: 18 }}>The weight of decisions — an automotive CEO simulator</div>
      <Card title="Your situation">
        <div className="pre">{status?.brief}</div>
        <hr className="sep" />
        <div className="small sub">
          Talk to your executives, the board, the union, banks and suppliers in natural language. They answer in character — but nothing they say changes the company. Every decision is a validated action with calculated consequences, and the simulation engine alone decides what happens to cash, production, projects and people. Time only moves when you advance it.
        </div>
        <div style={{ marginTop: 10 }}><ClaudeConnection /></div>
      </Card>
      <div style={{ height: 14 }} />
      <Card title="Start"><NewGame /></Card>
      <div style={{ height: 14 }} />
      <Card title="Or load a saved game" flush><SaveList /></Card>
    </div>
  );
}
