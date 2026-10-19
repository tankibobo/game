import { useState } from 'react';
import { BarSeriesChart, LineSeriesChart } from '../components/charts';
import { Card, D, Empty, EntityLink, Est, Kpi, Loading, Progress, Sev, Status } from '../components/ui';
import { useGame, useView } from '../ctx';
import { diffDays, eurM, fmtDate, fmtEur, fmtInt, fmtPct, fmtX } from '../format';

const START_KEY = 'automanager.gettingStarted.hidden';

function GettingStarted({ onHide }: { onHide: () => void }) {
  const { go, openGuide } = useGame();
  return (
    <Card title="Getting started" sub="How a turn works — hide this once you are comfortable." actions={<button className="btn sm ghost" onClick={onHide}>Hide</button>}>
      <ol className="small" style={{ margin: '0 0 0 18px', padding: 0 }}>
        <li>Read your messages in <a href="#" onClick={(e) => { e.preventDefault(); go('inbox'); }}>Inbox &amp; meetings</a> — they describe the situation and what people need from you.</li>
        <li>Talk to people with <strong>Meet</strong> (Company page). They answer from what they know; they can propose decisions and you can send them reports.</li>
        <li>Open <a href="#" onClick={(e) => { e.preventDefault(); go('decisions'); }}>Decisions</a> to see everything you can decide. <strong>Preview…</strong> never changes anything: it shows the consequences, who approves and what happens next.</li>
        <li>Decisions above your authority go to the board when you confirm them; the review shows how each director is likely to vote. If approved they are carried out on the meeting day.</li>
        <li>Advance time with <strong>+1 day / +1 week / +1 month</strong> and read the briefing. Dated effects (hires, consultations, board votes) appear in Decisions → In progress.</li>
        <li>Not sure what to do? Open the <a href="#" onClick={(e) => { e.preventDefault(); openGuide('coach'); }}>Coach</a> (? Guide): it lists what to fix first, why, and lets you preview each decision in one click. To learn how something works, ask the Guide, e.g. “How do I hire more people?”.</li>
      </ol>
    </Card>
  );
}

const OBJ_TONE: Record<string, [string, string]> = { met: ['Met', 'good'], on_track: ['On track', 'info'], at_risk: ['At risk', 'warning'], missed: ['Missed', 'critical'] };

/** The three-year mandate: what the board will judge at the final review. */
function MandateCard({ m }: { m: any }) {
  const { openGuide } = useGame();
  if (!m) return null;
  const r = m.result;
  return (
    <Card title="Your mandate" sub={r ? `Final review ${fmtDate(r.date, 'long')}` : `Final review ${fmtDate(m.termEnd, 'long')} · ${m.difficulty}`} actions={<button className="btn sm" onClick={() => openGuide('coach')}>Coach</button>}>
      {r && <div className={`callout ${r.passed ? 'good' : 'critical'} small`} style={{ marginBottom: 8 }}>{r.passed ? `Renewed — grade ${r.grade}, ${r.score}/100. You won.` : `Not renewed — ${r.score}/100 (needed ${r.passScore}).`}</div>}
      <div className="row" style={{ alignItems: 'baseline' }}>
        <div style={{ fontSize: 26, fontWeight: 750 }}>{m.score}</div>
        <div className="muted">/ 100 if judged today</div>
        <div className="spacer" />
        <span className="small muted">renewal at {m.passScore}</span>
      </div>
      <Progress value={m.score / 100} tone={m.score < m.passScore ? 'var(--serious)' : undefined} />
      <div className="small" style={{ marginTop: 8 }}>
        {m.objectives.map((o: any) => (
          <div key={o.id} className="row" style={{ justifyContent: 'space-between', gap: 6 }} title={`${o.detail} — ${o.hint}`}>
            <span className="sub" style={{ flex: 1 }}>{o.label}</span>
            <span className={`pill ${OBJ_TONE[o.state][1]}`}>{OBJ_TONE[o.state][0]}</span>
            <span className="num tiny muted" style={{ width: 38, textAlign: 'right' }}>{Math.round(o.score * o.weight)}/{o.weight}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Dashboard() {
  const { data: d, error } = useView<any>('/dashboard');
  const { go, reviewAction, openGuide } = useGame();
  const [hideStart, setHideStart] = useState(() => {
    try {
      return localStorage.getItem(START_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!d) return <Loading error={error} />;
  const k = d.kpis;
  const fc = d.forecast;
  const base = fc?.scenarios.find((s: any) => s.key === 'base');
  const today = d.meta.currentDate;
  const liqData = (base?.months ?? []).map((m: any, i: number) => ({
    month: m.month.slice(2).replace('-', '/'),
    base: eurM(m.liquidityCents),
    downside: eurM(fc.scenarios[1]?.months[i]?.liquidityCents ?? 0),
    upside: eurM(fc.scenarios[2]?.months[i]?.liquidityCents ?? 0),
  }));
  const monthly = [
    ...d.months.map((m: any) => ({ month: m.period.slice(2).replace('-', '/'), revenue: eurM(m.data.revenueCents), ebit: eurM(m.data.ebitCents), kind: 'actual' })),
  ];
  const lm = d.lastMonth?.data;
  const pendingConfirm = d.pendingActions.filter((a: any) => a.status === 'pending_confirmation');
  const pendingBoard = d.pendingActions.filter((a: any) => a.status === 'pending_approval');
  const waitingApproved = d.pendingActions.filter((a: any) => a.status === 'approved');
  const who = (id: string) => (id === 'ceo' ? 'you' : d.names?.[id] ?? id);
  const hide = () => {
    setHideStart(true);
    try {
      localStorage.setItem(START_KEY, '1');
    } catch {
      /* storage unavailable */
    }
  };
  const s = base?.summary;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Executive dashboard</h1>
          <p>{d.meta.companyName} · fiscal year {k.yearLabel} · rating {d.meta.creditRating} ({d.meta.ratingOutlook})</p>
        </div>
      </div>
      {!hideStart && diffDays(today, d.meta.startDate ?? today) < 120 && <div style={{ marginBottom: 14 }}><GettingStarted onHide={hide} /></div>}
      <div className="kpis">
        <Kpi label="Cash" value={fmtEur(k.cashCents)} hint={`RCF drawn ${fmtEur(k.rcfDrawnCents)} of ${fmtEur(k.rcfLimitCents)}`} />
        <Kpi label="Liquidity (cash + undrawn RCF)" value={fmtEur(k.liquidityCents)} hint="EIB covenant: ≥ €400m" tone={k.liquidityCents < 45_000_000_000 ? 'critical' : undefined} />
        <Kpi label={`Revenue YTD ${k.yearLabel}`} value={fmtEur(k.revenueYtdCents)} hint={`FY2026: ${fmtEur(d.fy2026.revenueCents)}`} />
        <Kpi label="Operating profit YTD" value={fmtEur(k.ebitYtdCents)} hint={k.revenueYtdCents ? `margin ${fmtPct(k.ebitYtdCents / k.revenueYtdCents)}` : 'no revenue booked yet'} tone={k.ebitYtdCents < 0 ? 'critical' : undefined} />
        <Kpi label="Gross debt / net leverage" value={fmtEur(k.grossDebtCents)} hint={`net ${fmtX(k.netLeverage)} (covenant ≤ 3.50x)`} tone={k.netLeverage > 3.5 ? 'critical' : undefined} />
        <Kpi label="Last month built / sold" value={lm ? `${fmtInt(lm.unitsProduced)} / ${fmtInt(lm.unitsRetail)}` : '—'} hint={d.lastMonth ? `${fmtDate(d.lastMonth.date, 'month')} · ${fmtInt(k.headcount)} employees` : 'pre-game baseline'} />
      </div>

      <div className="grid g-main">
        <div className="stack">
          <Card title="Liquidity forecast" sub={fc ? <>Simulation run on {fmtDate(fc.createdDate)} — <Est>estimate</Est> no new decisions, financing or shocks assumed</> : null} actions={<button className="btn sm" onClick={() => go('finance', 'forecast')}>Scenarios</button>}>
            {fc ? (
              <>
                <div className="row" style={{ gap: 16, marginBottom: 8 }}>
                  <div><div className="tiny muted">FY{k.yearLabel} operating profit</div><div className="strong">{fmtEur(s.fyEbitCents)} <span className="muted small">plan {fmtEur(d.board.plan.ebitTargetCents)}</span></div></div>
                  <div><div className="tiny muted">12-month minimum liquidity</div><div className="strong" style={{ color: s.minLiquidity12mCents < 40_000_000_000 ? 'var(--critical-text)' : undefined }}>{fmtEur(s.minLiquidity12mCents)} <span className="muted small">{fmtDate(s.minLiquidity12mDate)}</span></div></div>
                  <div><div className="tiny muted">Eon start of production</div><div className="strong">{s.eonSopForecast ? fmtDate(s.eonSopForecast) : <span style={{ color: 'var(--critical-text)' }}>blocked{s.eonSopConditional ? ` (≈${fmtDate(s.eonSopConditional)} if supply secured)` : ''}</span>} <span className="muted small">plan {fmtDate(d.board.plan.eonSopDate)}</span></div></div>
                  <div><div className="tiny muted">CO₂ premium FY</div><div className="strong">{fmtEur(s.co2PenaltyFyCents)}</div></div>
                </div>
                <LineSeriesChart data={liqData} x="month" unit="€m" refY={400} refLabel="EIB min. liquidity €400m" series={[{ key: 'base', label: 'Base', color: 'var(--series-1)' }, { key: 'downside', label: 'Downside (−8% demand)', color: 'var(--series-2)', dashed: true }, { key: 'upside', label: 'Upside (+5%)', color: 'var(--series-3)', dashed: true }]} />
              </>
            ) : (
              <Empty>No forecast yet.</Empty>
            )}
          </Card>
          <div className="grid g2">
            <Card title="Monthly revenue (actual)">
              {monthly.length ? <BarSeriesChart data={monthly} x="month" unit="€m" series={[{ key: 'revenue', label: 'Revenue', color: 'var(--series-1)' }]} /> : <Empty>Closes at month end.</Empty>}
              <div className="tiny muted">Months before Jan 2027 are the FY2026 baseline averaged per month.</div>
            </Card>
            <Card title="Monthly operating profit (actual)">
              {monthly.length ? <BarSeriesChart data={monthly} x="month" unit="€m" series={[{ key: 'ebit', label: 'EBIT', color: 'var(--series-1)' }]} /> : <Empty>Closes at month end.</Empty>}
            </Card>
          </div>
          <Card title="Project health" flush actions={<button className="btn sm" onClick={() => go('projects')}>All projects</button>}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Project</th><th>Status</th><th>Progress</th><th className="num">Target</th><th className="num">Forecast</th><th className="num">Budget used</th></tr>
                </thead>
                <tbody>
                  {d.projects.filter((p: any) => p.status !== 'cancelled').map((p: any) => {
                    const late = p.forecastDate && p.forecastDate > p.targetDate;
                    return (
                      <tr key={p.id}>
                        <td><EntityLink type="project" id={p.id}>{p.name}</EntityLink>{p.targetDate !== p.originalTargetDate && <div className="tiny muted">original target {fmtDate(p.originalTargetDate)}</div>}</td>
                        <td><Status s={p.status} /></td>
                        <td style={{ minWidth: 90 }}><Progress value={p.progress} /></td>
                        <td className="num"><D d={p.targetDate} /></td>
                        <td className="num" style={{ color: late ? 'var(--critical-text)' : undefined }}>{p.status === 'completed' ? 'done' : p.status === 'proposed' ? 'not started' : p.forecastDate ? fmtDate(p.forecastDate) : 'blocked'}</td>
                        <td className="num">{fmtPct(p.spentCents / Math.max(1, p.budgetCents), 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Production & sales by model" flush>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Model</th><th>Status</th><th className="num">Built (last month)</th><th className="num">Retail (last month)</th><th className="num">Demand / month <span className="tiny">(est.)</span></th><th className="num">Company stock</th><th className="num">Dealer stock</th></tr>
                </thead>
                <tbody>
                  {d.models.map((m: any) => (
                    <tr key={m.id}>
                      <td className="strong"><EntityLink type="model" id={m.id}>{m.name}</EntityLink></td>
                      <td><Status s={m.status} /></td>
                      <td className="num">{fmtInt(m.productionLastMonth)}</td>
                      <td className="num">{fmtInt(m.retailLastMonth)}</td>
                      <td className="num">{fmtInt(m.demandEstimate)}</td>
                      <td className="num">{fmtInt(m.fgUnits)}</td>
                      <td className="num">{fmtInt(m.dealerStock)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="stack">
          {d.briefing && (
            <Card title="CEO briefing" sub={fmtDate(d.briefing.date, 'long')}>
              <div className="pre small">{d.briefing.body}</div>
            </Card>
          )}
          <Card title="Decisions waiting for you" flush actions={<button className="btn sm" onClick={() => go('decisions')}>Decisions</button>}>
            {pendingConfirm.length === 0 && pendingBoard.length === 0 && waitingApproved.length === 0 ? (
              <Empty>Nothing waiting. Take decisions on the Decisions page.</Empty>
            ) : (
              <div className="list">
                {pendingConfirm.map((a: any) => (
                  <div key={a.id} className="list-item clickable" onClick={() => reviewAction(a.id)}>
                    <div style={{ flex: 1 }}>
                      <div className="t">{a.summary}</div>
                      <div className="small muted">{a.source === 'llm_proposal' ? `proposed by ${who(a.actorId)} in a meeting` : 'your draft'} · {fmtDate(a.simDate)}</div>
                    </div>
                    <Status s={a.status} label="review" />
                  </div>
                ))}
                {waitingApproved.map((a: any) => (
                  <div key={a.id} className="list-item clickable" onClick={() => reviewAction(a.id)}>
                    <div style={{ flex: 1 }}>
                      <div className="t">{a.summary}</div>
                      <div className="small muted">approved by the board — not possible yet; see why</div>
                    </div>
                    <Status s="delayed" label="waiting" />
                  </div>
                ))}
                {pendingBoard.map((a: any) => (
                  <div key={a.id} className="list-item clickable" onClick={() => reviewAction(a.id)}>
                    <div style={{ flex: 1 }}>
                      <div className="t">{a.summary}</div>
                      <div className="small muted">awaiting the board vote on {fmtDate(d.board.scheduled.find((p: any) => (p.actionIds ?? []).includes(a.id) || p.actionId === a.id)?.meetingDate ?? d.board.nextMeeting)}</div>
                    </div>
                    <Status s="pending_approval" label="board" />
                  </div>
                ))}
              </div>
            )}
          </Card>
          <MandateCard m={d.mandate} />
          <Card title="Board" sub={`Next meeting ${fmtDate(d.board.nextMeeting, 'long')} (${diffDays(d.board.nextMeeting, today)} days)`}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <div style={{ fontSize: 26, fontWeight: 750 }}>{Math.round(d.board.confidence)}</div>
              <div className="muted">/ 100 confidence</div>
              <div className="spacer" />
              <span className="small muted">trend → {Math.round(d.board.target)}</span>
            </div>
            <Progress value={d.board.confidence / 100} tone={d.board.confidence < 30 ? 'var(--critical)' : undefined} />
            {d.board.lowConfidenceMeetings > 0 && <div className="callout critical small" style={{ marginTop: 8 }}>The board has formally warned you ({d.board.lowConfidenceMeetings} of {d.board.dismissalMeetings} meetings below {d.board.dismissalThreshold}). {d.board.dismissalMeetings - d.board.lowConfidenceMeetings <= 1 ? `Another meeting below ${d.board.dismissalThreshold} means dismissal.` : ''} <a href="#" onClick={(e) => { e.preventDefault(); openGuide('coach'); }}>Ask the Coach what to fix</a>.</div>}
            <div className="small" style={{ marginTop: 8 }}>
              {d.board.factors.filter((f: any) => Math.abs(f.delta) >= 0.5).map((f: any, i: number) => (
                <div key={i} className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="sub">{f.label}</span>
                  <span className="num" style={{ color: f.delta < 0 ? 'var(--critical-text)' : 'var(--good-text)' }}>{f.delta > 0 ? '+' : ''}{f.delta.toFixed(0)}</span>
                </div>
              ))}
            </div>
            {d.board.scheduled.length > 0 && (
              <>
                <hr className="sep" />
                <div className="small strong">On the agenda</div>
                {d.board.scheduled.map((p: any) => <div key={p.id} className="small">• {p.title}</div>)}
              </>
            )}
          </Card>
          <Card title="Commitments" flush actions={<button className="btn sm" onClick={() => go('inbox', 'commitments')}>All</button>}>
            {d.commitments.overdue.length + d.commitments.upcoming.length === 0 ? (
              <Empty>No open commitments.</Empty>
            ) : (
              <div className="list">
                {[...d.commitments.overdue, ...d.commitments.upcoming].slice(0, 7).map((c: any) => (
                  <div key={c.id} className="list-item">
                    <Sev s={c.dueDate && c.dueDate < today ? 'critical' : c.dueDate && diffDays(c.dueDate, today) <= 14 ? 'warning' : 'info'} />
                    <div style={{ flex: 1 }}>
                      <div className="small">{c.description}</div>
                      <div className="tiny muted">to <EntityLink type="character" id={c.promiseeId}>{d.names[c.promiseeId] ?? c.promiseeId}</EntityLink> · due {c.dueDate ? fmtDate(c.dueDate) : 'n/a'} {c.dueDate && c.dueDate < today && <strong style={{ color: 'var(--critical-text)' }}>OVERDUE</strong>}</div>
                    </div>
                    <Status s={c.status} />
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Critical risks & issues" flush actions={<button className="btn sm" onClick={() => go('projects', 'issues')}>Issue log</button>}>
            {d.issues.length === 0 ? <Empty>No open issues.</Empty> : (
              <div className="list">
                {d.issues.slice(0, 6).map((i: any) => (
                  <div key={i.id} className="list-item clickable" onClick={() => go('projects', i.id)}>
                    <Sev s={i.severity} />
                    <div style={{ flex: 1 }}>
                      <div className="small strong">{i.title}</div>
                      <div className="tiny muted">{i.nextAction}</div>
                    </div>
                    <Status s={i.severity} />
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Debt maturities" flush>
            <table>
              <tbody>
                {d.debtMaturities.map((x: any) => (
                  <tr key={x.id}>
                    <td className="small">{x.name}{x.nextAmortization && <div className="tiny muted">next repayment {fmtEur(x.nextAmortization.amountCents)} on {fmtDate(x.nextAmortization.date)}</div>}</td>
                    <td className="num small">{fmtEur(x.principalCents)}</td>
                    <td className="num small" style={{ color: diffDays(x.maturityDate, today) < 550 ? 'var(--critical-text)' : undefined }}>{fmtDate(x.maturityDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Recent events" flush actions={<button className="btn sm" onClick={() => go('history')}>History</button>}>
            <div className="list">
              {d.events.slice(0, 10).map((e: any) => (
                <div key={e.id} className="list-item">
                  <Sev s={e.severity} />
                  <div style={{ flex: 1 }}>
                    <div className="small">{e.title}</div>
                    <div className="tiny muted">{fmtDate(e.date)} · {e.causeKind.replace('_', ' ')}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
