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
}

const KIND_ICON: Record<string, string> = { cash: '€', pnl: 'P&L', operational: 'OPS', people: 'PPL', risk: '⚠', approval: '✓?', info: 'i' };

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

export function ActionReview({ action, onClose }: { action: ActionRecord; onClose: () => void }) {
  const { refresh, toast } = useGame();
  const [a, setA] = useState(action);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState(JSON.stringify(action.payload, null, 2));
  const [rationale, setRationale] = useState(action.rationale ?? '');
  const needsBoard = a.approvals.some((x) => x.approver === 'board' && x.kind === 'required');
  const pending = a.status === 'pending_confirmation';

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
  const reject = () =>
    run(async () => {
      const r = await api.post(`/actions/${a.id}/reject`, { reason: 'Rejected by the CEO' });
      setA(r);
      toast(a.status === 'pending_approval' ? 'Withdrawn from the board agenda.' : 'Proposal rejected. Nothing was changed.');
      refresh();
      onClose();
    });
  const modify = () =>
    run(async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(json);
      } catch {
        throw new Error('Parameters are not valid JSON.');
      }
      const n = await api.post(`/actions/${a.id}/modify`, { payload });
      setA(n);
      setJson(JSON.stringify(n.payload, null, 2));
      setEditing(false);
      toast(n.status === 'invalid' ? 'Modified proposal is invalid — see errors.' : 'Proposal updated; review the new consequences.', n.status === 'invalid' ? 'error' : 'info');
      refresh();
    });

  return (
    <Modal
      title={
        <span className="row">
          {a.summary} <Status s={a.status} />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {(pending || a.status === 'invalid') && (
            <button className="btn ghost" disabled={busy} onClick={() => setEditing((x) => !x)}>
              {editing ? 'Cancel edit' : 'Modify'}
            </button>
          )}
          {(pending || a.status === 'pending_approval') && (
            <button className="btn danger" disabled={busy} onClick={reject}>
              {a.status === 'pending_approval' ? 'Withdraw' : 'Reject'}
            </button>
          )}
          {editing && (
            <button className="btn" disabled={busy} onClick={modify}>
              Re-validate
            </button>
          )}
          {pending && !editing && (
            <button className="btn primary" disabled={busy || a.errors.length > 0} onClick={confirm}>
              {needsBoard ? 'Submit to the board' : 'Approve & execute'}
            </button>
          )}
          {!pending && !editing && (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          )}
        </>
      }
    >
      <div className="small muted">
        {titleCase(a.type)} · proposed by {a.actorId === 'ceo' ? 'you' : a.actorId} ({a.source === 'llm_proposal' ? 'from a conversation' : a.source}) on {a.simDate} · {a.id}
      </div>
      {a.rationale && <div className="callout">Rationale: {a.rationale}</div>}
      {a.errors.length > 0 && (
        <div className="callout critical">
          <strong>Rejected by the validator — nothing will change:</strong>
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
      {needsBoard && pending && (
        <label className="field">
          Your case to the board (read by the directors before they vote — a clear, factual case helps a little; it cannot override their priorities)
          <textarea rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why this is right for Asterion, what it costs, what the alternatives are…" />
        </label>
      )}
      {editing && (
        <label className="field">
          Parameters (JSON) — the modified proposal is re-validated from scratch
          <textarea className="mono" rows={8} value={json} onChange={(e) => setJson(e.target.value)} />
        </label>
      )}
      {a.result && a.status !== 'pending_confirmation' && (
        <div className="callout good small">
          <strong>Result:</strong> {String((a.result as { summary?: string }).summary ?? (a.result as { message?: string }).message ?? (a.result as { note?: string }).note ?? '')}{' '}
          {Array.isArray((a.result as { details?: string[] }).details) && (a.result as { details: string[] }).details.join(' · ')}
        </div>
      )}
    </Modal>
  );
}
