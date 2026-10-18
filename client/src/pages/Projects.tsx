import { useEffect, useState } from 'react';
import { Card, D, Empty, EntityLink, Est, Loading, Progress, Sev, Status, Tabs } from '../components/ui';
import { useGame, useView } from '../ctx';
import { diffDays, fmtDate, fmtEur, fmtInt, fmtPct, titleCase } from '../format';

function IssueCard({ i, chars }: { i: any; chars: any[] }) {
  const { propose } = useGame();
  const owner = chars.find((c) => c.id === i.ownerId);
  const open = !['resolved', 'closed'].includes(i.status);
  return (
    <div className="list-item" id={i.id}>
      <Sev s={i.severity} />
      <div style={{ flex: 1 }} className="stack">
        <div className="row">
          <span className="t">{i.title}</span>
          <Status s={i.severity} />
          <Status s={i.status} />
          <span className="spacer" />
          <span className="tiny muted">{i.id} · owner {owner?.name ?? '—'} · found {fmtDate(i.discoveredDate)}{i.deadline ? ` · deadline ${fmtDate(i.deadline)}` : ''}</span>
        </div>
        <div className="small">{i.description}</div>
        {i.resolutionWorkTotal > 0 && open && (
          <div className="row small"><span className="muted">Resolution work</span><Progress value={i.resolutionWorkDone / i.resolutionWorkTotal} /><span className="num">{fmtPct(i.resolutionWorkDone / i.resolutionWorkTotal, 0)}</span>{i.drag > 0 && <span className="muted">· absorbs {fmtPct(i.drag, 0)} of project capacity</span>}</div>
        )}
        {typeof i.data?.incidents === 'number' && <div className="small">Field incidents to date: <strong>{i.data.incidents}</strong>{i.data.rootCause === 'confirmed' && ' · root cause confirmed'}</div>}
        {open && <div className="small"><strong>Next action:</strong> {i.nextAction}</div>}
        {i.resolutionNote && <div className="small" style={{ color: 'var(--good-text)' }}>Resolved {fmtDate(i.resolvedDate)}: {i.resolutionNote}</div>}
        {open && i.options.filter((o: any) => !i.chosenOptions.includes(o.key)).length > 0 && (
          <div className="grid g3" style={{ gap: 8 }}>
            {i.options.filter((o: any) => !i.chosenOptions.includes(o.key)).map((o: any) => (
              <div key={o.key} className="proposal">
                <div className="strong small">{o.label}</div>
                <div className="tiny sub">{o.description}</div>
                <div className="tiny muted">{o.tradeoffs}</div>
                <div className="row"><span className="num small strong">{o.costCents ? fmtEur(o.costCents) : 'no direct cost'}</span><span className="spacer" /><button className="btn sm" onClick={() => propose('address_issue', { issueId: i.id, optionKey: o.key })}>Preview</button></div>
              </div>
            ))}
          </div>
        )}
        {i.chosenOptions.length > 0 && <div className="tiny muted">Decisions taken: {i.chosenOptions.map(titleCase).join(', ')}</div>}
      </div>
    </div>
  );
}

function Replan({ p }: { p: any }) {
  const { propose } = useGame();
  const [target, setTarget] = useState(p.targetDate);
  const [staff, setStaff] = useState('');
  const [budget, setBudget] = useState('');
  const [descope, setDescope] = useState('');
  const [reason, setReason] = useState('');
  const submit = () => {
    const payload: any = { projectId: p.id, reason: reason || 'Re-plan decided by the CEO' };
    if (target && target !== p.targetDate) payload.newTargetDate = target;
    if (staff) payload.staffingDelta = Math.round(Number(staff));
    if (budget) payload.budgetDeltaCents = Math.round(Number(budget) * 1e8);
    if (descope) payload.descopePct = Number(descope) / 100;
    propose('change_project_scope', payload);
  };
  return (
    <div className="form-grid">
      <label className="field">New target date<input type="date" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
      <label className="field">Staffing change (FTE, ±)<input type="number" value={staff} onChange={(e) => setStaff(e.target.value)} placeholder="e.g. 100 or −200" /></label>
      <label className="field">Budget change (€m, ±)<input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 40" /></label>
      <label className="field">Descope remaining work (%)<input type="number" min={0} max={30} value={descope} onChange={(e) => setDescope(e.target.value)} placeholder="0–30" /></label>
      <label className="field" style={{ gridColumn: '1 / -1' }}>Reason (recorded in the project history)<input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you changing the plan?" /></label>
      <div><button className="btn primary" onClick={submit}>Preview consequences</button></div>
    </div>
  );
}

function ProjectDetail({ p, chars, today }: { p: any; chars: any[]; today: string }) {
  const { propose } = useGame();
  const name = (id: string) => chars.find((c) => c.id === id)?.name ?? id;
  const late = p.forecastDate && p.forecastDate > p.targetDate;
  const active = ['active', 'delayed', 'blocked'].includes(p.status);
  return (
    <div className="stack">
      <Card
        title={p.name}
        sub={`${p.id} · ${titleCase(p.kind)} · priority ${p.priority} · sponsor ${name(p.sponsorId)} · manager ${name(p.managerId)}`}
        actions={
          <>
            <Status s={p.status} />
            {p.status === 'proposed' && <button className="btn primary sm" onClick={() => propose('approve_project', { projectId: p.id })}>Approve…</button>}
            {(active || p.status === 'proposed') && <button className="btn danger sm" onClick={() => propose('cancel_project', { projectId: p.id, reason: 'Cancelled by the CEO' })}>Cancel…</button>}
          </>
        }
      >
        <div className="small" style={{ marginBottom: 8 }}>{p.objective} <span className="muted">Scope: {p.scope}</span></div>
        <div className="grid g4">
          <div><div className="tiny muted">Target date</div><div className="strong"><D d={p.targetDate} /></div>{p.targetDate !== p.originalTargetDate && <div className="tiny muted">original <D d={p.originalTargetDate} /></div>}</div>
          <div><div className="tiny muted">Forecast completion <Est>P50</Est></div><div className="strong" style={{ color: late ? 'var(--critical-text)' : undefined }}>{p.status === 'completed' ? `done ${fmtDate(p.completedDate)}` : p.status === 'proposed' ? 'not started' : p.forecastDate ? fmtDate(p.forecastDate) : 'blocked by a gate'}</div>{p.forecastP80Date && <div className="tiny muted">P80 <D d={p.forecastP80Date} /></div>}</div>
          <div><div className="tiny muted">Budget</div><div className="strong">{fmtEur(p.spentCents)} / {fmtEur(p.budgetCents)}</div><Progress value={p.spentCents / Math.max(1, p.budgetCents)} tone={p.spentCents > p.budgetCents ? 'var(--critical)' : undefined} />{p.budgetCents !== p.originalBudgetCents && <div className="tiny muted">original {fmtEur(p.originalBudgetCents)}</div>}</div>
          <div><div className="tiny muted">Staffing</div><div className="strong">{fmtInt(p.staffingFte)} FTE</div><div className="tiny muted">external {fmtEur(p.externalSpentCents)} · internal {fmtEur(p.internalCostCents)}</div></div>
        </div>
        {p.lastDecision && <div className="small muted" style={{ marginTop: 8 }}>Last decision: {p.lastDecision}</div>}
      </Card>
      <Card title="Milestones" flush sub="Work flows through milestones in order; a milestone closes only when its work is done and its gates are satisfied.">
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Milestone</th><th>Status</th><th>Work</th><th className="num">Planned</th><th className="num">Completed</th><th>Gates</th></tr></thead>
            <tbody>
              {p.milestones.map((m: any) => (
                <tr key={m.id}>
                  <td className="num">{m.seq}</td>
                  <td className="strong">{m.name}<div className="tiny muted">{m.description}</div></td>
                  <td><Status s={m.status} />{m.status !== 'completed' && m.plannedDate < today && <div className="tiny" style={{ color: 'var(--critical-text)' }}>overdue</div>}</td>
                  <td style={{ minWidth: 90 }}><Progress value={m.workDone / Math.max(1, m.workTotal)} /><span className="tiny muted">{fmtPct(m.workDone / Math.max(1, m.workTotal), 0)}</span></td>
                  <td className="num"><D d={m.plannedDate} />{m.plannedDate !== m.originalPlannedDate && <div className="tiny muted">orig. <D d={m.originalPlannedDate} /></div>}</td>
                  <td className="num"><D d={m.completedDate} /></td>
                  <td className="small">{m.gates.map((g: any, i: number) => <div key={i}>{g.type === 'issue_resolved' ? <>Issue <EntityLink type="issue" id={g.issueId} /> resolved</> : g.type === 'supply_capacity' ? `Battery supply ≥ ${g.minDaily}/day` : `Not before ${fmtDate(g.date)} — ${g.reason}`}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {p.issues.length > 0 && (
        <Card title="Risks & unresolved issues" flush>
          <div className="list">{p.issues.map((i: any) => <IssueCard key={i.id} i={i} chars={chars} />)}</div>
          {p.risks.length > 0 && <div className="small" style={{ padding: '8px 14px' }}><strong>Risk register:</strong> {p.risks.map((r: any) => `${r.text} (${r.likelihood}/${r.impact})`).join(' · ')}</div>}
        </Card>
      )}
      {active && <Card title="Re-plan this project" sub="A later date lets the team release engineers; more engineers have diminishing returns; a date alone does not make work go faster."><Replan p={p} /></Card>}
      <Card title="Change history" flush sub="Append-only — original values are never erased.">
        {p.history.length === 0 ? <Empty>No changes recorded since the start of the game.</Empty> : (
          <table>
            <thead><tr><th className="num">Date</th><th>Field</th><th>From</th><th>To</th><th>Reason</th></tr></thead>
            <tbody>
              {p.history.map((h: any) => (
                <tr key={h.id}><td className="num"><D d={h.date} /></td><td className="small">{h.field}</td><td className="small">{h.oldValue ?? '—'}</td><td className="small strong">{h.newValue ?? '—'}</td><td className="small">{h.reason}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div className="small muted">Acceptance criteria: {p.acceptanceCriteria.join(' · ')}{p.dependencies.length ? ` — Dependencies: ${p.dependencies.join(' · ')}` : ''}</div>
    </div>
  );
}

export function Projects() {
  const { data: d, error } = useView<any>('/projects');
  const { data: co } = useView<any>('/company');
  const { nav, propose } = useGame();
  const [tab, setTab] = useState<'projects' | 'issues' | 'new'>('projects');
  const [sel, setSel] = useState<string>('PRJ-EON');
  useEffect(() => {
    if (!nav.param) return;
    if (nav.param === 'issues' || nav.param.startsWith('ISS-')) setTab('issues');
    else if (nav.param.startsWith('PRJ-')) {
      setTab('projects');
      setSel(nav.param);
    } else if (nav.param.startsWith('MS-')) setTab('projects');
  }, [nav.param]);
  useEffect(() => {
    if (tab === 'issues' && nav.param?.startsWith('ISS-')) setTimeout(() => document.getElementById(nav.param!)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }, [tab, nav.param, d]);
  if (!d) return <Loading error={error} />;
  const chars = co?.characters ?? [];
  const p = d.projects.find((x: any) => x.id === sel) ?? d.projects[0];
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Projects, issues & roadmap</h1>
          <p>Engineering pool: {fmtInt(d.engineering.headcount)} engineers, {fmtInt(d.engineering.sustainingFte)} tied to sustaining work, <strong>{fmtInt(d.engineering.freeFte)} unassigned</strong>.</p>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[['projects', 'Projects'], ['issues', `Issue log (${d.issues.filter((i: any) => !['resolved', 'closed'].includes(i.status)).length} open)`], ['new', 'Start a project']]} />
      {tab === 'projects' && (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)' }}>
          <Card title="Portfolio" flush>
            <div className="list">
              {d.projects.map((x: any) => (
                <div key={x.id} className="list-item clickable" style={x.id === p?.id ? { background: 'var(--surface-2)' } : undefined} onClick={() => setSel(x.id)}>
                  <div style={{ flex: 1 }}>
                    <div className="t small">{x.name}</div>
                    <div className="row" style={{ marginTop: 3 }}><Status s={x.status} /><span className="tiny muted">target {fmtDate(x.targetDate)}</span></div>
                    <div style={{ marginTop: 4 }}><Progress value={x.progress} /></div>
                    {x.forecastDate && x.forecastDate > x.targetDate && <div className="tiny" style={{ color: 'var(--critical-text)' }}>forecast {diffDays(x.forecastDate, x.targetDate)} days late</div>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          {p && <ProjectDetail p={p} chars={chars} today={d.today} />}
        </div>
      )}
      {tab === 'issues' && (
        <Card title="Issue log" flush sub="Issues are tracked separately from projects; each has an owner, severity, deadline and response options.">
          <div className="list">
            {[...d.issues].sort((a: any, b: any) => Number(['resolved', 'closed'].includes(a.status)) - Number(['resolved', 'closed'].includes(b.status))).map((i: any) => <IssueCard key={i.id} i={i} chars={chars} />)}
          </div>
        </Card>
      )}
      {tab === 'new' && (
        <div className="grid g2">
          {d.templates.map((t: any) => {
            return (
              <Card key={t.key} title={t.name} sub={t.strategy} actions={<button className="btn sm primary" disabled={t.running} onClick={() => propose('start_project', { templateKey: t.key })}>{t.running ? 'Running' : 'Preview…'}</button>}>
                <div className="small">{t.objective}</div>
                <div className="row small" style={{ marginTop: 6 }}><span className="pill">{fmtEur(t.budgetCents)}</span><span className="pill">{t.fte} engineers</span><span className="pill">~{Math.round(t.durationDays / 30)} months</span>{t.needsBoard && <span className="pill warning">board approval</span>}</div>
                <div className="tiny muted" style={{ marginTop: 6 }}>{t.tradeoffs}</div>
                {t.replaces?.length > 0 && <div className="tiny" style={{ marginTop: 4, color: 'var(--warning-text)' }}>Replaces the proposed {t.replaces.join(', ')} (withdrawn when this starts).</div>}
                {t.reason && !t.running && <div className="tiny" style={{ marginTop: 4, color: 'var(--critical-text)' }}>Not possible now: {t.reason}</div>}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
