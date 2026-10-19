import type { Report, ReportBlock } from '../../../shared/report';
import { BarSeriesChart, LineSeriesChart, SERIES, WaterfallChart } from './charts';
import { fmtDate } from '../format';

const TONE_ICON: Record<string, string> = { good: '▲', warning: '!', critical: '▼' };

/** The numbers behind a chart, for readers who prefer (or need) a table. */
function DataTable({ b }: { b: Extract<ReportBlock, { kind: 'chart' }> }) {
  return (
    <details className="report-data">
      <summary className="tiny">Show the numbers</summary>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{b.x === 'month' ? 'Month' : ''}</th>{b.series.map((s) => <th key={s.key} className="num">{s.label}</th>)}</tr></thead>
          <tbody>{b.data.map((row, i) => <tr key={i}><td>{row[b.x]}</td>{b.series.map((s) => <td key={s.key} className="num">{typeof row[s.key] === 'number' ? `${b.unit === '€m' ? '€' : ''}${(row[s.key] as number).toLocaleString('en-GB', { maximumFractionDigits: 1 })}${b.unit === '€m' ? 'm' : ''}` : row[s.key]}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

function Block({ b }: { b: ReportBlock }) {
  switch (b.kind) {
    case 'kpis':
      return (
        <div className="report-kpis">
          {b.items.map((k, i) => (
            <div key={i} className="report-kpi">
              <div className="tiny muted">{k.label}</div>
              <div className="strong" style={{ color: k.tone === 'critical' ? 'var(--critical-text)' : k.tone === 'warning' ? 'var(--warning-text)' : k.tone === 'good' ? 'var(--good-text)' : undefined }}>{k.tone ? `${TONE_ICON[k.tone]} ` : ''}{k.value}</div>
              {k.hint && <div className="tiny muted">{k.hint}</div>}
            </div>
          ))}
        </div>
      );
    case 'table':
      return (
        <div>
          {b.title && <div className="small strong" style={{ marginBottom: 4 }}>{b.title}</div>}
          <div className="table-wrap">
            <table>
              <thead><tr>{b.columns.map((c, i) => <th key={i} className={b.numeric?.[i] ? 'num' : undefined}>{c}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={b.numeric?.[j] ? 'num' : j === 0 ? 'strong' : 'small'}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {b.note && <div className="tiny muted" style={{ marginTop: 4 }}>{b.note}</div>}
        </div>
      );
    case 'chart': {
      const series = b.series.slice(0, 3).map((s, i) => ({ key: s.key, label: s.label, color: SERIES[i], dashed: b.chart === 'line' && i > 0 && b.series.length > 2 }));
      const unit = b.unit === 'units' ? '' : b.unit;
      return (
        <div>
          <div className="small strong">{b.title}</div>
          {b.chart === 'line' ? <LineSeriesChart data={b.data} x={b.x} series={series} unit={unit} refY={b.refY} refLabel={b.refLabel} /> : <BarSeriesChart data={b.data} x={b.x} series={series} unit={unit} stacked={b.chart === 'stacked'} />}
          {b.note && <div className="tiny muted">{b.note}</div>}
          <DataTable b={b} />
        </div>
      );
    }
    case 'waterfall':
      return (
        <div>
          <div className="small strong">{b.title}</div>
          <WaterfallChart steps={b.steps} unit={b.unit} />
          {b.note && <div className="tiny muted">{b.note}</div>}
          <details className="report-data">
            <summary className="tiny">Show the numbers</summary>
            <table><tbody>{b.steps.map((s, i) => <tr key={i}><td className={s.total ? 'strong' : undefined}>{s.label}</td><td className="num">{s.value > 0 && !s.total ? '+' : ''}€{s.value.toLocaleString('en-GB', { maximumFractionDigits: 1 })}m</td></tr>)}</tbody></table>
          </details>
        </div>
      );
    case 'bullets':
      return (
        <div>
          {b.title && <div className="small strong" style={{ marginBottom: 4 }}>{b.title}</div>}
          <ul className="report-bullets">
            {b.items.map((it, i) => <li key={i} className={it.tone ? `tone-${it.tone}` : undefined}><span aria-hidden="true">{it.tone ? TONE_ICON[it.tone] : '•'}</span><span>{it.text}</span></li>)}
          </ul>
        </div>
      );
    case 'text':
      return <div className="small">{b.text}</div>;
  }
}

/** A report: headline, then figures, tables and charts. */
export function ReportView({ report, compact, author }: { report: Report; compact?: boolean; author?: string }) {
  return (
    <div className={`report ${compact ? 'compact' : ''}`}>
      <div className="report-head">
        <div className="strong">{report.title}</div>
        <div className="tiny muted">As of {fmtDate(report.date)}{author ? ` · prepared by ${author}` : ''}</div>
      </div>
      <div className="small report-summary">{report.summary}</div>
      <div className="stack" style={{ gap: 12 }}>
        {report.blocks.map((b, i) => <Block key={i} b={b} />)}
      </div>
    </div>
  );
}

/** A document (one or more reports and/or a memo) as received. */
export function DocumentView({ doc, people }: { doc: any; people?: { id: string; name: string }[] }) {
  const name = (id: string) => (id === 'ceo' ? 'you' : people?.find((p) => p.id === id)?.name ?? id);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="tiny muted">{fmtDate(doc.date)} · from {name(doc.senderId)} to {doc.recipients.map(name).join(', ')}</div>
      {doc.note && <div className="callout small">{doc.note}</div>}
      {(doc.reports ?? []).length ? doc.reports.map((r: Report, i: number) => <ReportView key={i} report={r} />) : !doc.note && <div className="pre small">{doc.body}</div>}
    </div>
  );
}
