import { useEffect, type ReactNode } from 'react';
import { fmtDate, titleCase } from '../format';
import { useGame, type Page } from '../ctx';

export function Card({ title, actions, children, flush, className, sub }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; sub?: ReactNode }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {typeof title === 'string' ? <h2>{title}</h2> : title}
            {sub && <div className="small muted">{sub}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'critical' | 'warning' }) {
  return (
    <div className="kpi">
      <div className="l" title={label}>{label}</div>
      <div className="v" style={tone === 'critical' ? { color: 'var(--critical-text)' } : tone === 'good' ? { color: 'var(--good-text)' } : undefined}>{value}</div>
      {hint && <div className="h">{hint}</div>}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: 'info', completed: 'good', resolved: 'good', fulfilled: 'good', committed: 'good', executed: 'good', approved: 'good', agreed: 'good', compliant: 'good', running: 'good', in_production: 'good', operating: 'good', open: 'info', offered: 'info', scheduled: 'info', in_progress: 'info', ramp_up: 'info', investigating: 'info', mitigating: 'info', under_review: 'info',
  delayed: 'warning', pending_confirmation: 'warning', pending_approval: 'warning', due: 'warning', waived: 'warning', proposed: 'warning', blocked: 'critical', breached: 'critical', broken: 'critical', rejected: 'critical', failed: 'critical', invalid: 'critical', overdue: 'critical', cancelled: '', withdrawn: '', expired: '', superseded: '', idle: '', not_ready: '', development: 'info', discontinued: '', pending: '',
  critical: 'critical', high: 'warning', medium: 'warning', low: '', warning: 'warning', notice: 'info', info: '',
  dismissed: 'critical', insolvent: 'critical', not_renewed: 'critical',
};

export function Status({ s, label }: { s: string | null | undefined; label?: string }) {
  if (!s) return <span className="muted">—</span>;
  const tone = STATUS_TONE[s] ?? '';
  return (
    <span className={`pill ${tone}`}>
      {tone && tone !== 'info' && <span className="dot" />}
      {label ?? titleCase(s)}
    </span>
  );
}

export function Est({ children }: { children: ReactNode }) {
  return (
    <span className="pill est" title="Estimate produced by the simulation's forecast — not an actual">
      est. {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Progress({ value, tone }: { value: number; tone?: string }) {
  return (
    <div className="bar" title={`${Math.round(value * 100)}%`}>
      <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: tone }} />
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={value === k} className={`tab ${value === k ? 'active' : ''}`} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={wide ? { width: 'min(960px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function D({ d }: { d: string | null | undefined }) {
  return <span className="num">{d ? fmtDate(d) : '—'}</span>;
}

export function Loading({ error }: { error?: string | null }) {
  return error ? <div className="callout critical">{error}</div> : <div className="empty">Loading…</div>;
}

const ENTITY_PAGE: Record<string, Page> = { project: 'projects', milestone: 'projects', issue: 'projects', model: 'products', segment: 'world', competitor: 'world', competitor_product: 'world', factory: 'operations', line: 'operations', supplier: 'operations', supply: 'operations', department: 'company', character: 'company', debt: 'finance', covenant: 'finance', financing: 'finance', contract: 'inbox', negotiation: 'inbox', commitment: 'inbox', board_proposal: 'inbox', regulation: 'world' };

export function EntityLink({ type, id, children }: { type: string; id: string; children?: ReactNode }) {
  const { go } = useGame();
  const page = ENTITY_PAGE[type];
  if (!page) return <span className="mono">{children ?? id}</span>;
  return (
    <a href="#" onClick={(e) => { e.preventDefault(); go(page, id); }}>
      {children ?? id}
    </a>
  );
}

export function Sev({ s }: { s: string }) {
  return <span className={`sev-bar sev-${s}`} />;
}
