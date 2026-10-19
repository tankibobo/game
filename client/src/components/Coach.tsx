import { useState } from 'react';
import { useGame, useView, type Page } from '../ctx';
import { fmtDate } from '../format';

interface Advice {
  id: string;
  priority: 1 | 2 | 3 | 4;
  area: string;
  title: string;
  why: string;
  steps: string[];
  action?: { type: string; payload: Record<string, unknown>; label: string; rationale?: string };
  link?: { page: Page; param?: string | null; label: string };
  deadline?: string | null;
}

interface Objective {
  id: string;
  label: string;
  weight: number;
  score: number;
  state: 'met' | 'on_track' | 'at_risk' | 'missed';
  detail: string;
  hint: string;
}

interface Report {
  date: string;
  confidence: { now: number; target: number; projectedNextMeeting: number; nextMeeting: string; threshold: number; strikes: number; strikesAllowed: number; drivers: { label: string; delta: number }[] };
  mandate: { score: number; passScore: number; termEnd: string; objectives: Objective[] };
  headline: string;
  advice: Advice[];
  principles: string[];
}

const PRIORITY: Record<number, [string, string]> = { 1: ['Do now', 'critical'], 2: ['Soon', 'warning'], 3: ['When you can', 'info'], 4: ['Optional', ''] };
const STATE: Record<Objective['state'], [string, string]> = { met: ['Met', 'good'], on_track: ['On track', 'info'], at_risk: ['At risk', 'warning'], missed: ['Missed', 'critical'] };

/**
 * The Coach's read of the company: where the board stands, what to look at
 * first and why. The reasoning comes first; the exact steps and a ready-made
 * preview only when the player asks for them ("Show me how").
 */
export function Coach() {
  const { propose, go } = useGame();
  const { data, error, loading } = useView<Report>('/coach');
  const [open, setOpen] = useState<string | null>(null);
  const [how, setHow] = useState<string[]>([]);
  if (error) return <div className="small" style={{ color: 'var(--critical-text)' }}>{error}</div>;
  if (!data) return <div className="small muted">{loading ? 'Analysing your company…' : 'Start or load a game to get advice.'}</div>;
  const c = data.confidence;
  const danger = c.projectedNextMeeting < c.threshold + 5;
  const shown = data.advice.slice(0, 12);
  return (
    <div className="stack coach" style={{ gap: 12 }}>
      <div className={`callout ${danger ? 'critical' : data.advice.some((a) => a.priority === 1) ? '' : 'good'}`}>{data.headline}</div>

      <section>
        <h3 className="coach-h">Board confidence</h3>
        <div className="coach-conf">
          <div><span className="tiny muted">Now</span><strong>{Math.round(c.now)}</strong></div>
          <div><span className="tiny muted">Heading for</span><strong>{Math.round(c.target)}</strong></div>
          <div><span className="tiny muted">After {fmtDate(c.nextMeeting)}</span><strong style={{ color: danger ? 'var(--critical-text)' : undefined }}>≈{Math.round(c.projectedNextMeeting)}</strong></div>
        </div>
        <div className="tiny muted" style={{ marginTop: 4 }}>
          Below {c.threshold} at {c.strikesAllowed} regular board meetings in a row ends your mandate{c.strikes > 0 ? ` — you already have ${c.strikes} strike${c.strikes > 1 ? 's' : ''}` : ''}. At each meeting confidence moves part of the way towards where it is heading; the drivers below decide where that is.
        </div>
        {c.drivers.length > 0 && (
          <ul className="coach-drivers">
            {c.drivers.map((d) => (
              <li key={d.label}><span>{d.label}</span><span className={d.delta < 0 ? 'neg' : 'pos'}>{d.delta > 0 ? '+' : ''}{d.delta.toFixed(0)}</span></li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="coach-h">Where I'd look first</h3>
        {shown.length === 0 && <div className="small muted">Nothing pressing. Advance time and keep an eye on the forecast.</div>}
        <div className="stack" style={{ gap: 8 }}>
          {shown.map((a) => {
            const [label, tone] = PRIORITY[a.priority];
            const expanded = open === a.id || (open === null && a === shown[0]);
            return (
              <div key={a.id} className="coach-card">
                <button className="coach-card-head" onClick={() => setOpen(expanded ? '' : a.id)} aria-expanded={expanded}>
                  <span className={`pill ${tone}`}>{label}</span>
                  <span className="small strong" style={{ flex: 1, textAlign: 'left' }}>{a.title}</span>
                  <span className="tiny muted">{expanded ? '▾' : '▸'}</span>
                </button>
                {expanded && (
                  <div className="coach-card-body">
                    <div className="small">{a.why}</div>
                    {a.deadline && <div className="tiny muted">Deadline: {fmtDate(a.deadline)}</div>}
                    {!how.includes(a.id) ? (
                      <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <button className="btn sm ghost" onClick={() => setHow((x) => [...x, a.id])}>Show me how</button>
                        {a.link && <button className="btn sm" onClick={() => go(a.link!.page, a.link!.param ?? null)}>Open {a.link.label}</button>}
                      </div>
                    ) : (
                      <>
                        {a.steps.length > 0 && <ol className="small">{a.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
                        <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          {a.action && <button className="btn sm primary" onClick={() => propose(a.action!.type, a.action!.payload, { rationale: a.action!.rationale })}>Preview: {a.action.label}</button>}
                          {a.link && <button className="btn sm" onClick={() => go(a.link!.page, a.link!.param ?? null)}>Open {a.link.label}</button>}
                        </div>
                        {a.action && <div className="tiny muted" style={{ marginTop: 4 }}>Nothing happens until you confirm in the preview.</div>}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {data.advice.length > shown.length && <div className="tiny muted" style={{ marginTop: 4 }}>{data.advice.length - shown.length} lower-priority items not shown.</div>}
      </section>

      <section>
        <h3 className="coach-h">Your mandate — final review {fmtDate(data.mandate.termEnd)}</h3>
        <div className="small">Score today <strong>{data.mandate.score}/100</strong> — the board renews you at {data.mandate.passScore} or more.</div>
        <ul className="coach-objs">
          {data.mandate.objectives.map((o) => (
            <li key={o.id} title={o.hint}>
              <div className="row" style={{ gap: 6 }}>
                <span className={`pill ${STATE[o.state][1]}`}>{STATE[o.state][0]}</span>
                <span className="small strong" style={{ flex: 1 }}>{o.label}</span>
                <span className="tiny muted">{Math.round(o.score * o.weight)}/{o.weight}</span>
              </div>
              <div className="tiny muted">{o.detail}</div>
              {o.state !== 'met' && <div className="tiny">{o.hint}</div>}
            </li>
          ))}
        </ul>
      </section>

      <details>
        <summary className="small strong">How to win: principles</summary>
        <ul className="small" style={{ margin: '6px 0 0 18px', padding: 0 }}>{data.principles.map((p, i) => <li key={i} style={{ marginBottom: 4 }}>{p}</li>)}</ul>
      </details>
      <div className="tiny muted">I read the live simulation (forecast, board, negotiations, factories) and update after every decision and every day you advance. I’m not part of the game: nobody at Asterion hears what I say.</div>
    </div>
  );
}
