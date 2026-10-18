import { useState } from 'react';
import { HBarChart } from '../components/charts';
import { Card, D, EntityLink, Est, Loading, Status } from '../components/ui';
import { useGame, useView } from '../ctx';
import { fmtEur, fmtInt, fmtPct } from '../format';

export function PriceEditor({ m }: { m: any }) {
  const { propose } = useGame();
  const [v, setV] = useState(String(Math.round(m.netPriceCents / 100)));
  return (
    <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
      <input type="number" step={100} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 90 }} aria-label={`New net price for ${m.name}`} />
      <button className="btn sm" onClick={() => propose('change_price', { modelId: m.id, netPriceCents: Math.round(Number(v) * 100), reason: 'Pricing decision' })}>Preview</button>
    </div>
  );
}

export function Products() {
  const { data: d, error } = useView<any>('/products');
  const { propose, go } = useGame();
  const [mkt, setMkt] = useState<string>('');
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
                <th>Model</th><th>Status</th><th className="num">Net price</th><th className="num">Material cost</th><th className="num">Contribution / unit</th><th className="num">Margin</th><th className="num">Appeal</th><th className="num">Quality</th><th className="num">CO₂ g/km</th><th>Euro 7</th><th className="num">Demand / mo <span className="tiny">est.</span></th><th className="num">Dealer stock days</th><th>Change net price (€)</th>
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
                  <td>{m.status !== 'discontinued' && <PriceEditor m={m} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        <Card title="Marketing budget">
          <div className="small sub">Brand and product marketing across all models. Response has diminishing returns (utility ∝ ln(spend)).</div>
          <div className="row" style={{ marginTop: 8 }}>
            <input type="number" placeholder="€m per month" value={mkt} onChange={(e) => setMkt(e.target.value)} style={{ width: 140 }} aria-label="Marketing budget in € millions per month" />
            <button className="btn" disabled={!mkt} onClick={() => propose('set_marketing_budget', { monthlyCents: Math.round(Number(mkt) * 1e8), reason: 'Marketing budget decision' })}>Preview change</button>
          </div>
          <hr className="sep" />
          <h3>Start a product programme</h3>
          <div className="list">
            {d.templates.filter((t: any) => ['vehicle_program'].includes(t.key) || ['vela_hybrid_refresh', 'kora_premium', 'compact_ev', 'quality_programme', 'direct_sales'].includes(t.key)).map((t: any) => (
              <div key={t.key} className="list-item" style={{ padding: '8px 0' }}>
                <div style={{ flex: 1 }}>
                  <div className="t">{t.name} <span className="pill">{t.strategy}</span></div>
                  <div className="tiny muted">{fmtEur(t.budgetCents)} · {t.fte} engineers · ~{Math.round(t.durationDays / 30)} months — {t.tradeoffs}</div>
                </div>
                <button className="btn sm" disabled={t.active} onClick={() => propose('start_project', { templateKey: t.key })}>{t.active ? 'Running' : 'Preview'}</button>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
