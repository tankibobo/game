import { useMemo, useState } from 'react';
import { api } from '../api';
import { useGame, useView } from '../ctx';
import { fmtDate } from '../format';
import { Empty } from './ui';

const GROUPS: [string, string][] = [['asterion', 'Executive team'], ['board', 'Board'], ['union', 'Union'], ['bank', 'Lenders'], ['supplier', 'Suppliers'], ['dealer', 'Dealers'], ['regulator', 'Regulators'], ['investor', 'Investors & rating']];

/**
 * Share a report or send a memo. With `fixedRecipient` (in a meeting) the
 * document goes to that person and is noted in the conversation.
 */
export function ShareForm({ fixedRecipient, conversationId, onShared }: { fixedRecipient?: string; conversationId?: string; onShared?: () => void }) {
  const { data } = useView<any>('/documents');
  const { data: company } = useView<any>('/company');
  const { toast, refresh } = useGame();
  const [key, setKey] = useState('forecast');
  const [param, setParam] = useState('');
  const [note, setNote] = useState('');
  const [to, setTo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const type = data?.types.find((t: any) => t.key === key);
  const options: any[] = type?.param ? data.options[type.param] ?? [] : [];
  const people = useMemo(() => (company?.characters ?? []).filter((c: any) => c.active), [company]);
  if (!data || !company) return <Empty>Loading…</Empty>;
  const recipients = fixedRecipient ? [fixedRecipient] : to;
  const ready = recipients.length > 0 && (!type?.param || param) && (key !== 'memo' || note.trim().length >= 5);
  const send = async () => {
    setBusy(true);
    try {
      const doc = await api.post('/documents/share', { docKey: key, param: type?.param ? param : null, recipientIds: recipients, note, conversationId: conversationId ?? null });
      toast(`Sent “${doc.title}”.`, 'success');
      setNote('');
      if (!fixedRecipient) setTo([]);
      refresh();
      onShared?.();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <label className="field">What to send
        <select value={key} onChange={(e) => { setKey(e.target.value); setParam(''); }}>
          {data.types.map((t: any) => <option key={t.key} value={t.key}>{t.title}</option>)}
        </select>
      </label>
      {type && <div className="tiny muted">{type.description}</div>}
      {type?.param && (
        <label className="field">About
          <select value={param} onChange={(e) => setParam(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o: any) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
      )}
      {!fixedRecipient && (
        <div>
          <div className="small strong" style={{ marginBottom: 4 }}>To</div>
          <div className="share-recipients">
            {GROUPS.map(([org, label]) => {
              const xs = people.filter((c: any) => c.org === org);
              if (!xs.length) return null;
              return (
                <div key={org}>
                  <div className="tiny muted">{label}</div>
                  {xs.map((c: any) => (
                    <label key={c.id} className="row small" style={{ gap: 6 }}>
                      <input type="checkbox" checked={to.includes(c.id)} onChange={() => setTo((x) => (x.includes(c.id) ? x.filter((y) => y !== c.id) : [...x, c.id]))} />
                      {c.name}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <label className="field">{key === 'memo' ? 'Your memo' : 'Covering note (optional)'}
        <textarea rows={key === 'memo' ? 4 : 2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={key === 'memo' ? 'What you want them to know…' : 'e.g. Please challenge the Eon assumptions before Thursday.'} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={!ready || busy} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
        <span className="tiny muted">Recipients remember it in later meetings. It does not change the company.</span>
      </div>
      {!fixedRecipient && data.recent.length > 0 && (
        <details>
          <summary className="small">Sent recently ({data.recent.length})</summary>
          <div className="list">
            {data.recent.slice(0, 12).map((doc: any) => (
              <div key={doc.id} className="list-item" style={{ display: 'block' }}>
                <div className="small strong">{doc.title}</div>
                <div className="tiny muted">{fmtDate(doc.date)} · to {doc.recipients.map((r: string) => people.find((c: any) => c.id === r)?.name ?? r).join(', ')}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
