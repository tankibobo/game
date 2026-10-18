import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const axis = { stroke: 'var(--axis)', tick: { fill: 'var(--muted)', fontSize: 11 }, tickLine: false };

export interface Series {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
}

function TT({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tt">
      <div className="strong" style={{ marginBottom: 2 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="row" style={{ gap: 6 }}>
          <i style={{ width: 10, height: 3, background: p.color, display: 'inline-block', borderRadius: 2 }} />
          <span className="sub">{p.name}</span>
          <span className="num strong" style={{ marginLeft: 'auto' }}>
            {typeof p.value === 'number' ? `${unit === '€m' ? '€' : ''}${p.value.toLocaleString('en-GB', { maximumFractionDigits: 1 })}${unit === '€m' ? 'm' : unit ? ` ${unit}` : ''}` : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.key}>
          <i style={{ background: s.color, opacity: s.dashed ? 0.7 : 1 }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function LineSeriesChart({ data, x, series, unit, refY, refLabel, tall }: { data: any[]; x: string; series: Series[]; unit?: string; refY?: number; refLabel?: string; tall?: boolean }) {
  return (
    <div>
      <Legend series={series} />
      <div className={`chart ${tall ? 'tall' : ''}`}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey={x} {...axis} />
            <YAxis {...axis} width={56} tickFormatter={(v) => (unit === '€m' ? `€${Math.round(v).toLocaleString('en-GB')}m` : Math.round(v).toLocaleString('en-GB'))} />
            <Tooltip content={<TT unit={unit} />} cursor={{ stroke: 'var(--axis)' }} />
            {refY !== undefined && <ReferenceLine y={refY} stroke="var(--critical)" strokeWidth={1} label={{ value: refLabel, position: 'insideTopLeft', fill: 'var(--critical-text)', fontSize: 11 }} />}
            {series.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function BarSeriesChart({ data, x, series, unit, tall }: { data: any[]; x: string; series: Series[]; unit?: string; tall?: boolean }) {
  return (
    <div>
      <Legend series={series} />
      <div className={`chart ${tall ? 'tall' : ''}`}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={2}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey={x} {...axis} />
            <YAxis {...axis} width={56} tickFormatter={(v) => (unit === '€m' ? `€${Math.round(v).toLocaleString('en-GB')}m` : Math.round(v).toLocaleString('en-GB'))} />
            <Tooltip content={<TT unit={unit} />} cursor={{ fill: 'var(--surface-2)' }} />
            <ReferenceLine y={0} stroke="var(--axis)" />
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function HBarChart({ data, label, value, unit }: { data: any[]; label: string; value: string; unit?: string }) {
  return (
    <div className="chart" style={{ height: Math.max(120, data.length * 26 + 20) }}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" horizontal={false} />
          <XAxis type="number" {...axis} tickFormatter={(v) => (unit === '%' ? `${Math.round(v)}%` : String(v))} />
          <YAxis type="category" dataKey={label} {...axis} width={170} />
          <Tooltip content={<TT unit={unit} />} cursor={{ fill: 'var(--surface-2)' }} />
          <Bar dataKey={value} name="Share" fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
