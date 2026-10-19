import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { BarSeriesChart, LineSeriesChart } from '../components/charts';
import { DecideLink } from '../components/DecideLink';
import { Card, D, Empty, Est, Loading, Status, Tabs } from '../components/ui';
import { useGame, useView } from '../ctx';
import { eurM, fmtDate, fmtEur, fmtInt, fmtX, titleCase } from '../format';
import { ReportView } from '../components/ReportView';
import type { Report } from '../../../shared/report';

type Tab = 'money' | 'statements' | 'forecast' | 'debt' | 'financing' | 'wc';

function lastDay(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

function Line({ label, v, cls, indent }: { label: string; v: number; cls?: string; indent?: boolean }) {
  return (
    <tr className={cls}>
      <td className={indent ? 'indent' : ''}>{label}</td>
      <td className="num" style={{ color: v < 0 ? 'var(--critical-text)' : undefined }}>{fmtEur(v, { compact: false })}</td>
    </tr>
  );
}

function Statements({ fin }: { fin: any }) {
  const months = fin.snapshots.filter((s: any) => s.period >= '2027').map((s: any) => s.period);
  const today = fin.today as string;
  const [period, setPeriod] = useState<string>('ytd');
  const [st, setSt] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const year = today.slice(0, 4);
    const prevDay = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const [from, to] = period === 'ytd' ? [`${year}-01-01`, prevDay < `${year}-01-01` ? `${year}-01-01` : prevDay] : period.startsWith('FY') ? [`${period.slice(2)}-01-01`, `${period.slice(2)}-12-31`] : [`${period}-01`, lastDay(period)];
    api.get(`/statements?from=${from}&to=${to}`).then(setSt).catch((e) => setErr(e.message));
  }, [period, today]);
  const years = [...new Set(months.map((m: string) => m.slice(0, 4)))].filter((y) => `${y}-12` <= (months[months.length - 1] ?? ''));
  if (err) return <div className="callout critical">{err}</div>;
  if (!st) return <Loading />;
  const is = st.incomeStatement;
  const cf = st.cashFlow;
  const bs = st.balanceSheet;
  const cfLines = Object.entries(cf.lines as Record<string, number>).sort();
  return (
    <div className="stack">
      <div className="row">
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          Period
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="ytd">Year to date</option>
            {years.map((y) => <option key={String(y)} value={`FY${y}`}>FY{String(y)}</option>)}
            {[...months].reverse().map((m: string) => <option key={m} value={m}>{fmtDate(`${m}-01`, 'month')}</option>)}
          </select>
        </label>
        <span className="small muted">{fmtDate(st.from)} – {fmtDate(st.to)} · computed directly from the general ledger (actuals only)</span>
      </div>
      <div className="grid g3">
        <Card title="Income statement" flush>
          <table>
            <tbody>
              <Line label="Vehicle revenue" v={is.vehicleRevenue} indent />
              <Line label="Parts & aftersales" v={is.aftersalesRevenue} indent />
              <Line label="Revenue" v={is.revenue} cls="subtotal" />
              <Line label="Cost of sales (materials, warranty, logistics)" v={-is.cogs} indent />
              <Line label="Gross profit" v={is.grossProfit} cls="subtotal" />
              <Line label="Personnel" v={-is.personnel} indent />
              <Line label="Other operating expenses" v={-is.otherOpex} indent />
              <Line label="Other operating income" v={is.otherIncome} indent />
              <Line label="EBITDA" v={is.ebitda} cls="subtotal" />
              <Line label="Depreciation, amortisation, impairment" v={-is.da} indent />
              <Line label="Operating profit (EBIT)" v={is.ebit} cls="subtotal" />
              <Line label="Interest & financing fees" v={-is.interest} indent />
              <Line label="Profit before tax" v={is.ebt} />
              <Line label="Income tax" v={-is.tax} indent />
              <Line label="Net income" v={is.netIncome} cls="total" />
            </tbody>
          </table>
          <div className="tiny muted" style={{ padding: '6px 10px' }}>Margin {is.revenue ? `${((is.ebit / is.revenue) * 100).toFixed(1)}%` : '—'} · revenue recognised on delivery to dealers.</div>
        </Card>
        <Card title="Cash-flow statement (direct)" flush>
          <table>
            <tbody>
              {(['operating', 'investing', 'financing'] as const).map((cat) => (
                <Fragment key={cat}>
                  {cfLines.filter(([k]) => k.startsWith(cat)).map(([k, v]) => <Line key={k} label={titleCase(k.split(':')[1])} v={v} indent />)}
                  <Line label={`${titleCase(cat)} cash flow`} v={cf[cat]} cls="subtotal" />
                </Fragment>
              ))}
              <Line label="Net change in cash" v={cf.netChange} cls="total" />
            </tbody>
          </table>
          <div className="tiny" style={{ padding: '6px 10px', color: st.reconciliation.difference === 0 ? 'var(--good-text)' : 'var(--critical-text)' }}>
            Reconciliation: balance-sheet cash change {fmtEur(st.reconciliation.cashChange, { compact: false })} − cash flow = {fmtEur(st.reconciliation.difference, { compact: false })}
          </div>
        </Card>
        <Card title={`Balance sheet at ${fmtDate(st.to)}`} flush>
          <table>
            <tbody>
              <Line label="Cash" v={bs.cash} indent />
              <Line label="Trade receivables" v={bs.receivables} indent />
              <Line label="Inventory" v={bs.inventory} indent />
              <Line label="Supplier prepayments" v={bs.otherCurrentAssets} indent />
              <Line label="Property, plant & equipment (net)" v={bs.ppe} indent />
              <Line label="Capitalised development (net)" v={bs.intangibles} indent />
              <Line label="Total assets" v={bs.totalAssets} cls="subtotal" />
              <Line label="Trade payables" v={bs.payables} indent />
              <Line label="Provisions (warranty, CO₂, restructuring, recall)" v={bs.provisions} indent />
              <Line label="Tax payable & accrued interest" v={bs.taxPayable + bs.accruedInterest} indent />
              <Line label="Borrowings" v={bs.debt + bs.leases} indent />
              <Line label="Total liabilities" v={bs.totalLiabilities} cls="subtotal" />
              <Line label="Share capital & premium" v={bs.shareCapital} indent />
              <Line label="Retained earnings" v={bs.retainedEarnings} indent />
              <Line label="Total equity" v={bs.totalEquity} cls="subtotal" />
            </tbody>
          </table>
          <div className="tiny" style={{ padding: '6px 10px', color: bs.check === 0 ? 'var(--good-text)' : 'var(--critical-text)' }}>Assets − liabilities − equity = {fmtEur(bs.check, { compact: false })}</div>
        </Card>
      </div>
      <Card title="Monthly history" flush>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Month</th><th className="num">Revenue</th><th className="num">EBITDA</th><th className="num">EBIT</th><th className="num">Net income</th><th className="num">Operating CF</th><th className="num">Investing CF</th><th className="num">Financing CF</th><th className="num">Cash</th><th className="num">Built</th><th className="num">Retail</th></tr></thead>
            <tbody>
              {[...fin.snapshots].reverse().map((s: any) => (
                <tr key={s.period}>
                  <td>{fmtDate(`${s.period}-01`, 'month')}{s.period < '2027' && <span className="pill est" style={{ marginLeft: 4 }}>FY26 avg</span>}</td>
                  <td className="num">{fmtEur(s.data.revenueCents)}</td>
                  <td className="num">{fmtEur(s.data.ebitdaCents)}</td>
                  <td className="num">{fmtEur(s.data.ebitCents)}</td>
                  <td className="num">{fmtEur(s.data.netIncomeCents)}</td>
                  <td className="num">{s.period < '2027' ? '—' : fmtEur(s.data.operatingCfCents)}</td>
                  <td className="num">{s.period < '2027' ? '—' : fmtEur(s.data.investingCfCents)}</td>
                  <td className="num">{s.period < '2027' ? '—' : fmtEur(s.data.financingCfCents)}</td>
                  <td className="num">{fmtEur(s.data.cashCents)}</td>
                  <td className="num">{fmtInt(s.data.unitsProduced)}</td>
                  <td className="num">{fmtInt(s.data.unitsRetail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Forecast({ fin }: { fin: any }) {
  const { refresh, toast } = useGame();
  const fc = fin.forecast;
  if (!fc) return <Empty>No forecast available.</Empty>;
  const sc = fc.data.scenarios;
  const rows = sc[0].months.map((m: any, i: number) => ({ month: m.month.slice(2).replace('-', '/'), base: eurM(m.liquidityCents), downside: eurM(sc[1].months[i]?.liquidityCents ?? 0), upside: eurM(sc[2].months[i]?.liquidityCents ?? 0) }));
  const ebit = sc[0].months.map((m: any, i: number) => ({ month: m.month.slice(2).replace('-', '/'), base: eurM(m.ebitCents), downside: eurM(sc[1].months[i]?.ebitCents ?? 0), upside: eurM(sc[2].months[i]?.ebitCents ?? 0) }));
  const series = [{ key: 'base', label: 'Base', color: 'var(--series-1)' }, { key: 'downside', label: 'Downside', color: 'var(--series-2)', dashed: true }, { key: 'upside', label: 'Upside', color: 'var(--series-3)', dashed: true }];
  return (
    <div className="stack">
      <div className="callout info small">
        <strong>Forecasts are estimates.</strong> {fc.data.notes.join(' ')} Generated {fmtDate(fc.createdDate)} (trigger: {fc.trigger}).{' '}
        <button className="btn sm" onClick={() => api.post('/forecast/refresh').then(() => { refresh(); toast('Forecast regenerated.'); })}>Regenerate</button>
      </div>
      <div className="grid g3">
        {sc.map((s: any) => (
          <Card key={s.key} title={s.label} sub={s.assumptions.join(' · ')}>
            <table>
              <tbody>
                <tr><td>FY operating profit</td><td className="num strong">{fmtEur(s.summary.fyEbitCents)}</td></tr>
                <tr><td>FY revenue</td><td className="num">{fmtEur(s.summary.fyRevenueCents)}</td></tr>
                <tr><td>12-month min. liquidity</td><td className="num">{fmtEur(s.summary.minLiquidity12mCents)} <span className="tiny muted">{fmtDate(s.summary.minLiquidity12mDate)}</span></td></tr>
                <tr><td>24-month min. liquidity</td><td className="num">{fmtEur(s.summary.minLiquidityCents)} <span className="tiny muted">{fmtDate(s.summary.minLiquidityDate)}</span></td></tr>
                <tr><td>Peak net leverage</td><td className="num">{fmtX(s.summary.maxLeverage)}</td></tr>
                <tr><td>Eon SOP</td><td className="num">{s.summary.eonSopForecast ? fmtDate(s.summary.eonSopForecast) : `blocked (≈${s.summary.eonSopConditional ? fmtDate(s.summary.eonSopConditional) : 'n/a'} if supply secured)`}</td></tr>
                <tr><td>CO₂ premium (FY)</td><td className="num">{fmtEur(s.summary.co2PenaltyFyCents)}</td></tr>
              </tbody>
            </table>
          </Card>
        ))}
      </div>
      <div className="grid g2">
        <Card title="Liquidity by scenario" sub={<Est>simulation</Est>}><LineSeriesChart data={rows} x="month" unit="€m" series={series} refY={400} refLabel="€400m covenant" /></Card>
        <Card title="Monthly operating profit by scenario" sub={<Est>simulation</Est>}><LineSeriesChart data={ebit} x="month" unit="€m" series={series} /></Card>
      </div>
      <Card title="Base case by month" flush>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Month</th><th className="num">Revenue</th><th className="num">EBITDA</th><th className="num">EBIT</th><th className="num">Net income</th><th className="num">Cash</th><th className="num">Liquidity</th><th className="num">Debt</th><th className="num">Net leverage</th><th className="num">Built</th><th className="num">Retail</th></tr></thead>
            <tbody>
              {sc[0].months.map((m: any) => (
                <tr key={m.month}><td>{fmtDate(`${m.month}-01`, 'month')}</td><td className="num">{fmtEur(m.revenueCents)}</td><td className="num">{fmtEur(m.ebitdaCents)}</td><td className="num">{fmtEur(m.ebitCents)}</td><td className="num">{fmtEur(m.netIncomeCents)}</td><td className="num">{fmtEur(m.cashCents)}</td><td className="num">{fmtEur(m.liquidityCents)}</td><td className="num">{fmtEur(m.debtCents)}</td><td className="num">{fmtX(m.netLeverage)}</td><td className="num">{fmtInt(m.production)}</td><td className="num">{fmtInt(m.retail)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Debt({ fin }: { fin: any }) {
  const { propose } = useGame();
  const [amt, setAmt] = useState('');
  const m = fin.metrics;
  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi"><div className="l">Gross debt</div><div className="v">{fmtEur(m.grossDebtCents)}</div></div>
        <div className="kpi"><div className="l">Net debt</div><div className="v">{fmtEur(m.netDebtCents)}</div></div>
        <div className="kpi"><div className="l">Net leverage (LTM)</div><div className="v">{fmtX(m.netLeverage)}</div><div className="h">covenant ≤ 3.50x</div></div>
        <div className="kpi"><div className="l">Interest cover (LTM)</div><div className="v">{fmtX(m.interestCover)}</div><div className="h">covenant ≥ 3.0x</div></div>
        <div className="kpi"><div className="l">Rating</div><div className="v">{m.rating}</div><div className="h">outlook {m.outlook}</div></div>
        <div className="kpi"><div className="l">Liquidity</div><div className="v">{fmtEur(m.liquidityCents)}</div></div>
      </div>
      <Card title="Debt instruments" flush>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Instrument</th><th>Lender</th><th className="num">Outstanding</th><th className="num">Limit</th><th className="num">Rate</th><th className="num">Maturity</th><th>Scheduled repayments</th><th className="num">Accrued interest</th><th>Status</th></tr></thead>
            <tbody>
              {fin.debts.map((x: any) => (
                <tr key={x.id}>
                  <td className="strong">{x.name}<div className="tiny muted">{x.conditions.join(' · ')}</div></td>
                  <td className="small">{x.lender}</td>
                  <td className="num">{fmtEur(x.principalCents)}</td>
                  <td className="num">{fmtEur(x.limitCents)}</td>
                  <td className="num">{(x.rateBps / 100).toFixed(2)}%</td>
                  <td className="num"><D d={x.maturityDate} /></td>
                  <td className="small">{x.amortization.filter((a: any) => a.date >= fin.today).slice(0, 3).map((a: any) => `${fmtEur(a.amountCents)} ${fmtDate(a.date)}`).join(' · ') || 'bullet'}</td>
                  <td className="num">{fmtEur(x.interestPayableCents)}</td>
                  <td><Status s={x.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="grid g2">
        <Card title="Covenants" flush sub="Tested at each quarter end on last-twelve-month figures (pre-game months use the FY2026 baseline).">
          <table>
            <thead><tr><th>Covenant</th><th className="num">Limit</th><th className="num">Last test</th><th>Status</th></tr></thead>
            <tbody>
              {fin.covenants.map((c: any) => (
                <tr key={c.id}>
                  <td className="strong">{c.name}<div className="tiny muted">{c.description}</div></td>
                  <td className="num">{c.metric === 'min_liquidity' ? fmtEur(c.threshold) : `${c.comparator === 'max' ? '≤' : '≥'} ${c.threshold.toFixed(2)}x`}</td>
                  <td className="num">{c.lastValue === null ? 'not yet tested' : c.metric === 'min_liquidity' ? fmtEur(c.lastValue) : `${c.lastValue.toFixed(2)}x`}<div className="tiny muted">{c.lastTestDate ? fmtDate(c.lastTestDate) : ''}</div></td>
                  <td><Status s={c.status} />{c.waiverUntil && <div className="tiny muted">waived to {fmtDate(c.waiverUntil)}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Revolving credit facility" sub="The treasury draws automatically to meet payments and sweeps surplus cash back at month end. You can also draw or repay manually.">
          <div className="small">Drawn {fmtEur(fin.rcf?.drawnCents ?? 0)}.</div>
          <div style={{ marginTop: 8 }}><DecideLink area="money">Draw or repay →</DecideLink></div>
        </Card>
      </div>
    </div>
  );
}

const KINDS: [string, string, string][] = [
  ['bank_term_loan', 'Bank term loan', 'Banque Continentale credit committee, ~21 days. Limited by EBITDA and leverage.'],
  ['bond', 'Senior bond', 'Board resolution, then bookbuilding ~30 days. Coupon depends on rating and markets.'],
  ['rights_issue', 'Rights issue', 'Board + EGM, ~45 days, 25% discount; dilutes shareholders.'],
  ['shareholder_loan', 'Shareholder loan (Halvorsen)', 'Related party; depends on the family’s trust in you. Max €150m.'],
  ['sale_leaseback', 'HQ sale-and-leaseback', 'One-off asset sale (~€150–200m), then 15-year lease.'],
  ['covenant_waiver', 'Covenant waiver', 'Only when a covenant is breached or close; fee + margin step-up.'],
  ['rcf_extension', 'Extend the credit line (RCF)', 'Banks extend the €500m revolving facility by 3 years (~21 days, fee). Possible in its last two years; not while a covenant is breached. Amount: 0.'],
  ['ceo_contribution', 'Personal investment (CEO)', 'Subscription for new shares at market price; needs verified personal funds.'],
];

function Financing({ fin }: { fin: any }) {
  const { propose } = useGame();
  const [kind, setKind] = useState('bank_term_loan');
  const [amount, setAmount] = useState('300');
  const [tenor, setTenor] = useState('5');
  const [why, setWhy] = useState('');
  return (
    <div className="stack">
      <Card title="Raising money" sub="A request is a proposal. Money arrives only after the counterparty makes an offer, you accept it, and it is executed.">
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{KINDS.map(([k, l, h]) => <li key={k}><strong>{l}</strong> — {h}</li>)}</ul>
        <div className="small muted" style={{ margin: '6px 0' }}>Your verified personal liquid assets: {fmtEur(fin.ceo.personalLiquidCents)}.</div>
        <DecideLink area="money">Request financing or answer an offer →</DecideLink>
      </Card>
      <Card title="Requests & offers" flush>
        {fin.financing.length === 0 ? <Empty>No financing requests yet.</Empty> : (
          <table>
            <thead><tr><th>Request</th><th>Counterparty</th><th className="num">Requested</th><th>Status</th><th>Offer / decision</th><th></th></tr></thead>
            <tbody>
              {[...fin.financing].reverse().map((f: any) => (
                <tr key={f.id}>
                  <td className="strong">{titleCase(f.kind)}<div className="tiny muted">{f.id} · submitted {fmtDate(f.submittedDate)}{f.decisionDate ? ` · decision ${fmtDate(f.decisionDate)}` : ''}</div></td>
                  <td className="small">{f.counterparty}</td>
                  <td className="num">{fmtEur(f.requestedCents)}</td>
                  <td><Status s={f.status} /></td>
                  <td className="small">
                    {f.offer && <div><strong>{fmtEur(f.offer.amountCents)}</strong>{f.offer.rateBps ? ` at ${(f.offer.rateBps / 100).toFixed(2)}%` : ''}, fees {fmtEur(f.offer.feesCents)}, valid to {fmtDate(f.offer.validUntil)}<div className="tiny muted">{f.offer.conditions.join(' · ')}</div></div>}
                    {f.decisionReason && <div className="tiny">{f.decisionReason}</div>}
                  </td>
                  <td>
                    {f.status === 'offered' && <DecideLink area="money">Answer →</DecideLink>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function WorkingCapital({ fin }: { fin: any }) {
  const wc = fin.workingCapital;
  const snaps = fin.snapshots.filter((s: any) => s.period >= '2027');
  return (
    <div className="stack">
      <div className="grid g2">
        <Card title="Working capital" flush>
          <table>
            <tbody>
              <tr><td>Trade receivables (dealers, 30 days)</td><td className="num">{fmtEur(wc.receivables.amt)}</td><td className="small muted">{wc.receivables.n} invoices</td></tr>
              <tr><td>Finished-vehicle inventory</td><td className="num">{fmtEur(wc.inventoryCents)}</td><td></td></tr>
              {wc.payables.map((p: any) => <tr key={p.category}><td>Payables — {p.category}</td><td className="num">{fmtEur(p.amt)}</td><td className="small muted">next due {fmtDate(p.next_due)}</td></tr>)}
              <tr className="total"><td>Overdue payables</td><td className="num" style={{ color: wc.overdue > 0 ? 'var(--critical-text)' : undefined }}>{fmtEur(wc.overdue)}</td><td className="small muted">{wc.overdue > 0 ? '10 days of material arrears → insolvency' : 'none'}</td></tr>
            </tbody>
          </table>
        </Card>
        <Card title="Budgets & plan">
          <table>
            <tbody>
              <tr><td>Marketing</td><td className="num">{fmtEur(fin.budget.marketingMonthlyCents)} / month</td></tr>
              <tr><td>General & administrative</td><td className="num">{fmtEur(fin.budget.gaMonthlyCents)} / month</td></tr>
              <tr><td>Sustaining capex</td><td className="num">{fmtEur(fin.budget.sustainingCapexMonthlyCents)} / month</td></tr>
              <tr><td>Board plan FY{fin.budget.plan.fiscalYear}: operating profit</td><td className="num">{fmtEur(fin.budget.plan.ebitTargetCents)}</td></tr>
              <tr><td>Board plan: minimum liquidity</td><td className="num">{fmtEur(fin.budget.plan.minLiquidityCents)}</td></tr>
              <tr><td>Board plan: Eon SOP</td><td className="num">{fmtDate(fin.budget.plan.eonSopDate)}</td></tr>
              <tr><td>Tax-loss carry-forward</td><td className="num">{fmtEur(fin.metrics.taxLossCarryforwardCents)}</td></tr>
              <tr><td>Shares outstanding</td><td className="num">{fmtInt(fin.metrics.sharesOutstanding)}</td></tr>
            </tbody>
          </table>
        </Card>
      </div>
      {snaps.length > 0 && <Card title="Monthly cash flow (actual)"><BarSeriesChart data={snaps.map((s: any) => ({ month: s.period.slice(2).replace('-', '/'), ocf: eurM(s.data.operatingCfCents) }))} x="month" unit="€m" series={[{ key: 'ocf', label: 'Operating cash flow', color: 'var(--series-1)' }]} /></Card>}
    </div>
  );
}

/** One report fetched live from the report catalogue. */
export function LiveReport({ reportKey, param, compact }: { reportKey: string; param?: string; compact?: boolean }) {
  const { data, error } = useView<Report>(`/reports/${reportKey}${param ? `?param=${encodeURIComponent(param)}` : ''}`);
  if (error) return <div className="small muted">{error}</div>;
  if (!data) return <Loading />;
  return <ReportView report={data} compact={compact} />;
}

function WhereMoneyGoes() {
  const { openAsk } = useGame();
  return (
    <div className="stack">
      <div className="callout small">Everything below is computed from the books and the plants as of today. To discuss it, <a href="#" onClick={(e) => { e.preventDefault(); openAsk('CHR-HOLM', 'Why are we making (or losing) money, and what would change it most?'); }}>ask the CFO</a>.</div>
      <Card><LiveReport reportKey="pnl" /></Card>
      <div className="grid g2">
        <Card><LiveReport reportKey="unit_economics" compact /></Card>
        <Card><LiveReport reportKey="cash" compact /></Card>
      </div>
    </div>
  );
}

export function Finance() {
  const { data: fin, error } = useView<any>('/finance');
  const { nav } = useGame();
  const [tab, setTab] = useState<Tab>('money');
  useEffect(() => {
    if (nav.param === 'forecast') setTab('forecast');
    else if (nav.param === 'statements') setTab('statements');
    else if (nav.param?.startsWith('FIN')) setTab('financing');
    else if (nav.param?.startsWith('DEBT') || nav.param?.startsWith('COV')) setTab('debt');
  }, [nav.param]);
  if (!fin) return <Loading error={error} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Finance</h1>
          <p>Double-entry ledger in euro cents. Statements are computed from the journal; forecasts are simulation estimates and are labelled as such.</p>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[['money', 'Where the money goes'], ['statements', 'Statements'], ['forecast', 'Forecast & scenarios'], ['debt', 'Debt & covenants'], ['financing', 'Financing'], ['wc', 'Working capital & budget']]} />
      {tab === 'money' && <WhereMoneyGoes />}
      {tab === 'statements' && <Statements fin={fin} />}
      {tab === 'forecast' && <Forecast fin={fin} />}
      {tab === 'debt' && <Debt fin={fin} />}
      {tab === 'financing' && <Financing fin={fin} />}
      {tab === 'wc' && <WorkingCapital fin={fin} />}
    </div>
  );
}
