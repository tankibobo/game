import { useEffect, useState } from 'react';
import { api } from '../api';
import { OfferForm, RoundsTable } from '../components/Negotiation';
import { Card, D, Empty, EntityLink, Loading, Sev, Status, Tabs } from '../components/ui';
import { useGame, useView } from '../ctx';
import { addDays, diffDays, fmtDate, fmtEur, titleCase } from '../format';
import { startMeeting } from './Company';
import { BoardOutlook } from '../components/ActionReview';

type Tab = 'messages' | 'meetings' | 'negotiations' | 'commitments' | 'contracts' | 'board' | 'decisions';

export function Inbox() {
  const { data: d, error, reload } = useView<any>('/inbox');
  const { nav, go, toast, propose, reviewAction, refresh } = useGame();
  const [tab, setTab] = useState<Tab>('messages');
  const [sel, setSel] = useState<string | null>(null);
  const [negSel, setNegSel] = useState<string | null>(null);
  const [promise, setPromise] = useState({ to: 'CHR-DUBREUIL', text: '', due: '' });
  useEffect(() => {
    if (!nav.param) return;
    if (nav.param === 'decisions') go('decisions', 'drafts');
    else if (['messages', 'meetings', 'negotiations', 'commitments', 'contracts', 'board'].includes(nav.param)) setTab(nav.param as Tab);
    else if (nav.param.startsWith('NEG')) {
      setTab('negotiations');
      setNegSel(nav.param);
    } else if (nav.param.startsWith('CON')) setTab('contracts');
    else if (nav.param.startsWith('COM')) setTab('commitments');
    else if (nav.param.startsWith('BP')) setTab('board');
  }, [nav.param]);
  if (!d) return <Loading error={error} />;
  const chars: any[] = d.characters;
  const name = (id: string | null) => (!id ? 'System' : chars.find((c) => c.id === id)?.name ?? id);
  const item = d.items.find((x: any) => x.id === sel) ?? d.items[0];
  const openItem = async (x: any) => {
    setSel(x.id);
    if (!x.read) {
      await api.post(`/inbox/${x.id}/read`);
      reload();
      refresh();
    }
  };
  const neg = d.negotiations.find((n: any) => n.id === negSel) ?? d.negotiations.find((n: any) => n.status === 'open') ?? d.negotiations[0];
  const agreed = d.contracts.filter((c: any) => c.status === 'agreed');
  const pendingConfirm = d.pendingActions.filter((a: any) => a.status === 'pending_confirmation');
  const today = d.today;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Inbox & meetings</h1>
          <p>Reports, requests and warnings; conversations; negotiations; commitments; contracts awaiting signature; the board agenda.</p>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => api.post('/inbox/read-all').then(() => { reload(); refresh(); })}>Mark all read</button>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['messages', `Messages (${d.items.filter((x: any) => !x.read).length} unread)`],
          ['meetings', 'Meetings'],
          ['negotiations', `Negotiations (${d.negotiations.filter((n: any) => n.status === 'open').length})`],
          ['commitments', `Commitments (${d.commitments.filter((c: any) => ['open', 'due'].includes(c.status)).length})`],
          ['contracts', `Contracts${agreed.length ? ` (${agreed.length} to sign)` : ''}`],
          ['board', 'Board'],
        ]}
      />
      {tab === 'messages' && (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 380px) minmax(0, 1fr)' }}>
          <Card title="Inbox" flush>
            <div className="list" style={{ maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' }}>
              {d.items.length === 0 && <Empty>No messages.</Empty>}
              {d.items.map((x: any) => (
                <div key={x.id} className="list-item clickable" style={x.id === item?.id ? { background: 'var(--surface-2)' } : undefined} onClick={() => openItem(x)}>
                  <Sev s={x.priority === 'urgent' ? 'critical' : x.priority === 'high' ? 'warning' : 'info'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className={`small ${x.read ? '' : 'strong'}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.subject}</div>
                    <div className="tiny muted">{name(x.fromId)} · {fmtDate(x.date)} · {x.kind}</div>
                  </div>
                  {!x.read && <span className="nav-badge" style={{ background: 'var(--accent)' }}>new</span>}
                </div>
              ))}
            </div>
          </Card>
          {item ? (
            <Card title={item.subject} sub={`${name(item.fromId)} · ${fmtDate(item.date, 'long')} · ${item.kind}`} actions={item.fromId && chars.some((c) => c.id === item.fromId) ? <button className="btn sm primary" onClick={() => startMeeting(item.fromId, go, toast)}>Meet {name(item.fromId).split(' ')[0]}</button> : null}>
              <div className="pre">{item.body}</div>
              {item.linked.length > 0 && <div className="row small" style={{ marginTop: 10 }}>Related: {item.linked.map((l: any) => <EntityLink key={l.id} type={l.type} id={l.id} />)}</div>}
            </Card>
          ) : (
            <Card title="—"><Empty>Select a message.</Empty></Card>
          )}
        </div>
      )}
      {tab === 'meetings' && (
        <div className="grid g2">
          <Card title="Conversations" flush>
            {d.conversations.length === 0 ? <Empty>No meetings yet. Start one on the right or from the Company page.</Empty> : (
              <div className="list">
                {d.conversations.map((c: any) => (
                  <div key={c.id} className="list-item clickable" onClick={() => go('meeting', c.id)}>
                    <div style={{ flex: 1 }}>
                      <div className="t small">{c.title}</div>
                      <div className="tiny muted">{name(c.characterId)} · last {fmtDate(c.lastDate)}</div>
                      {c.summary && <div className="tiny sub" style={{ marginTop: 2 }}>{c.summary.slice(0, 180)}{c.summary.length > 180 ? '…' : ''}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Start a meeting" flush>
            <div className="list">
              {chars.map((c) => (
                <div key={c.id} className="list-item">
                  <div style={{ flex: 1 }}>
                    <div className="small strong">{c.name}</div>
                    <div className="tiny muted">{c.title}</div>
                  </div>
                  <span className="small muted num">trust {Math.round(c.trustInCeo)}</span>
                  <button className="btn sm" onClick={() => startMeeting(c.id, go, toast)}>Meet</button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
      {tab === 'negotiations' && (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(240px, 320px) minmax(0, 1fr)' }}>
          <div className="stack">
            <Card title="Negotiations" flush>
              <div className="list">
                {d.negotiations.map((n: any) => (
                  <div key={n.id} className="list-item clickable" style={n.id === neg?.id ? { background: 'var(--surface-2)' } : undefined} onClick={() => setNegSel(n.id)}>
                    <div style={{ flex: 1 }}>
                      <div className="small strong">{n.title}</div>
                      <div className="tiny muted">{name(n.counterpartyId)}{n.deadline ? ` · deadline ${fmtDate(n.deadline)}` : ''}</div>
                    </div>
                    <Status s={n.status} />
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Open a new negotiation" flush>
              <div className="list">
                {d.negotiationTemplates.map((t: any) => (
                  <div key={t.key} className="list-item">
                    <div style={{ flex: 1 }}>
                      <div className="small">{t.title}</div>
                      <div className="tiny muted">{t.counterpartyName}{t.unavailable ? ` — ${t.unavailable}` : ''}</div>
                    </div>
                    <button className="btn sm" disabled={t.open || !!t.unavailable} onClick={() => propose('open_negotiation', { templateKey: t.key })}>{t.open ? 'Open' : 'Start…'}</button>
                  </div>
                ))}
              </div>
            </Card>
          </div>
          {neg ? (
            <div className="stack">
              <Card title={neg.title} sub={`with ${name(neg.counterpartyId)}`} actions={<button className="btn sm" onClick={() => startMeeting(neg.counterpartyId, go, toast)}>Talk to {name(neg.counterpartyId).split(' ')[0]}</button>}>
                <div className="small sub" style={{ marginBottom: 8 }}>{neg.context}</div>
                <OfferForm neg={neg} />
              </Card>
              <Card title="Rounds" flush><RoundsTable neg={neg} /></Card>
            </div>
          ) : (
            <Card title="—"><Empty>No negotiations.</Empty></Card>
          )}
        </div>
      )}
      {tab === 'commitments' && (
        <div className="stack">
          <Card title="Commitments & promises" flush sub="Verifiable commitments are checked by the simulation; free-form ones you report yourself. Ignored promises count as broken 14 days after their due date.">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Commitment</th><th>From → to</th><th className="num">Due</th><th>Verification</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {[...d.commitments].sort((a: any, b: any) => Number(!['open', 'due'].includes(a.status)) - Number(!['open', 'due'].includes(b.status)) || ((a.dueDate ?? '9') < (b.dueDate ?? '9') ? -1 : 1)).map((c: any) => (
                    <tr key={c.id}>
                      <td className="small">{c.description}<div className="tiny muted">{c.id} · {c.source} · {c.conditions}</div></td>
                      <td className="small">{c.promisorId === 'ceo' ? 'You' : name(c.promisorId)} → {name(c.promiseeId)}</td>
                      <td className="num" style={{ color: c.dueDate && c.dueDate < today && ['open', 'due'].includes(c.status) ? 'var(--critical-text)' : undefined }}><D d={c.dueDate} />{c.dueDate && ['open', 'due'].includes(c.status) && <div className="tiny muted">{diffDays(c.dueDate, today) >= 0 ? `in ${diffDays(c.dueDate, today)} d` : `${-diffDays(c.dueDate, today)} d overdue`}</div>}</td>
                      <td className="small">{c.check.type === 'freeform' ? 'self-reported' : titleCase(c.check.type)}</td>
                      <td><Status s={c.status} /></td>
                      <td>{c.check.type === 'freeform' && c.promisorId === 'ceo' && ['open', 'due'].includes(c.status) && (
                        <div className="row">
                          <button className="btn sm" onClick={() => propose('resolve_commitment', { commitmentId: c.id, outcome: 'fulfilled', note: 'Delivered.' })}>Fulfilled</button>
                          <button className="btn sm danger" onClick={() => propose('resolve_commitment', { commitmentId: c.id, outcome: 'broken', note: 'Could not deliver.' })}>Broken</button>
                        </div>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Record a promise you made">
            <div className="form-grid">
              <label className="field">To<select value={promise.to} onChange={(e) => setPromise({ ...promise, to: e.target.value })}>{chars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label className="field">Due date<input type="date" value={promise.due} min={today} onChange={(e) => setPromise({ ...promise, due: e.target.value })} /></label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>What you promised<input type="text" value={promise.text} onChange={(e) => setPromise({ ...promise, text: e.target.value })} /></label>
              <div><button className="btn" disabled={promise.text.length < 5} onClick={() => propose('make_promise', { promiseeId: promise.to, description: promise.text, dueDate: promise.due || null })}>Preview</button></div>
            </div>
          </Card>
        </div>
      )}
      {tab === 'contracts' && (
        <Card title="Contracts" flush>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Contract</th><th>Counterparty</th><th>Status</th><th className="num">Value</th><th className="num">Signed</th><th className="num">Ends</th><th>Summary</th><th></th></tr></thead>
              <tbody>
                {[...d.contracts].sort((a: any, b: any) => Number(b.status === 'agreed') - Number(a.status === 'agreed')).map((c: any) => (
                  <tr key={c.id}>
                    <td className="strong">{c.title}<div className="tiny muted">{c.id}{c.amendmentOf ? ` · amends ${c.amendmentOf}` : ''}</div></td>
                    <td className="small">{c.counterpartyName}</td>
                    <td><Status s={c.status} label={c.status === 'agreed' ? 'agreed — not signed' : undefined} /></td>
                    <td className="num">{c.valueCents ? fmtEur(c.valueCents) : '—'}</td>
                    <td className="num"><D d={c.signedDate} /></td>
                    <td className="num"><D d={c.endDate} /></td>
                    <td className="small">{c.summary}{c.obligations.length > 0 && <div className="tiny muted">{c.obligations.map((o: any) => o.text).join(' · ')}</div>}</td>
                    <td>{c.status === 'agreed' && <button className="btn sm primary" onClick={() => propose('sign_contract', { contractId: c.id })}>Sign…</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {tab === 'board' && (
        <div className="stack">
          <div className="callout info small">
            Decisions above your authority reach the board automatically when you confirm them. To have several decisions voted together, or to ask for endorsement of a strategy, use <a href="#" onClick={(e) => { e.preventDefault(); go('decisions', 'board'); }}>Decisions → Board</a>. Next meeting: <strong>{fmtDate(d.nextBoardMeeting, 'long')}</strong>.
          </div>
          <Card title="Board agenda & votes" flush>
            {d.boardProposals.length === 0 ? <Empty>Nothing has been put to the board yet.</Empty> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Proposal</th><th className="num">Meeting</th><th>Status</th><th>What it does</th><th>Votes</th></tr></thead>
                  <tbody>
                    {[...d.boardProposals].reverse().map((p: any) => (
                      <tr key={p.id}>
                        <td className="strong">{p.title}<div className="tiny muted">{p.id} · submitted {fmtDate(p.submittedDate)}{p.rationale ? ` · “${p.rationale.slice(0, 120)}${p.rationale.length > 120 ? '…' : ''}”` : ''}</div></td>
                        <td className="num"><D d={p.meetingDate} /></td>
                        <td><Status s={p.status} /></td>
                        <td className="small" style={{ minWidth: 200 }}>
                          {p.decisions.length === 0 ? <span className="muted">Endorsement only — changes nothing by itself.</span> : p.decisions.map((a: any) => (
                            <div key={a.id} className="row" style={{ gap: 6 }}>
                              <a href="#" onClick={(e) => { e.preventDefault(); reviewAction(a.id); }}>{a.summary}</a>
                              <Status s={a.status} label={a.status === 'approved' ? 'approved — waiting' : a.status === 'committed' ? 'carried out' : undefined} />
                            </div>
                          ))}
                        </td>
                        <td className="small" style={{ minWidth: 260 }}>
                          {p.outlook && <BoardOutlook o={p.outlook} compact />}
                          {p.votes.map((v: any) => <div key={v.memberId}><span style={{ color: v.vote === 'for' ? 'var(--good-text)' : v.vote === 'against' ? 'var(--critical-text)' : undefined }}>{v.vote}</span> — {name(v.memberId)}: <span className="muted">{v.reason}</span></div>)}
                          {p.outcomeNote && <div className="strong">{p.outcomeNote}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
      {tab === 'decisions' && (
        <Card title="Decisions">
          <div className="small">Drafts, decisions in progress and recent decisions now live on their own page.</div>
          <div style={{ marginTop: 8 }}><button className="btn primary" onClick={() => go('decisions', 'drafts')}>Open Decisions</button></div>
        </Card>
      )}
    </div>
  );
}
