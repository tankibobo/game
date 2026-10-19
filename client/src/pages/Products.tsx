import { HBarChart } from '../components/charts';
import { Card, D, EntityLink, Est, Loading, Status } from '../components/ui';
import { useGame, useView } from '../ctx';
import { fmtEur, fmtInt, fmtPct } from '../format';
import { DecideLink } from '../components/DecideLink';
import { LiveReport } from './Finance';

export function Products() {
  const { data: d, error } = useView<any>('/products');
  const { go } = useGame();
  if (!d) return <Loading error={error} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>Portfolio economics, pricing and the development roadmap. Demand comes from a segment share model: price, appeal (decays with age), quality, satisfaction, powertrain preference, marketing and distribution.</p>
        </div>
      </div>
      <Card title="Vehicle portfolio" flush>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model</th><th>Status</th><th className="num">Net price</th><th className="num">Material cost</th><th className="num">Contribution / unit</th><th className="num">Margin</th><th className="num">Appeal</th><th className="num">Quality</th><th className="num">CO₂ g/km</th><th>Euro 7</th><th className="num">Demand / mo <span className="tiny">est.</span></th><th className="num">Dealer stock days</th>
              </tr>
            </thead>
            <tbody>
              {d.models.map((m: any) => (
                <tr key={m.id}>
                  <td className="strong" style={{ minWidth: 150, whiteSpace: 'nowrap' }}>{m.name}<div className="tiny muted">{m.powertrain.toUpperCase()} · {m.lifecycle.replace('_', ' ')}{m.launchDate ? ` · since ${m.launchDate.slice(0, 7)}` : ''}</div></td>
                  <td><Status s={m.status} /></td>
                  <td className="num">{fmtEur(m.netPriceCents, { compact: false })}</td>
                  <td className="num">{fmtEur(m.unitMaterialCostCents, { compact: false })}</td>
                  <td className="num">{fmtEur(m.contributionPerUnitCents, { compact: false })}</td>
                  <td className="num">{fmtPct(m.marginPct)}</td>
                  <td className="num">{m.appeal.toFixed(1)}</td>
                  <td className="num">{m.quality}</td>
                  <td className="num">{m.co2Gkm}</td>
                  <td>{m.euro7Compliant ? <span className="pill good">yes</span> : <span className="pill critical">no</span>}</td>
                  <td className="num">{fmtInt(m.demandEstimate)}</td>
                  <td className="num" style={{ color: m.dealerStockDays > 60 ? 'var(--critical-text)' : undefined }}>{m.dealerStockDays ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ padding: '6px 14px 0' }}><DecideLink area="products">Change a price or launch a campaign →</DecideLink></div>
        <div className="tiny muted" style={{ padding: '6px 14px' }}>Net price = revenue per vehicle invoiced to dealers (after dealer margin and VAT). Contribution = net price − materials − logistics − warranty accrual. Labour and overhead are period costs.</div>
      </Card>

      <div className="grid g2" style={{ marginTop: 14 }}>
        {d.segments.map((s: any) => {
          const rows = s.shares.filter((r: any) => r.kind !== 'other').sort((a: any, b: any) => b.share - a.share).map((r: any) => ({ name: r.kind === 'asterion' ? `★ ${r.name}` : r.name, share: Math.round(r.share * 1000) / 10 }));
          const other = s.shares.find((r: any) => r.kind === 'other');
          return (
            <Card key={s.id} title={s.name} sub={<>Market ≈{fmtInt(s.marketMonthly)} units/month <Est>model</Est> · BEV preference {fmtPct(s.powertrainPrefNow.bev, 0)}</>}>
              <HBarChart data={rows} label="name" value="share" unit="%" />
              <div className="tiny muted">Share of segment demand (%). Other brands: {fmtPct(other?.share ?? 0)}. ★ = Asterion.</div>
            </Card>
          );
        })}
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        <Card title="Development roadmap" flush actions={<button className="btn sm" onClick={() => go('projects')}>Projects</button>}>
          <table>
            <thead><tr><th>Programme</th><th>Status</th><th className="num">Target</th><th className="num">Forecast <span className="tiny">est.</span></th></tr></thead>
            <tbody>
              {d.projects.map((p: any) => (
                <tr key={p.id}>
                  <td><EntityLink type="project" id={p.id}>{p.name}</EntityLink></td>
                  <td><Status s={p.status} /></td>
                  <td className="num"><D d={p.targetDate} /></td>
                  <td className="num">{p.status === 'completed' ? 'done' : p.forecastDate ? <D d={p.forecastDate} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Marketing & campaigns" actions={<DecideLink area="products">Decide →</DecideLink>}>
          <div className="small sub">Always-on marketing {fmtEur(d.marketingMonthlyCents)} per month{d.marketingEfficiency > 1.001 ? ` · ${Math.round((d.marketingEfficiency - 1) * 100)}% more effective thanks to completed projects` : ''}. Campaigns lift one model for a few weeks; their extra sales are measured below.</div>
          <LiveReport reportKey="marketing" compact />
        </Card>
      </div>

      <div style={{ marginTop: 14 }} />
      <Card title="What's in the cars" sub="Features and changes on each model — completed projects add to this list." >
        <div className="grid g3">
          {d.models.filter((m: any) => m.status !== 'discontinued').map((m: any) => (
            <div key={m.id}>
              <div className="small strong">{m.name} <Status s={m.status} /></div>
              {(m.features ?? []).length === 0 ? <div className="tiny muted">No listed features.</div> : <ul className="tiny" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{m.features.map((f: string) => <li key={f}>{f}</li>)}</ul>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
