import { useState } from 'react';
import { Card, Empty, EntityLink, Loading, Sev, Status, Tabs } from '../components/ui';
import { useGame, useView } from '../ctx';
import { fmtDate, fmtEur, titleCase } from '../format';

const CATS = ['finance', 'operations', 'product', 'people', 'market', 'regulatory', 'board', 'project', 'negotiation', 'supply', 'system'];

export function History() {
  const { reviewAction, nav } = useGame();
  const [tab, setTab] = useState<'events' | 'decisions'>('events');
  const [q, setQ] = useState('');
  const [f, setF] = useState({ category: '', severity: '', type: '', entity: nav.param ?? '', from: '', to: '' });
  const [applied, setApplied] = useState({ q: '', ...f });
  const params = new URLSearchParams(Object.entries(applied).filter(([, v]) => v) as [string, string][]).toString();
  const { data: d, error } = useView<any>(`/history?${params}`);
  const [open, setOpen] = useState<string | null>(null);
  const apply = () => setApplied({ q, ...f });
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>History</h1>
          <p>The append-only event ledger and the decision log. Every consequential event records its cause, preconditions, affected entities and computed consequences.</p>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[['events', 'Event ledger'], ['decisions', 'Decision log']]} />
      {tab === 'events' && (
        <>
          <Card>
            <div className="form-grid">
              <label className="field">Search<input type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} placeholder="e.g. Voltaris, strike, covenant" /></label>
              <label className="field">Category<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option>{CATS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}</select></label>
              <label className="field">Severity<select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option value="">All</option>{['critical', 'warning', 'notice', 'info'].map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}</select></label>
              <label className="field">Event type<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">All</option>{(d?.types ?? []).map((t: string) => <option key={t} value={t}>{t}</option>)}</select></label>
              <label className="field">Entity id<input type="text" value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })} placeholder="e.g. PRJ-EON" /></label>
              <label className="field">From<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
              <label className="field">To<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
              <div className="row"><button className="btn primary" onClick={apply}>Apply</button><button className="btn" onClick={() => { setQ(''); const z = { category: '', severity: '', type: '', entity: '', from: '', to: '' }; setF(z); setApplied({ q: '', ...z }); }}>Reset</button></div>
            </div>
          </Card>
          <div style={{ height: 14 }} />
          {!d ? <Loading error={error} /> : (
            <Card title={`${d.events.length} events`} flush>
              {d.events.length === 0 ? <Empty>No events match.</Empty> : (
                <div className="list">
                  {d.events.map((e: any) => (
                    <div key={e.id} className="list-item clickable" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <Sev s={e.severity} />
                      <div style={{ flex: 1 }}>
                        <div className="row">
                          <span className="small strong">{e.title}</span>
                          <span className="spacer" />
                          <span className="tiny muted">{fmtDate(e.date)} · {e.category} · {e.causeKind.replace('_', ' ')}</span>
                        </div>
                        <div className="small sub">{e.description}</div>
                        {open === e.id && (
                          <div className="small" style={{ marginTop: 6 }}>
                            {e.cause?.text && <div><strong>Cause:</strong> {e.cause.text}</div>}
                            {e.consequences?.length > 0 && <div><strong>Consequences:</strong> {e.consequences.map((c: any) => `${c.text}${c.amountCents ? ` (${fmtEur(c.amountCents)})` : ''}`).join('; ')}</div>}
                            {e.followUps?.length > 0 && <div><strong>Follow-ups:</strong> {e.followUps.join('; ')}</div>}
                            {e.entities?.length > 0 && <div className="row"><strong>Entities:</strong> {e.entities.map((x: any) => <EntityLink key={`${x.type}:${x.id}`} type={x.type} id={x.id} />)}</div>}
                            <div className="tiny muted">{e.id} · type {e.type} · source {e.source}{e.actionId ? ` · action ${e.actionId}` : ''}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </>
      )}
      {tab === 'decisions' && (
        !d ? <Loading error={error} /> : (
          <Card title="Decision log" flush sub="Every proposal, including invalid and rejected ones, is recorded.">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Action</th><th>Proposed by</th><th>Status</th><th>Notes</th></tr></thead>
                <tbody>
                  {d.actions.map((a: any) => (
                    <tr key={a.id} className="clickable" onClick={() => reviewAction(a.id)}>
                      <td className="small">{fmtDate(a.simDate)}</td>
                      <td className="small strong">{a.summary}<div className="tiny muted">{a.type} · {a.id}</div></td>
                      <td className="small">{a.actorId === 'ceo' ? 'You' : a.actorId}{a.source === 'llm_proposal' ? ' (meeting)' : ''}</td>
                      <td><Status s={a.status} /></td>
                      <td className="small">{a.errors?.length ? a.errors[0] : a.result?.summary ?? a.result?.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      )}
    </div>
  );
}
