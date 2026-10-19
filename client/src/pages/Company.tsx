import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Empty, Loading, Progress, Status, Tabs } from '../components/ui';
import { ShareForm } from '../components/ShareForm';
import { useGame, useView } from '../ctx';
import { fmtDate, fmtEur, fmtInt, titleCase } from '../format';

export async function startMeeting(characterId: string, go: (p: any, x?: string) => void, toast: (t: string, k?: any) => void) {
  try {
    const c = await api.post('/conversations', { characterId });
    go('meeting', c.id);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function trustTone(t: number) {
  return t < 30 ? 'var(--critical)' : t < 45 ? 'var(--serious)' : undefined;
}

export function Company() {
  const { data: d, error } = useView<any>('/company');
  const { go, toast, nav } = useGame();
  const [tab, setTab] = useState<'people' | 'org' | 'board' | 'rules' | 'share'>('people');
  const [sel, setSel] = useState<string | null>(nav.param ?? null);
  useEffect(() => {
    if (nav.param) setSel(nav.param);
  }, [nav.param]);
  if (!d) return <Loading error={error} />;
  const chars = d.characters as any[];
  const groups: [string, string][] = [['asterion', 'Executive team'], ['board', 'Board of directors'], ['union', 'Unions'], ['bank', 'Lenders'], ['supplier', 'Suppliers'], ['dealer', 'Dealers'], ['regulator', 'Regulators'], ['investor', 'Rating agencies & investors'], ['customer', 'Customers'], ['competitor', 'Partners & competitors']];
  const c = chars.find((x) => x.id === sel);
  const name = (id: string) => (id === 'ceo' ? 'CEO (you)' : chars.find((x) => x.id === id)?.name ?? id);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Company</h1>
          <p>People, organisation, board and approval rights. Trust is shaped by what you do — kept and broken promises, decisions and how you treat people.</p>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[['people', 'People'], ['org', 'Departments'], ['board', 'Board'], ['rules', 'Approval rights'], ['share', 'Share a document']]} />
      {tab === 'people' && (
        <div className="grid g-main">
          <div className="stack">
            {groups.map(([org, label]) => {
              const xs = chars.filter((x) => x.org === org);
              if (!xs.length) return null;
              return (
                <Card key={org} title={label} flush>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Name</th><th>Role</th><th>Trust in you</th><th>Stance drivers</th><th></th></tr>
                      </thead>
                      <tbody>
                        {xs.map((x) => (
                          <tr key={x.id} className="clickable" onClick={() => setSel(x.id)} style={sel === x.id ? { background: 'var(--surface-2)' } : undefined}>
                            <td className="strong">{x.name}{!x.active && <span className="pill critical" style={{ marginLeft: 6 }}>left</span>}</td>
                            <td className="small">{x.title}</td>
                            <td style={{ minWidth: 110 }}>
                              <div className="row" style={{ gap: 6 }}>
                                <Progress value={x.trustInCeo / 100} tone={trustTone(x.trustInCeo)} />
                                <span className="num small">{Math.round(x.trustInCeo)}</span>
                              </div>
                            </td>
                            <td className="small sub">{x.objectives[0]}</td>
                            <td>
                              <button className="btn sm" disabled={!x.active} onClick={(e) => { e.stopPropagation(); startMeeting(x.id, go, toast); }}>Meet</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              );
            })}
          </div>
          <div className="stack">
            {c ? (
              <Card title={c.name} sub={`${c.title} · ${c.orgName}`} actions={<button className="btn primary sm" disabled={!c.active} onClick={() => startMeeting(c.id, go, toast)}>Start meeting</button>}>
                <div className="small stack" style={{ gap: 8 }}>
                  <div>{c.bio}</div>
                  <div><strong>Personality:</strong> {c.personality}</div>
                  <div><strong>Style:</strong> {c.communicationStyle}</div>
                  <div><strong>Objectives:</strong><ul style={{ margin: '2px 0 0 16px', padding: 0 }}>{c.objectives.map((o: string) => <li key={o}>{o}</li>)}</ul></div>
                  <div><strong>Incentives:</strong> {c.incentives}</div>
                  <div><strong>Expertise:</strong> {c.expertise.join(', ')}</div>
                  <div className="row"><strong>Risk tolerance</strong><Progress value={c.riskTolerance / 100} /><span className="num">{c.riskTolerance}</span></div>
                  <div className="row"><strong>Trust in you</strong><Progress value={c.trustInCeo / 100} tone={trustTone(c.trustInCeo)} /><span className="num">{Math.round(c.trustInCeo)}</span></div>
                  <div><strong>Authority:</strong> {c.authority.notes}</div>
                  {c.privateInfoCount > 0 && <div className="muted">Holds {c.privateInfoCount} private view{c.privateInfoCount > 1 ? 's' : ''} not yet shared with you — candour grows with trust.</div>}
                  <div>
                    <strong>Relationships</strong>
                    {d.relationships.filter((r: any) => r.fromId === c.id || r.toId === c.id).map((r: any) => (
                      <div key={r.id} className="row" style={{ gap: 6 }}>
                        <Status s={r.strength < 0 ? 'warning' : 'info'} label={titleCase(r.kind)} />
                        <span>{name(r.fromId === c.id ? r.toId : r.fromId)}</span>
                        <span className="muted tiny">{r.note}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            ) : (
              <Card title="Profile"><Empty>Select a person to see their profile.</Empty></Card>
            )}
            {c && (
              <Card title={`What ${c.name.split(' ')[0]} remembers`} sub="Character memory (persistent; beliefs, not necessarily facts)" flush>
                {(d.memoriesByCharacter[c.id] ?? []).length === 0 ? <Empty>No recorded memories yet.</Empty> : (
                  <div className="list">
                    {d.memoriesByCharacter[c.id].map((m: any) => (
                      <div key={m.id} className="list-item">
                        <span className={`sev-bar sev-${m.sentiment < 0 ? 'critical' : m.sentiment > 0 ? 'info' : 'low'}`} />
                        <div>
                          <div className="small">{m.summary}</div>
                          <div className="tiny muted">{fmtDate(m.date)} · {m.kind} · importance {m.importance}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </div>
        </div>
      )}
      {tab === 'org' && (
        <Card title="Departments & workforce" flush>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Department</th><th>Kind</th><th>Head</th><th className="num">Headcount</th><th className="num">Cost / head / yr</th><th className="num">Annual payroll</th><th>Morale</th><th>Pipeline</th></tr></thead>
              <tbody>
                {d.departments.map((x: any) => (
                  <tr key={x.id}>
                    <td className="strong">{x.name}<div className="tiny muted">{x.description}</div></td>
                    <td>{titleCase(x.kind)}</td>
                    <td className="small">{name(x.headId)}</td>
                    <td className="num">{fmtInt(x.headcount)}</td>
                    <td className="num">{fmtEur(x.annualCostPerHeadCents)}</td>
                    <td className="num">{fmtEur(x.headcount * x.annualCostPerHeadCents)}</td>
                    <td style={{ minWidth: 100 }}><div className="row"><Progress value={x.morale / 100} tone={x.morale < 45 ? 'var(--critical)' : undefined} /><span className="num small">{Math.round(x.morale)}</span></div></td>
                    <td className="small">
                      {x.hiring.map((h: any, i: number) => <div key={i}>+{fmtInt(h.count)} by {fmtDate(h.arrivalDate)}</div>)}
                      {x.leaving.map((h: any, i: number) => <div key={i} style={{ color: 'var(--critical-text)' }}>−{fmtInt(h.count)} on {fmtDate(h.date)}</div>)}
                    </td>
                  </tr>
                ))}
                <tr className="total"><td>Total</td><td></td><td></td><td className="num">{fmtInt(d.departments.reduce((a: number, x: any) => a + x.headcount, 0))}</td><td></td><td className="num">{fmtEur(d.departments.reduce((a: number, x: any) => a + x.headcount * x.annualCostPerHeadCents, 0))}</td><td></td><td></td></tr>
              </tbody>
            </table>
          </div>
          <div className="row tiny muted" style={{ padding: '6px 14px' }}>
            <span>Hire or reduce headcount in Decisions → People &amp; communication (also Operations → Workforce). Payroll is base cost × wage index (collective agreements raise it).</span>
            <span className="spacer" />
            <button className="btn sm" onClick={() => go('decisions', 'people')}>Hire or reduce…</button>
          </div>
        </Card>
      )}
      {tab === 'board' && (
        <Card title="Board of directors" sub="Six voting directors; ties are broken by the chair. Each director weighs what a proposal itself does — its cash, recurring profit, jobs, risk, strategic fit and whether it is unavoidable — by their own priorities, then adds their trust in you and the board's confidence. Before you submit anything, its review shows how each director is likely to vote." flush>
          <table>
            <thead><tr><th>Director</th><th>Represents</th><th>Trust</th><th>Weights what most</th></tr></thead>
            <tbody>
              {chars.filter((x) => x.isBoardMember).map((x) => {
                const prefs = Object.entries(x.boardPrefs ?? {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 3);
                return (
                  <tr key={x.id}>
                    <td className="strong">{x.name}</td>
                    <td className="small">{x.title}</td>
                    <td><div className="row"><Progress value={x.trustInCeo / 100} tone={trustTone(x.trustInCeo)} /><span className="num small">{Math.round(x.trustInCeo)}</span></div></td>
                    <td className="small">{prefs.map(([k, v]: any) => `${k} (${Math.round(v * 100)}%)`).join(' · ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {tab === 'share' && (
        <Card title="Share a document or send a memo" sub="Reports are built from the company's current figures. Recipients remember them in later meetings; colleagues learn they were circulated. Sharing does not change the company.">
          <ShareForm />
        </Card>
      )}
      {tab === 'rules' && (
        <Card title="Approval rights & institutional rules" flush>
          <table>
            <thead><tr><th>Decision</th><th>CEO</th><th>Board</th><th>Delegated</th></tr></thead>
            <tbody>
              {d.rules.matrix.map((r: any) => (
                <tr key={r.decision}><td className="strong">{r.decision}</td><td className="small">{r.ceo}</td><td className="small">{r.board}</td><td className="small">{r.delegated}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="small muted" style={{ padding: '8px 14px' }}>Characters may propose actions in meetings; only someone with the right authority can approve them. The validator refuses approvals beyond a person's limit.</div>
        </Card>
      )}
    </div>
  );
}
