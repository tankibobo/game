import { useEffect, useState } from 'react';
import { api, newKey } from '../api';
import { useGame } from '../ctx';
import { fmtDate } from '../format';
import { Status } from './ui';

const UNIT: Record<string, string> = { eur: '€', eur_m: '€m', pct: '%', units_per_day: '/day', months: 'months', days: 'days', bps: 'bp', years: 'years', count: '' };

export function OfferForm({ neg, conversationId, onDone }: { neg: any; conversationId?: string | null; onDone?: (r: any) => void }) {
  const { toast, refresh } = useGame();
  const start = neg.latestCounter ?? Object.fromEntries(neg.terms.map((t: any) => [t.key, t.min]));
  const [terms, setTerms] = useState<Record<string, number>>(start);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setTerms(neg.latestCounter ?? start), [neg.id, neg.roundsUsed]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = neg.status === 'open' && !neg.pendingDecision;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/negotiations/${neg.id}/offer`, { terms, message: msg, conversationId: conversationId ?? null, idempotencyKey: newKey() });
      toast(`Outcome: ${r.outcome.replace('_', ' ')}`, r.outcome === 'accepted' ? 'success' : r.outcome === 'rejected_final' ? 'error' : 'info');
      setMsg('');
      refresh();
      onDone?.(r);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <Status s={neg.status} />
        <span className="small muted">round {neg.roundsUsed}/{neg.maxRounds}{neg.deadline ? ` · deadline ${fmtDate(neg.deadline)}` : ''}</span>
      </div>
      {neg.pendingDecision && <div className="callout info small">Awaiting {neg.pendingDecision.approver} — decision by {fmtDate(neg.pendingDecision.date)}.</div>}
      {neg.latestCounterText && <div className="small"><strong>Their position:</strong> {neg.latestCounterText}</div>}
      {open && (
        <>
          {neg.terms.map((t: any) => (
            <label key={t.key} className="field" title={t.description}>
              <span>{t.label} ({UNIT[t.unit] ?? t.unit}) <span className="muted">— you prefer {t.ceoPrefers}</span></span>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="range" min={t.min} max={t.max} step={t.step} value={terms[t.key] ?? t.min} onChange={(e) => setTerms({ ...terms, [t.key]: Number(e.target.value) })} style={{ flex: 1 }} aria-label={t.label} />
                <input type="number" min={t.min} max={t.max} step={t.step} value={terms[t.key] ?? t.min} onChange={(e) => setTerms({ ...terms, [t.key]: Number(e.target.value) })} style={{ width: 86 }} />
              </div>
            </label>
          ))}
          <label className="field">
            Your argument (assessed for substance and verifiable facts; it can move them within their limits, not beyond)
            <textarea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="e.g. We can commit three years of volume; Hanseatic is qualifying an alternative pack…" />
          </label>
          <button className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Sending…' : 'Table this offer'}</button>
          <div className="tiny muted">An offer is not a contract. If they accept, you still need to sign it (with any required approvals) before it takes effect.</div>
        </>
      )}
      {neg.status === 'agreed' && <div className="callout good small">Agreed in principle. Sign the contract under Inbox → Contracts.</div>}
    </div>
  );
}

export function RoundsTable({ neg }: { neg: any }) {
  return (
    <table>
      <thead><tr><th>#</th><th>Date</th><th>By</th><th>Terms</th><th>Result</th></tr></thead>
      <tbody>
        {neg.rounds.map((r: any) => (
          <tr key={r.n}>
            <td className="num">{r.n}</td>
            <td className="small">{fmtDate(r.date)}</td>
            <td>{r.by === 'ceo' ? 'You' : 'Them'}</td>
            <td className="small">{neg.terms.map((t: any) => `${t.label}: ${r.terms[t.key]}${UNIT[t.unit] === '%' ? '%' : ''}`).join(' · ')}</td>
            <td className="small">{r.evaluation ? (r.evaluation.accepted ? 'acceptable' : 'not acceptable') : ''}{r.evaluation?.violations?.length ? ` — ${r.evaluation.violations.join(' ')}` : ''}{r.evaluation?.notes?.length ? <div className="tiny muted">{r.evaluation.notes.join(' ')}</div> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
