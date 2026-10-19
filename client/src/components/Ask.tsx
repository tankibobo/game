import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useGame, useView } from '../ctx';
import { ReportView } from './ReportView';

const GROUPS: [string, string][] = [['asterion', 'Executive team'], ['board', 'Board'], ['union', 'Union'], ['bank', 'Lenders'], ['supplier', 'Suppliers'], ['dealer', 'Dealers'], ['regulator', 'Regulators'], ['investor', 'Investors & rating'], ['customer', 'Customers'], ['competitor', 'Partners & competitors']];

/** What each executive can answer from their own department's data. */
const SPECIALITY: Record<string, string> = {
  'CHR-HOLM': 'profit & loss, margins, cash, forecast, debt',
  'CHR-GARNIER': 'sales, market share, competitors, marketing, pricing',
  'CHR-MARCHETTI': 'plants, production, quality, unit costs',
  'CHR-OKAFOR': 'workforce, morale, hiring, the union',
  'CHR-WIERZBICKI': 'projects, engineering, CO₂ and Euro 7',
  'CHR-FERRER': 'the Eon programme',
  'CHR-LINDQVIST': 'suppliers, battery supply, purchasing',
  'CHR-LAURENT': 'contracts, obligations, negotiations',
};

interface Entry {
  characterId: string;
  q: string;
  r: any | null;
  error?: string;
}

/**
 * Reports attached to a reply, reports the person asks for, and reports they
 * sent to colleagues — shown under an answer (quick question or meeting).
 */
export function ReplyExtras({ structured, documents, characterId, conversationId }: { structured: any; documents: any[]; characterId: string; conversationId?: string }) {
  const { toast, refresh } = useGame();
  const [sent, setSent] = useState<string[]>([]);
  const attached = (structured?.attachments ?? []).map((id: string) => documents.find((d) => d.id === id)).filter(Boolean);
  const send = async (req: any) => {
    try {
      await api.post('/documents/share', { reports: [{ key: req.key, param: req.param ?? null }], recipientIds: [characterId], conversationId: conversationId ?? null });
      setSent((x) => [...x, req.key]);
      toast(`Sent “${req.title}”.`, 'success');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <>
      {attached.map((doc: any) => (
        <details key={doc.id} className="attachment" open={attached.length === 1}>
          <summary>📎 {doc.title}</summary>
          {(doc.reports ?? []).map((r: any, i: number) => <ReportView key={i} report={r} compact />)}
        </details>
      ))}
      {(structured?.reportRequests ?? []).map((req: any) => (
        <div key={req.key} className="callout small" style={{ marginTop: 6 }}>
          <strong>Asks for: {req.title}.</strong> {req.reason}{' '}
          {req.needsParam && !req.param ? <span className="muted">(send it from Company → Share a document)</span> : sent.includes(req.key) ? <span className="muted">Sent.</span> : <button className="btn sm" onClick={() => send(req)}>Send it</button>}
        </div>
      ))}
      {(structured?.sharedDocs ?? []).map((s: any) => (
        <div key={s.docId} className="tiny muted" style={{ marginTop: 4 }}>✉ Sent “{s.title}” to {s.recipients.join(', ')}.</div>
      ))}
    </>
  );
}

/** Ask anyone a quick question without arranging a meeting. */
export function AskPanel({ onClose, initial }: { onClose: () => void; initial?: { characterId?: string; question?: string } }) {
  const { go, status } = useGame();
  const { data: company } = useView<any>('/company');
  const people = useMemo(() => (company?.characters ?? []).filter((c: any) => c.active), [company]);
  const [who, setWho] = useState(initial?.characterId ?? 'CHR-HOLM');
  const [q, setQ] = useState(initial?.question ?? '');
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [entries]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const person = people.find((c: any) => c.id === who);
  const ask = async () => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setQ('');
    setEntries((x) => [...x, { characterId: who, q: text, r: null }]);
    try {
      const r = await api.post('/ask', { characterId: who, question: text });
      setEntries((x) => x.map((e, i) => (i === x.length - 1 ? { ...e, r } : e)));
    } catch (e) {
      setEntries((x) => x.map((en, i) => (i === x.length - 1 ? { ...en, error: (e as Error).message } : en)));
    } finally {
      setBusy(false);
    }
  };
  const nameOf = (id: string) => people.find((c: any) => c.id === id)?.name ?? id;
  return (
    <aside className="guide ask" role="dialog" aria-label="Ask someone">
      <div className="guide-head">
        <div>
          <h2 style={{ margin: 0 }}>Ask someone</h2>
          <div className="tiny muted">A quick question, no meeting needed. Executives answer from their department’s figures and attach the report.</div>
        </div>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="guide-log" ref={logRef}>
        {entries.length === 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="small">Who knows what:</div>
            {Object.entries(SPECIALITY).map(([id, what]) => (
              <button key={id} className="btn sm ghost guide-suggest" onClick={() => setWho(id)}>
                <strong>{nameOf(id)}</strong>&nbsp;— {what}
              </button>
            ))}
          </div>
        )}
        {entries.map((e, i) => (
          <div key={i} className="guide-entry">
            <div className="guide-q">You → {nameOf(e.characterId)}: {e.q}</div>
            {!e.r && !e.error && <div className="small muted">{nameOf(e.characterId)} is thinking…</div>}
            {e.error && <div className="small" style={{ color: 'var(--critical-text)' }}>{e.error}</div>}
            {e.r && (
              <div className="guide-a">
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{e.r.reply.content}</div>
                <ReplyExtras structured={e.r.reply.structured} documents={e.r.documents ?? []} characterId={e.characterId} conversationId={e.r.conversationId} />
                {e.r.actions?.some((a: any) => a.status === 'pending_confirmation') && <div className="tiny" style={{ marginTop: 4 }}>{nameOf(e.characterId)} drafted a decision — see Decisions → Your drafts.</div>}
                <div className="row tiny muted" style={{ marginTop: 6, gap: 8 }}>
                  <span>{e.r.mode === 'llm' ? `Voiced by ${status?.llm?.provider === 'claude-code' ? 'Claude' : 'the LLM'}` : 'Deterministic responder'}</span>
                  <a href="#" onClick={(ev) => { ev.preventDefault(); onClose(); go('meeting', e.r.conversationId); }}>Continue as a meeting →</a>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="ask-input">
        <label className="field">To
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who to ask">
            {GROUPS.map(([org, label]) => {
              const xs = people.filter((c: any) => c.org === org);
              return xs.length ? <optgroup key={org} label={label}>{xs.map((c: any) => <option key={c.id} value={c.id}>{c.name} — {c.title}</option>)}</optgroup> : null;
            })}
          </select>
        </label>
        {person && SPECIALITY[person.id] && <div className="tiny muted">Knows best: {SPECIALITY[person.id]}.</div>}
        <div className="row" style={{ gap: 8 }}>
          <textarea rows={2} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} placeholder="e.g. Why are we losing money on the Vela?" aria-label="Your question" disabled={busy} style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || !q.trim()} onClick={ask}>Ask</button>
        </div>
      </div>
    </aside>
  );
}
