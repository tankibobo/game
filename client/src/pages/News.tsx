import { useState } from 'react';
import { LineSeriesChart, SERIES } from '../components/charts';
import { Card, Empty, Loading } from '../components/ui';
import { useView } from '../ctx';
import { fmtDate, fmtEur, fmtPct } from '../format';

const SECTION: Record<string, string> = { asterion: 'Asterion', industry: 'Industry & competitors', markets: 'Markets & policy' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

function Article({ a, lead }: { a: any; lead?: boolean }) {
  return (
    <article className={`news-item ${lead ? 'news-lead' : ''} news-${a.severity}`}>
      <div className="tiny muted">{fmtDate(a.date)}</div>
      <h3 className="news-headline">{a.headline}</h3>
      <p className="small" style={{ margin: '2px 0 0' }}>{a.lede}</p>
      {a.impact.length > 0 && (
        <div className="news-impact tiny">
          <strong>What it means for Asterion:</strong> {a.impact.join(' ')}
        </div>
      )}
    </article>
  );
}

/** The trade press: the month's events as a newspaper, with the competitive landscape. */
export function News() {
  const { data: d, error } = useView<any>('/news?months=6');
  const [picked, setI] = useState<number | null>(null);
  if (!d) return <Loading error={error} />;
  // Open on the latest edition with real content (the current month may only have just begun).
  const count = (e: any) => e.sections.reduce((a: number, s: any) => a + s.items.length, 0);
  const i = picked ?? (d.editions.length > 1 && count(d.editions[0]) <= 1 ? 1 : 0);
  const ed = d.editions[Math.min(i, Math.max(0, d.editions.length - 1))];
  const lead = ed?.sections.flatMap((s: any) => s.items).find((x: any) => x.id === ed.lead);
  const series = [{ key: 'price', label: 'Share price (€)', color: SERIES[0] }];
  const prices = d.priceHistory.map((p: any) => ({ month: p.period, price: Math.round(p.sharePriceCents) / 100 }));
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>The Automotive Courier</h1>
          <p>The trade press reports what happens to Asterion, its competitors and the markets. Every story is something that really happened in the simulation; “What it means for Asterion” spells out the effect on us.</p>
        </div>
      </div>
      <div className="grid g-main">
        <div className="stack">
          {d.editions.length === 0 ? <Card><Empty>No news yet — advance time.</Empty></Card> : (
            <>
              <div className="row" role="tablist" aria-label="Editions">
                {d.editions.map((e: any, k: number) => (
                  <button key={e.month} role="tab" aria-selected={k === i} className={`btn sm ${k === i ? 'primary' : 'ghost'}`} onClick={() => setI(k)}>{monthName(e.month)}</button>
                ))}
              </div>
              <Card title={`${monthName(ed.month)} edition`}>
                {lead && <Article a={lead} lead />}
                {ed.sections.map((s: any) => {
                  const xs = s.items.filter((x: any) => x.id !== ed.lead);
                  if (!xs.length) return null;
                  return (
                    <section key={s.section} className="news-section">
                      <h2 className="news-section-title">{SECTION[s.section]}</h2>
                      <div className="news-cols">{xs.map((a: any) => <Article key={a.id} a={a} />)}</div>
                    </section>
                  );
                })}
              </Card>
            </>
          )}
        </div>
        <div className="stack">
          <Card title="Asterion shares" sub={`Now €${(d.sharePriceCents / 100).toFixed(2)}. Moves with results, liquidity, the Eon and the board’s confidence; a rights issue is priced off it.`}>
            {prices.length > 1 ? <LineSeriesChart data={prices} x="month" series={series} unit="€" fitY /> : <div className="small muted">The price history starts at the first month end.</div>}
          </Card>
          <Card title="Our share of each segment" flush>
            <table>
              <tbody>{d.shares.map((s: any) => <tr key={s.segment}><td className="small">{s.segment}</td><td className="num strong">{fmtPct(s.ours)}</td></tr>)}</tbody>
            </table>
          </Card>
          <Card title="Competitors" flush sub="Promotions take share from us while they last; recalls and failures give it back.">
            <div className="list">
              {d.competitors.map((c: any) => (
                <div key={c.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div className="small strong">{c.name} {c.status !== 'normal' && <span className={`pill ${c.status.includes('promotion') || c.status.includes('distress') ? 'warning' : 'good'}`}>{c.status}</span>}</div>
                    <div className="tiny muted">{c.strategy}</div>
                    {c.products.length > 0 && <div className="tiny">{c.products.map((p: any) => `${p.name} (${p.segment}) ${p.status === 'withdrawn' ? 'withdrawn' : fmtEur(p.priceCents, { compact: false })}`).join(' · ')}</div>}
                  </div>
                  <span className="tiny muted" title="Financial health (0–100)">health {Math.round(c.financialHealth)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
