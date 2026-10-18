import { useState } from 'react';
import { api } from '../api';
import { fmtEur, titleCase } from '../format';
import { useGame } from '../ctx';
import { Modal, Status } from './ui';

export interface ActionRecord {
  id: string;
  type: string;
  actorId: string;
  source: string;
  payload: Record<string, unknown>;
  status: string;
  summary: string;
  errors: string[];
  warnings: string[];
  consequences: { label: string; amountCents?: number; timing?: string; kind: string }[];
  approvals: { approver: string; kind: string; status: string; ref: string | null; note: string | null }[];
  result: Record<string, unknown> | null;
  rationale: string | null;
  simDate: string;
  needsBoard?: boolean;
  nextStep?: string;
  meetingDate?: string | null;
  boardOutlook?: Outlook | null;
}

export interface Outlook {
  outlook: 'likely_approve' | 'too_close' | 'likely_reject';
  forCount: number;
  againstCount: number;
  leaningCount: number;
  members: { memberId: string; name: string; lean: 'for' | 'against' | 'undecided'; score: number; reason: string }[];
  tips: string[];
}

const KIND_ICON: Record<string, string> = { cash: '€', pnl: 'P&L', operational: 'OPS', people: 'PPL', risk: '⚠', approval: '✓?', info: 'i' };
const OUTLOOK_LABEL: Record<Outlook['outlook'], [string, string]> = { likely_approve: ['Likely to be approved', 'good'], too_close: ['Too close to call', 'warning'], likely_reject: ['Likely to be rejected', 'critical'] };
/** Fields computed by the server; never edited by the player. */
const SERVER_FIELDS = new Set(['packageAnalysis', 'packageItems', 'argumentQuality']);

export function ConsequenceList({ a }: { a: ActionRecord }) {
  return (
    <table>
      <tbody>
        {a.consequences.map((c, i) => (
          <tr key={i}>
            <td style={{ width: 44 }}>
              <span className={`pill ${c.kind === 'risk' ? 'warning' : c.kind === 'approval' ? 'info' : ''}`}>{KIND_ICON[c.kind] ?? c.kind}</span>
            </td>
            <td>
              {c.label}
              {c.timing && <span className="muted small"> · {c.timing}</span>}
            </td>
            <td className="num strong" style={{ color: c.amountCents === undefined ? undefined : c.amountCents < 0 ? 'var(--critical-text)' : 'var(--good-text)' }}>
              {c.amountCents !== undefined ? fmtEur(c.amountCents, { sign: true }) : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The board's likely vote, director by director, with what would change their minds. */
export function BoardOutlook({ o, compact }: { o: Outlook; compact?: boolean }) {
  const [label, tone] = OUTLOOK_LABEL[o.outlook];
  const head = (
    <span className="small" style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <span className={`pill ${tone}`}>{label}</span>
      <span className="muted">{o.forCount} for · {o.againstCount} against · {o.leaningCount} undecided (estimate; trust and events can still move votes)</span>
    </span>
  );
  const body = (
    <>
      <table>
        <tbody>
          {o.members.map((m) => (
            <tr key={m.memberId}>
              <td className="small strong" style={{ whiteSpace: 'nowrap' }}>{m.name}</td>
              <td><span className={`pill ${m.lean === 'for' ? 'good' : m.lean === 'against' ? 'critical' : 'warning'}`}>{m.lean}</span></td>
              <td className="tiny sub">{m.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {o.tips.length > 0 && (
        <ul className="tiny" style={{ margin: '6px 0 0 16px', padding: 0 }}>
          {o.tips.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      )}
    </>
  );
  if (compact) {
    return (
      <details style={{ marginTop: 4 }}>
        <summary>{head}</summary>
        {body}
      </details>
    );
  }
  return (
    <div>
      <h3 style={{ marginBottom: 6 }}>How the board is likely to vote</h3>
      {head}
      <div style={{ marginTop: 6 }}>{body}</div>
    </div>
  );
}

const human = (k: string) => titleCase(k.replace(/Cents$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());

/** Edit an action's parameters field by field (money in euros, dates as dates). */
function ParamEditor({ payload, onChange }: { payload: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...payload, [k]: v });
  return (
    <div className="form-grid">
      {Object.entries(payload).filter(([k]) => !SERVER_FIELDS.has(k)).map(([k, v]) => {
        if (typeof v === 'number') {
          const money = k.endsWith('Cents');
          return (
            <label key={k} className="field">{human(k)}{money ? ' (€)' : ''}
              <input type="number" value={money ? v / 100 : v} onChange={(e) => set(k, e.target.value === '' ? 0 : money ? Math.round(Number(e.target.value) * 100) : Number(e.target.value))} />
            </label>
          );
        }
        if (typeof v === 'boolean') return <label key={k} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={v} onChange={(e) => set(k, e.target.checked)} />{human(k)}</label>;
        if (typeof v === 'string' || v === null) {
          const isDate = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
          if (/Id$/.test(k) || k === 'templateKey' || k === 'optionKey' || k === 'kind' || k === 'mode') return <label key={k} className="field">{human(k)}<input type="text" value={String(v ?? '')} disabled /></label>;
          return <label key={k} className="field" style={!isDate ? { gridColumn: '1 / -1' } : undefined}>{human(k)}<input type={isDate ? 'date' : 'text'} value={String(v ?? '')} onChange={(e) => set(k, e.target.value)} /></label>;
        }
        return null;
      })}
    </div>
  );
}

export function ActionReview({ action, onClose }: { action: ActionRecord; onClose: () => void }) {
  const { refresh, toast } = useGame();
  const [a, setA] = useState(action);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(action.payload);
  const [rationale, setRationale] = useState(action.rationale ?? '');
  const needsBoard = a.needsBoard ?? a.approvals.some((x) => x.approver === 'board' && x.kind === 'required');
  const pending = a.status === 'pending_confirmation';
  const isPlan = a.type === 'issue_board_proposal';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const confirm = () =>
    run(async () => {
      const r = await api.post(`/actions/${a.id}/confirm`, { rationale: rationale || undefined });
      toast(r.message, r.ok ? 'success' : 'error');
      setA(r.action);
      refresh();
      if (r.ok) onClose();
    });
  const execute = () =>
    run(async () => {
      const r = await api.post(`/actions/${a.id}/execute`);
      toast(r.message, r.ok ? 'success' : 'error');
      setA(r.action);
      refresh();
    });
  const reject = () =>
    run(async () => {
      const r = await api.post(`/actions/${a.id}/reject`, { reason: 'Rejected by the CEO' });
      setA(r);
      toast(a.status === 'pending_approval' ? 'Withdrawn from the board agenda. Nothing was changed.' : a.status === 'approved' ? 'Withdrawn — it will not be carried out.' : 'Proposal rejected. Nothing was changed.');
      refresh();
      onClose();
    });
  const modify = () =>
    run(async () => {
      const n = await api.post(`/actions/${a.id}/modify`, { payload: draft });
      setA(n);
      setDraft(n.payload);
      setEditing(false);
      toast(n.status === 'invalid' ? 'The changed proposal is not valid — see the problems listed.' : 'Proposal updated; review the new consequences.', n.status === 'invalid' ? 'error' : 'info');
      refresh();
    });

  const primaryLabel = isPlan ? 'Put to the board' : needsBoard ? 'Submit to the board' : 'Approve & execute';
  return (
    <Modal
      wide={!!a.boardOutlook}
      title={
        <span className="row">
          {a.summary} <Status s={a.status} label={a.status === 'approved' ? 'Approved — waiting' : undefined} />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {(pending || a.status === 'invalid') && (
            <button className="btn ghost" disabled={busy} onClick={() => setEditing((x) => !x)}>
              {editing ? 'Cancel changes' : 'Change parameters'}
            </button>
          )}
          {(pending || a.status === 'pending_approval' || a.status === 'approved') && (
            <button className="btn danger" disabled={busy} onClick={reject}>
              {a.status === 'pending_confirmation' ? 'Reject' : 'Withdraw'}
            </button>
          )}
          {editing && (
            <button className="btn" disabled={busy} onClick={modify}>
              Re-check
            </button>
          )}
          {pending && !editing && (
            <button className="btn" disabled={busy} onClick={() => { toast('Kept as a draft — find it under Decisions → Your drafts.'); onClose(); }}>
              Keep as draft
            </button>
          )}
          {a.status === 'approved' && (
            <button className="btn primary" disabled={busy} onClick={execute}>
              Execute now
            </button>
          )}
          {pending && !editing && (
            <button className="btn primary" disabled={busy || a.errors.length > 0} onClick={confirm}>
              {primaryLabel}
            </button>
          )}
          {!pending && !editing && a.status !== 'approved' && (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
        </>
      }
    >
      <div className="small muted">
        {titleCase(a.type)} · proposed by {a.actorId === 'ceo' ? 'you' : a.actorId} ({a.source === 'llm_proposal' ? 'in a meeting' : a.source}) on {a.simDate} · {a.id}
      </div>
      {a.nextStep && (
        <div className={`callout ${a.status === 'invalid' || a.status === 'rejected' ? 'critical' : a.status === 'approved' ? 'warning' : 'info'} small`}>
          <strong>What happens next: </strong>{a.nextStep}
        </div>
      )}
      {a.rationale && <div className="callout small">Rationale: {a.rationale}</div>}
      {a.errors.length > 0 && (
        <div className="callout critical">
          <strong>Not possible as it stands — nothing will change:</strong>
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {a.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {a.warnings.length > 0 && (
        <div className="callout warning">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {a.warnings.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {a.consequences.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 6 }}>Calculated consequences</h3>
          <ConsequenceList a={a} />
          <div className="tiny muted" style={{ marginTop: 4 }}>
            Amounts are computed by the simulation engine. Items marked “estimate” come from the demand/forecast model and are uncertain.
          </div>
        </div>
      )}
      {a.approvals.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 6 }}>Approvals & process</h3>
          {a.approvals.map((x, i) => (
            <div key={i} className="row small" style={{ marginBottom: 4 }}>
              <Status s={x.status === 'denied' ? 'rejected' : x.kind === 'required' ? 'pending_approval' : 'info'} label={titleCase(x.approver)} />
              <span>{x.note}</span>
            </div>
          ))}
        </div>
      )}
      {a.boardOutlook && <BoardOutlook o={a.boardOutlook} />}
      {needsBoard && pending && !isPlan && (
        <label className="field">
          Your case to the board (the directors read it before voting — a clear, factual case helps a little; it cannot override their priorities)
          <textarea rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why this is right for Asterion, what it costs, what the alternatives are…" />
        </label>
      )}
      {editing && (
        <div>
          <h3 style={{ marginBottom: 6 }}>Change parameters</h3>
          <ParamEditor payload={draft} onChange={setDraft} />
          <div className="tiny muted" style={{ marginTop: 4 }}>The changed proposal is checked again from scratch before anything can happen.</div>
        </div>
      )}
      {a.result && !['pending_confirmation', 'approved'].includes(a.status) && (
        <div className="callout good small">
          <strong>Result:</strong> {String((a.result as { summary?: string }).summary ?? (a.result as { message?: string }).message ?? (a.result as { note?: string }).note ?? '')}{' '}
          {Array.isArray((a.result as { details?: string[] }).details) && (a.result as { details: string[] }).details.join(' · ')}
        </div>
      )}
    </Modal>
  );
}
