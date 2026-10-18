import { useState } from 'react';
import { Card, D, Loading, Progress, Status, Tabs } from '../components/ui';
import { useGame, useView } from '../ctx';
import { addDays, fmtDate, fmtEur, fmtInt, titleCase } from '../format';

function RateEditor({ l }: { l: any }) {
  const { propose } = useGame();
  const [v, setV] = useState(String(l.plannedDailyRate));
  return (
    <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
      <input type="number" min={0} max={l.maxDailyRate} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 72 }} aria-label={`Planned daily rate for ${l.name}`} />
      <button className="btn sm" onClick={() => propose('adjust_production', { lineId: l.id, plannedDailyRate: Math.round(Number(v)), reason: 'Production plan change' })}>Preview</button>
    </div>
  );
}

function Downtime({ f, today }: { f: any; today: string }) {
  const { propose } = useGame();
  const [s, setS] = useState(addDays(today, 7));
  const [e, setE] = useState(addDays(today, 11));
  return (
    <div className="row small">
      <input type="date" value={s} onChange={(x) => setS(x.target.value)} aria-label="Downtime start" />
      <span>→</span>
      <input type="date" value={e} onChange={(x) => setE(x.target.value)} aria-label="Downtime end" />
      <button className="btn sm" onClick={() => propose('schedule_downtime', { factoryId: f.id, startDate: s, endDate: e, reason: 'Inventory adjustment' })}>Plan downtime…</button>
    </div>
  );
}

function Workforce({ dep }: { dep: any }) {
  const { propose } = useGame();
  const [n, setN] = useState('');
  const [mode, setMode] = useState<'voluntary' | 'compulsory'>('voluntary');
  return (
    <div className="row small" style={{ flexWrap: 'nowrap' }}>
      <input type="number" min={1} value={n} onChange={(e) => setN(e.target.value)} placeholder="people" style={{ width: 80 }} aria-label={`Headcount change for ${dep.name}`} />
      <button className="btn sm" disabled={!n} onClick={() => propose('hire_staff', { departmentId: dep.id, headcount: Math.round(Number(n)), reason: 'Workforce plan' })}>Hire…</button>
      <select value={mode} onChange={(e) => setMode(e.target.value as any)} aria-label="Reduction mode">
        <option value="voluntary">voluntary</option>
        <option value="compulsory">compulsory</option>
      </select>
      <button className="btn sm danger" disabled={!n} onClick={() => propose('restructure_workforce', { departmentId: dep.id, reduction: Math.round(Number(n)), mode, reason: 'Capacity adjustment' })}>Reduce…</button>
    </div>
  );
}

export function Operations() {
  const { data: d, error } = useView<any>('/operations');
  const [tab, setTab] = useState<'plants' | 'supply' | 'inventory' | 'workforce'>('plants');
  if (!d) return <Loading error={error} />;
  const supplier = (id: string) => d.suppliers.find((s: any) => s.id === id);
  const model = (id: string) => d.models.find((m: any) => m.id === id)?.name.replace('Asterion ', '') ?? id;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Operations</h1>
          <p>Output each working day = planned rate × ramp-up × workforce availability, capped by critical-component stock and supplier deliveries.</p>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[['plants', 'Plants & lines'], ['inventory', 'Inventory & backlog'], ['supply', 'Suppliers'], ['workforce', 'Workforce']]} />
      {tab === 'plants' && (
        <div className="stack">
          <Card title="Production lines" flush>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Line</th><th>Plant</th><th>Model</th><th>Status</th><th className="num">Capacity / day</th><th className="num">Planned / day</th><th>Utilisation</th><th className="num">≈ per year</th><th>Change rate</th></tr></thead>
                <tbody>
                  {d.lines.map((l: any) => (
                    <tr key={l.id}>
                      <td className="strong">{l.name}</td>
                      <td className="small">{d.factories.find((f: any) => f.id === l.factoryId)?.name}</td>
                      <td>{model(l.modelId)}</td>
                      <td><Status s={l.status} />{l.status === 'ramp_up' && <div className="tiny muted">since {fmtDate(l.rampStartDate)}</div>}</td>
                      <td className="num">{fmtInt(l.maxDailyRate)}</td>
                      <td className="num strong">{fmtInt(l.plannedDailyRate)}</td>
                      <td style={{ minWidth: 90 }}><Progress value={l.plannedDailyRate / l.maxDailyRate} /></td>
                      <td className="num">{fmtInt(l.status === 'running' || l.status === 'ramp_up' ? l.plannedDailyRate * 230 : 0)}</td>
                      <td><RateEditor l={l} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="grid g3">
            {d.factories.map((f: any) => {
              const ratio = f.requiredCrew ? f.availableCrew / f.requiredCrew : 1;
              return (
                <Card key={f.id} title={f.name} sub={`${f.location}, ${f.country}`} actions={<Status s={f.status} />}>
                  <div className="small stack" style={{ gap: 6 }}>
                    <div>{f.description}</div>
                    <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Workforce</span><span className="num">{fmtInt(f.workforce)}</span></div>
                    <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Absenteeism</span><span className="num">{f.absenteeismPct.toFixed(1)}%</span></div>
                    <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Crew present / required at plan</span><span className="num" style={{ color: ratio < 1 ? 'var(--critical-text)' : undefined }}>{fmtInt(f.availableCrew)} / {fmtInt(f.requiredCrew)}</span></div>
                    <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Morale</span><span className="num">{Math.round(f.morale)}</span></div>
                    <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Fixed overhead / month</span><span className="num">{fmtEur(f.fixedOverheadMonthlyCents)}</span></div>
                    <div>
                      <div className="muted">Scheduled downtime</div>
                      {f.upcomingDowntime.length === 0 ? <div className="tiny muted">none</div> : f.upcomingDowntime.slice(0, 4).map((x: any, i: number) => <div key={i} className="tiny">{fmtDate(x.start)} → {fmtDate(x.end)} · {x.reason}</div>)}
                    </div>
                    <Downtime f={f} today={d.today} />
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
      {tab === 'inventory' && (
        <Card title="Inventory, dealer stock & order backlog" flush sub="Revenue is recognised when dealers take delivery (wholesale). Unsold company stock is inventory, not revenue.">
          <table>
            <thead><tr><th>Model</th><th className="num">Built last month</th><th className="num">Delivered to dealers</th><th className="num">Retail sales</th><th className="num">Demand / month <span className="tiny">est.</span></th><th className="num">Company stock</th><th className="num">Stock value</th><th className="num">Dealer stock</th><th className="num">Customer backlog</th></tr></thead>
            <tbody>
              {d.models.map((m: any) => (
                <tr key={m.id}>
                  <td className="strong">{m.name}</td>
                  <td className="num">{fmtInt(m.productionLastMonth)}</td>
                  <td className="num">{fmtInt(m.wholesaleLastMonth)}</td>
                  <td className="num">{fmtInt(m.retailLastMonth)}</td>
                  <td className="num">{fmtInt(m.demandEstimate)}</td>
                  <td className="num">{fmtInt(m.fgUnits)}</td>
                  <td className="num">{fmtEur(m.fgValueCents)}</td>
                  <td className="num">{fmtInt(m.dealerStock)}</td>
                  <td className="num">{fmtInt(m.backlog)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {tab === 'supply' && (
        <div className="stack">
          <Card title="Critical component supply" flush sub="Components are consignment stock until consumed. A disruption affects only the models that use that component.">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Supplier</th><th>Component</th><th>Used by</th><th className="num">Unit price</th><th className="num">Capacity / day</th><th className="num">Stock (sets)</th><th>Status</th><th>Contracted changes</th></tr></thead>
                <tbody>
                  {d.supplies.map((s: any) => (
                    <tr key={s.id}>
                      <td className="strong">{supplier(s.supplierId)?.name}{s.isAlternative ? <span className="pill info" style={{ marginLeft: 4 }}>2nd source</span> : null}</td>
                      <td>{s.component}</td>
                      <td className="small">{s.modelIds.map(model).join(', ')}</td>
                      <td className="num">{fmtEur(s.unitPriceCents, { compact: false })}</td>
                      <td className="num">{fmtInt(s.dailyCapacity)}</td>
                      <td className="num">{fmtInt(s.stockUnits)}</td>
                      <td>{s.disruptionUntil && s.disruptionUntil >= d.today ? <span className="pill critical">−{Math.round(s.disruptionFactor * 100)}% until {fmtDate(s.disruptionUntil)}</span> : <span className="pill good">normal</span>}</td>
                      <td className="small">{s.pendingCapacity.map((p: any, i: number) => <div key={i}>{p.dailyCapacity}/day from {fmtDate(p.date)}</div>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Suppliers" flush>
            <table>
              <thead><tr><th>Supplier</th><th>Category</th><th>Country</th><th className="num">Reliability</th><th className="num">Quality</th><th className="num">Financial health</th><th className="num">Relationship</th><th className="num">Payment terms</th></tr></thead>
              <tbody>
                {d.suppliers.map((s: any) => (
                  <tr key={s.id}><td className="strong">{s.name}<div className="tiny muted">{s.description}</div></td><td className="small">{s.category}</td><td className="small">{s.country}</td><td className="num">{s.reliability}</td><td className="num">{s.qualityScore}</td><td className="num" style={{ color: s.financialHealth < 50 ? 'var(--critical-text)' : undefined }}>{s.financialHealth}</td><td className="num">{Math.round(s.relationship)}</td><td className="num">{s.paymentTermsDays} days</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Supply & labour contracts" flush>
            <table>
              <thead><tr><th>Contract</th><th>Counterparty</th><th>Status</th><th className="num">Signed</th><th className="num">Ends</th><th>Summary</th></tr></thead>
              <tbody>
                {d.contracts.map((c: any) => (
                  <tr key={c.id}><td className="strong">{c.title}</td><td className="small">{c.counterpartyName}</td><td><Status s={c.status} /></td><td className="num"><D d={c.signedDate} /></td><td className="num"><D d={c.endDate} /></td><td className="small">{c.summary}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
      {tab === 'workforce' && (
        <Card title="Workforce plan" flush sub={`Hiring lead times: plants 45 days, engineering 90 days. Reductions need a 60-day consultation; >300 jobs need the board.`}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Department</th><th className="num">Headcount</th><th className="num">Morale</th><th className="num">Annual cost</th><th>Pipeline</th><th>Hire / reduce</th></tr></thead>
              <tbody>
                {d.departments.map((x: any) => (
                  <tr key={x.id}>
                    <td className="strong">{x.name}<div className="tiny muted">{titleCase(x.kind)}</div></td>
                    <td className="num">{fmtInt(x.headcount)}</td>
                    <td className="num" style={{ color: x.morale < 45 ? 'var(--critical-text)' : undefined }}>{Math.round(x.morale)}</td>
                    <td className="num">{fmtEur(x.headcount * x.annualCostPerHeadCents)}</td>
                    <td className="small">{x.hiring.map((h: any, i: number) => <div key={i}>+{fmtInt(h.count)} by {fmtDate(h.arrivalDate)}</div>)}{x.leaving.map((h: any, i: number) => <div key={i} style={{ color: 'var(--critical-text)' }}>−{fmtInt(h.count)} on {fmtDate(h.date)}</div>)}</td>
                    <td><Workforce dep={x} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="tiny muted" style={{ padding: '6px 14px' }}>Absenteeism and crew requirements per plant are on the Plants tab. The Eon line needs roughly 1,600–1,900 additional operators at Brno to run at full rate.</div>
        </Card>
      )}
    </div>
  );
}
