import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useGame, type Page } from '../ctx';
import { Coach } from './Coach';

interface Answer {
  answer: string;
  steps: string[];
  notes: string[];
  pages: { page: Page; label: string }[];
  topics: { id: string; title: string }[];
  related: { id: string; title: string }[];
  source: 'claude' | 'manual';
  actions?: { type: string; payload: Record<string, unknown>; label: string; rationale?: string }[];
}

interface Entry {
  q: string;
  a: Answer | null;
  error?: string;
}

const SUGGESTED: Partial<Record<Page, string[]>> & { default: string[] } = {
  default: ['What should I do first?', 'Why am I losing money?', 'Why is the board unhappy with me?', 'How do I win?', 'Is my marketing working?', 'How do I get the board to approve something?', 'How do I send a report to someone?'],
  dashboard: ['What do the numbers at the top mean?', 'How do I advance time?', 'Where do I see what is in progress?'],
  decisions: ['How do I put several decisions to the board?', 'Where are the proposals my team made?', 'How do I design my own project?'],
  projects: ['What did my project change?', 'How do I get more engineers for a project?', 'How do I design my own project?'],
  inbox: ['How do I negotiate a fleet deal?', 'Why should I sign an agreement?', 'How do I report a promise as kept?'],
  finance: ['Why am I losing money?', 'How do I refinance the bond?', 'Why is cash falling?'],
  company: ['What does Legal do?', 'How does trust work?'],
  operations: ['Why is so much stock piling up?', 'How do I change a production rate?'],
  products: ['Is my marketing working?', 'Why are sales low?', 'How do I launch a campaign?'],
  news: ['What does a competitor promotion do to us?', 'Why did our share price move?'],
};

const KEY = 'automanager.guide.v1';

/**
 * The Coach drawer: a guide outside the game. Its read of the company (where
 * the board stands, what to look at first) and a chat for any question about
 * the game — how to do something, why something happens, what to do next.
 */
export function Guide({ page, onClose }: { page: Page; onClose: () => void; initialTab?: 'coach' | 'howto' }) {
  const { go, status, propose } = useGame();
  const hasGame = !!status?.game;
  const [showRead, setShowRead] = useState(true);
  const [entries, setEntries] = useState<Entry[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as Entry[];
    } catch {
      return [];
    }
  });
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [topics, setTopics] = useState<{ id: string; title: string }[]>([]);
  const [showTopics, setShowTopics] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(entries.slice(-20)));
    } catch {
      /* storage unavailable */
    }
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [entries]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  useEffect(() => {
    api.get('/guide/topics').then((r) => setTopics(r.topics)).catch(() => setTopics([]));
  }, []);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    setQ('');
    setBusy(true);
    setEntries((x) => [...x, { q: text, a: null }]);
    try {
      const a = await api.post<Answer>('/guide/ask', { question: text, page });
      setEntries((x) => x.map((e, i) => (i === x.length - 1 ? { ...e, a } : e)));
    } catch (e) {
      setEntries((x) => x.map((en, i) => (i === x.length - 1 ? { ...en, error: (e as Error).message } : en)));
    } finally {
      setBusy(false);
    }
  };
  const openTopic = async (id: string, title: string) => {
    setShowTopics(false);
    try {
      const a = await api.get<Answer>(`/guide/topics/${id}`);
      setEntries((x) => [...x, { q: title, a }]);
    } catch (e) {
      setEntries((x) => [...x, { q: title, a: null, error: (e as Error).message }]);
    }
  };
  const suggestions = [...SUGGESTED.default.slice(0, 2), ...(SUGGESTED[page] ?? []), ...SUGGESTED.default.slice(2)].filter((x, i, a) => a.indexOf(x) === i).slice(0, 6);
  const usesClaude = status?.llm?.available && status?.llm?.provider !== 'none';

  return (
    <aside className="guide" role="dialog" aria-label="Guide">
      <div className="guide-head">
        <div>
          <h2 style={{ margin: 0 }}>Coach</h2>
          <div className="tiny muted">Outside the game — ask me anything about it: how to do something, why it happens, what to try next.</div>
        </div>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close coach">✕</button>
      </div>
      <div className="guide-log" ref={logRef}>
        {hasGame && (
          <details className="coach-read" open={showRead && entries.length === 0} onToggle={(e) => setShowRead((e.target as HTMLDetailsElement).open)}>
            <summary className="small strong">My read of your company</summary>
            <Coach />
          </details>
        )}
        {entries.length === 0 && (
          <div className="stack" style={{ gap: 6, marginTop: 10 }}>
            <div className="small">Ask me, for example:</div>
            {suggestions.map((s) => <button key={s} className="btn sm ghost guide-suggest" onClick={() => ask(s)}>{s}</button>)}
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className="guide-entry">
            <div className="guide-q">{e.q}</div>
            {!e.a && !e.error && <div className="small muted">Looking it up…</div>}
            {e.error && <div className="small" style={{ color: 'var(--critical-text)' }}>{e.error}</div>}
            {e.a && (
              <div className="guide-a">
                <div className="small">{e.a.answer}</div>
                {e.a.steps.length > 0 && <ol className="small">{e.a.steps.map((s, j) => <li key={j}>{s}</li>)}</ol>}
                {e.a.notes.map((n, j) => <div key={j} className="tiny sub">Note: {n}</div>)}
                {e.a.pages.length > 0 && (
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    {e.a.pages.map((p) => <button key={p.page} className="btn sm" onClick={() => { go(p.page); }}>Open {p.label}</button>)}
                  </div>
                )}
                {e.a.actions && e.a.actions.length > 0 && (
                  <details style={{ marginTop: 6 }}>
                    <summary className="tiny">Show me how (ready-made previews)</summary>
                    <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      {e.a.actions.map((x, j) => <button key={j} className="btn sm primary" onClick={() => propose(x.type, x.payload, { rationale: x.rationale })}>Preview: {x.label}</button>)}
                    </div>
                  </details>
                )}
                {e.a.related.length > 0 && (
                  <div className="tiny muted" style={{ marginTop: 6 }}>
                    Related: {e.a.related.map((r, j) => <span key={r.id}>{j > 0 && ' · '}<a href="#" onClick={(ev) => { ev.preventDefault(); openTopic(r.id, r.title); }}>{r.title}</a></span>)}
                  </div>
                )}
                <div className="tiny muted" style={{ marginTop: 4 }}>{e.a.source === 'claude' ? 'Coach (Claude), from the manual and your company’s figures' : e.a.actions ? 'Coach — from the live game' : e.a.steps.length === 0 && e.a.pages.length ? 'Coach — from your company’s figures' : 'Coach — from the game manual'}</div>
              </div>
            )}
          </div>
        ))}
      </div>
      {showTopics && (
        <div className="guide-topics">
          {topics.map((t) => <button key={t.id} className="btn sm ghost" onClick={() => openTopic(t.id, t.title)}>{t.title}</button>)}
        </div>
      )}
      <div className="guide-input">
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask(q)} placeholder="Ask anything: how do I…? why…? what should I do?" aria-label="Your question" disabled={busy} />
        <button className="btn primary" disabled={busy || !q.trim()} onClick={() => ask(q)}>Ask</button>
      </div>
      <div className="row tiny muted" style={{ padding: '0 12px 10px' }}>
        <a href="#" onClick={(e) => { e.preventDefault(); setShowTopics((x) => !x); }}>{showTopics ? 'Hide topics' : 'Browse all topics'}</a>
        <span className="spacer" />
        {entries.length > 0 && <a href="#" onClick={(e) => { e.preventDefault(); setEntries([]); }}>Clear</a>}
        <span>{usesClaude ? 'Claude' : 'Manual & live figures'}</span>
      </div>
    </aside>
  );
}
