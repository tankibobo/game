import { useState } from 'react';
import { Card, D, Est, Loading, Status, Tabs } from '../components/ui';
import { useView } from '../ctx';
import { fmtDate, fmtEur, fmtInt, fmtPct, titleCase } from '../format';

export function World() {
  const { data: d, error } = useView<any>('/world');
  const [tab, setTab] = useState<'market' | 'competitors' | 'regulation' | 'events'>('market');
  if (!d) return <Loading error={error} />;
  const m = d.macro;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>World</h1>
          <p>Markets, competitors, macro conditions and regulation — and the documented catalogue of events the simulation can trigger.</p>
        </div>
      </div>
      <div className="kpis">
        <div className="kpi"><div className="l">GDP growth (EU)</div><div className="v">{m.gdpGrowthPct.toFixed(1)}%</div></div>
        <div className="kpi"><div className="l">Consumer confidence</div><div className="v">{m.consumerConfidence.toFixed(1)}</div><div className="h">100 = neutral</div></div>
        <div className="kpi"><div className="l">ECB rate</div><div className="v">{m.ecbRatePct.toFixed(2)}%</div></div>
        <div className="kpi"><div className="l">Energy index</div><div className="v">{m.energyIndex.toFixed(2)}</div><div className="h">1.00 = baseline</div></div>
        <div className="kpi"><div className="l">BB credit spread</div><div className="v">{Math.round(m.creditSpreadBps)} bp</div></div>
        <div className="kpi"><div className="l">Fleet CO₂ YTD</div><div className="v" style={{ color: d.fleetCo2 > d.co2Target ? 'var(--critical-text)' : undefined }}>{d.fleetCo2 ? d.fleetCo2.toFixed(1) : '—'} g</div><div className="h">target {d.co2Target} g/km</div></div>
      </div>
      {m.shocks.length > 0 && (
        <div className="callout warning" style={{ marginBottom: 14 }}>
          Active shocks: {m.shocks.map((s: any) => `${s.label} until ${fmtDate(s.until)}`).join(' · ')}
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[['market', 'Markets'], ['competitors', 'Competitors'], ['regulation', 'Regulation & developments'], ['events', 'Event catalogue']]} />
      {tab === 'market' && (
        <div className="grid g2">
          {d.segments.map((s: any) => (
            <Card key={s.id} title={s.name} sub={<>{s.description} · ≈{fmtInt(s.marketMonthly)} units/month <Est>model</Est></>} flush>
              <div className="row small" style={{ padding: '8px 14px', gap: 14 }}>
                {Object.entries(s.pref).map(([k, v]: any) => <span key={k}>{k.toUpperCase()} <strong>{fmtPct(v, 0)}</strong></span>)}
                <span className="muted">powertrain preference</span>
              </div>
              <table>
                <thead><tr><th>Product</th><th>Powertrain</th><th className="num">Net price</th><th className="num">Share</th><th className="num">Units / month</th></tr></thead>
                <tbody>
                  {[...s.shares].sort((a: any, b: any) => b.share - a.share).map((r: any) => (
                    <tr key={r.id} style={r.kind === 'asterion' ? { background: 'var(--accent-soft)' } : undefined}>
                      <td className={r.kind === 'asterion' ? 'strong' : ''}>{r.name}</td>
                      <td>{r.powertrain?.toUpperCase() ?? '—'}</td>
                      <td className="num">{r.priceCents ? fmtEur(r.priceCents, { compact: false }) : '—'}</td>
                      <td className="num">{fmtPct(r.share)}</td>
                      <td className="num">{fmtInt(r.monthlyUnits)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
      {tab === 'competitors' && (
        <div className="grid g2">
          {d.competitors.map((c: any) => (
            <Card key={c.id} title={c.name} sub={`${c.origin} · ${c.strategy}`}>
              <div className="small" style={{ marginBottom: 6 }}>{c.description}</div>
              <div className="row small" style={{ marginBottom: 8 }}>
                <span className="pill">financial health {c.financialHealth}</span>
                <span className="pill">EV capability {c.evCapability}</span>
                <span className="pill">price aggressiveness {Math.round(c.aggressiveness * 100)}%</span>
              </div>
              <table>
                <thead><tr><th>Product</th><th>Status</th><th className="num">Net price</th><th className="num">Appeal</th><th className="num">Quality</th><th className="num">Launch</th></tr></thead>
                <tbody>
                  {c.products.map((p: any) => (
                    <tr key={p.id}>
                      <td>{p.name} <span className="tiny muted">{p.powertrain.toUpperCase()}</span></td>
                      <td><Status s={p.status === 'on_sale' ? 'active' : p.status} label={p.status === 'on_sale' ? 'on sale' : `${titleCase(p.status)} ${Math.round(p.devProgress * 100)}%`} /></td>
                      <td className="num">{fmtEur(p.priceCents, { compact: false })}</td>
                      <td className="num">{p.appeal}</td>
                      <td className="num">{p.quality}</td>
                      <td className="num"><D d={p.launchDate} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
      {tab === 'regulation' && (
        <Card title="Regulation & scheduled developments" flush>
          <table>
            <thead><tr><th>Regulation</th><th>Jurisdiction</th><th>Status</th><th className="num">Effective</th><th>Description</th></tr></thead>
            <tbody>
              {d.regulations.map((r: any) => (
                <tr key={r.id}><td className="strong">{r.name}</td><td>{r.jurisdiction}</td><td><Status s={r.status === 'in_force' ? 'active' : r.status === 'expired' ? 'expired' : 'scheduled'} label={titleCase(r.status)} /></td><td className="num"><D d={r.effectiveDate} /></td><td className="small">{r.description}{r.kind === 'co2_fleet' && <div className="tiny muted">Targets: 2027 {r.params.target2027} · 2028 {r.params.target2028} · 2029 {r.params.target2029} · 2030 {r.params.target2030} g/km</div>}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {tab === 'events' && (
        <Card title="Event catalogue" sub="Every event has explicit preconditions, a classification, a cooldown and engine-computed consequences. Random shocks have bounded probabilities and magnitudes." flush>
          <table>
            <thead><tr><th>Event</th><th>Type</th><th>Checked</th><th>Preconditions</th><th>Magnitude</th><th className="num">Cooldown</th></tr></thead>
            <tbody>
              {d.eventCatalogue.map((e: any) => (
                <tr key={e.key}><td className="strong">{e.label}<div className="tiny muted mono">{e.key}</div></td><td><span className={`pill ${e.kind === 'random_shock' ? 'warning' : e.kind === 'scheduled' ? 'info' : ''}`}>{titleCase(e.kind)}</span></td><td className="small">{e.frequency}</td><td className="small">{e.preconditions.join('; ')}</td><td className="small">{e.magnitude}</td><td className="num small">{e.cooldownDays ? `${e.cooldownDays} d` : '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
