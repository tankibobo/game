import { useMemo, useState } from 'react';
import { api } from '../api';
import { useGame, useView } from '../ctx';
import { fmtDate } from '../format';
import { Empty, Modal } from './ui';
import { LiveReport } from '../pages/Finance';
import { DocumentView } from './ReportView';

const GROUPS: [string, string][] = [['asterion', 'Executive team'], ['board', 'Board'], ['union', 'Union'], ['bank', 'Lenders'], ['supplier', 'Suppliers'], ['dealer', 'Dealers'], ['regulator', 'Regulators'], ['investor', 'Investors & rating'], ['customer', 'Customers'], ['competitor', 'Partners & competitors']];
const AREAS: [string, string][] = [['finance', 'Finance'], ['sales', 'Sales & marketing'], ['operations', 'Operations'], ['people', 'People'], ['projects', 'Projects'], ['legal', 'Legal'], ['deals', 'Deals'], ['board', 'Board']];

/**
 * Send reports and/or a memo. Every report is described; tick the ones to
 * include (they are built from today's figures when sent), preview any of
 * them, add a memo. With `fixedRecipient` (in a meeting) it goes to that person.
 */
export function ShareForm({ fixedRecipient, conversationId, onShared }: { fixedRecipient?: string; conversationId?: string; onShared?: () => void }) {
  const { data } = useView<any>('/documents');
  const { data: company } = useView<any>('/company');
  const { toast, refresh } = useGame();
  const [picked, setPicked] = useState<Record<string, string>>({}); // key -> param ('' when none)
  const [memo, setMemo] = useState('');
  const [to, setTo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ key: string; param?: string } | null>(null);
  const [open, setOpen] = useState<any>(null);
  const people = useMemo(() => (company?.characters ?? []).filter((c: any) => c.active), [company]);
  if (!data || !company) return <Empty>Loading…</Empty>;
  const types = data.types.filter((t: any) => t.key !== 'memo');
  const recipients = fixedRecipient ? [fixedRecipient] : to;
  const keys = Object.keys(picked);
  const missingParam = keys.some((k) => types.find((t: any) => t.key === k)?.param && !picked[k]);
  const ready = recipients.length > 0 && !missingParam && (keys.length > 0 || memo.trim().length >= 5) && keys.length <= 6;
  const toggle = (k: string) => setPicked((p) => { const n = { ...p }; if (k in n) delete n[k]; else n[k] = ''; return n; });
  const send = async () => {
    setBusy(true);
    try {
      const doc = await api.post('/documents/share', { reports: keys.map((k) => ({ key: k, param: picked[k] || null })), memo, recipientIds: recipients, conversationId: conversationId ?? null });
      toast(`Sent “${doc.title}”.`, 'success');
      setMemo('');
      setPicked({});
      if (!fixedRecipient) setTo([]);
      refresh();
      onShared?.();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const nameOf = (id: string) => (id === 'ceo' ? 'you' : people.find((c: any) => c.id === id)?.name ?? id);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div>
        <div className="small strong" style={{ marginBottom: 4 }}>1. What to send <span className="tiny muted">(tick one or more — built from today’s figures)</span></div>
        <div className="share-reports">
          {AREAS.map(([area, label]) => {
            const xs = types.filter((t: any) => t.area === area);
            if (!xs.length) return null;
            return (
              <div key={area}>
                <div className="tiny muted" style={{ marginTop: 4 }}>{label}</div>
                {xs.map((t: any) => (
                  <div key={t.key} className="share-report">
                    <label className="row small" style={{ gap: 6, alignItems: 'flex-start' }}>
                      <input type="checkbox" checked={t.key in picked} onChange={() => toggle(t.key)} />
                      <span><strong>{t.title}</strong><span className="tiny muted"> — {t.description}</span></span>
                    </label>
                    <div className="row" style={{ gap: 6, marginLeft: 22 }}>
                      {t.param && t.key in picked && (
                        <select value={picked[t.key]} onChange={(e) => setPicked((p) => ({ ...p, [t.key]: e.target.value }))} aria-label={`${t.title}: which one`}>
                          <option value="">Choose…</option>
                          {(data.options[t.param] ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.label}</option>)}
                        </select>
                      )}
                      {(!t.param || picked[t.key]) && <a href="#" className="tiny" onClick={(e) => { e.preventDefault(); setPreview({ key: t.key, param: picked[t.key] || undefined }); }}>Preview</a>}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {!fixedRecipient && (
        <div>
          <div className="small strong" style={{ marginBottom: 4 }}>2. To</div>
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
      <label className="field">{fixedRecipient ? '2.' : '3.'} Memo {keys.length ? '(optional)' : ''}
        <textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={keys.length ? 'e.g. Please challenge the Eon assumptions before Thursday.' : 'What you want them to know…'} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={!ready || busy} onClick={send}>{busy ? 'Sending…' : `Send${keys.length > 1 ? ` ${keys.length} reports` : ''}`}</button>
        <span className="tiny muted">Recipients use it in later meetings; colleagues learn it was circulated. It does not change the company.</span>
      </div>
      {!fixedRecipient && data.recent.length > 0 && (
        <details>
          <summary className="small">Documents circulated recently ({data.recent.length}) — including those your team sent each other</summary>
          <div className="list">
            {data.recent.slice(0, 20).map((doc: any) => (
              <div key={doc.id} className="list-item clickable" onClick={() => api.get(`/documents/${doc.id}`).then(setOpen)}>
                <div style={{ flex: 1 }}>
                  <div className="small strong">{doc.title}</div>
                  <div className="tiny muted">{fmtDate(doc.date)} · {nameOf(doc.senderId)} → {doc.recipients.map(nameOf).join(', ')}</div>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      {preview && (
        <Modal title="Preview" wide onClose={() => setPreview(null)}>
          <LiveReport reportKey={preview.key} param={preview.param} />
        </Modal>
      )}
      {open && (
        <Modal title={open.title} wide onClose={() => setOpen(null)}>
          <DocumentView doc={open} people={people} />
        </Modal>
      )}
    </div>
  );
}
