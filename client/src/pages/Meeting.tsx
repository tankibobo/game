import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { OfferForm } from '../components/Negotiation';
import { ShareForm } from '../components/ShareForm';
import { Card, Empty, Loading, Progress, Status } from '../components/ui';
import { useGame, useView } from '../ctx';
import { fmtDate, titleCase } from '../format';

function Reply({ m, actions }: { m: any; actions: any[] }) {
  const { reviewAction } = useGame();
  const s = m.structured ?? {};
  const mine = actions.filter((a) => (s.actionIds ?? []).includes(a.id));
  return (
    <div className="msg character">
      <div className="bubble">{m.content}</div>
      <div className="meta row" style={{ gap: 6 }}>
        <span>{fmtDate(m.simDate)}</span>
        {s.mode && <span className={`pill ${s.mode === 'llm' ? 'info' : ''}`} title={s.fallbackReason ?? ''}>{s.mode === 'llm' ? 'LLM' : 'deterministic'}</span>}
        {s.perspective?.stance && <Status s={s.perspective.stance === 'opposed' ? 'critical' : s.perspective.stance === 'skeptical' ? 'warning' : 'info'} label={s.perspective.stance} />}
        {s.emotion && <span className="muted">{s.emotion}</span>}
        {typeof s.trustDelta === 'number' && s.trustDelta !== 0 && <span style={{ color: s.trustDelta > 0 ? 'var(--good-text)' : 'var(--critical-text)' }} title={s.trustReason}>trust {s.trustDelta > 0 ? '+' : ''}{s.trustDelta}</span>}
      </div>
      {s.fallbackReason && s.mode === 'fallback' && !/deterministic mode/.test(s.fallbackReason) && <div className="tiny muted">LLM unavailable ({s.fallbackReason}); deterministic response used — no state was affected by the failure.</div>}
      {s.negotiation && (
        <div className={`callout small ${s.negotiation.outcome === 'accepted' ? 'good' : s.negotiation.outcome === 'rejected_final' ? 'critical' : 'info'}`}>
          <strong>Simulation outcome: {titleCase(s.negotiation.outcome)}.</strong> {s.negotiation.engineSummary}
          {s.negotiation.notes?.length > 0 && <div className="tiny">{s.negotiation.notes.join(' ')}</div>}
          <div className="tiny muted">Argument assessment: {s.negotiation.argumentQuality > 0.03 ? 'strong' : s.negotiation.argumentQuality > 0 ? 'moderate' : 'weak'} ({s.negotiation.argumentSource})</div>
        </div>
      )}
      {s.factWarnings?.length > 0 && (
        <div className="callout warning small">
          <strong>Unverified claim{s.factWarnings.length > 1 ? 's' : ''} — the simulation record disagrees:</strong>
          {s.factWarnings.map((w: string, i: number) => <div key={i}>{w}</div>)}
        </div>
      )}
      {s.claims?.filter((c: any) => c.verified !== 'consistent').map((c: any, i: number) => <div key={i} className="tiny muted">⚠ “{c.statement}” — {c.note}</div>)}
      {mine.map((a) => (
        <div key={a.id} className={`proposal ${a.status === 'invalid' ? 'invalid' : ''}`}>
          <div className="row">
            <span className="small strong">{a.type === 'make_promise' ? 'Commitment recorded' : 'Proposed action'}: {a.summary}</span>
            <span className="spacer" />
            <Status s={a.status} />
          </div>
          {a.rationale && a.type !== 'make_promise' && <div className="tiny sub">{a.rationale}</div>}
          {a.errors?.length > 0 && <div className="tiny" style={{ color: 'var(--critical-text)' }}>Validator: {a.errors.join(' ')}</div>}
          {a.status === 'pending_confirmation' && <div><button className="btn sm primary" onClick={() => reviewAction(a.id)}>Review consequences…</button></div>}
        </div>
      ))}
      {s.rejectedProposals?.map((r: any, i: number) => <div key={i} className="tiny muted">Ignored proposal “{r.type}”: {r.reason}</div>)}
      {s.eventProposals?.map((e: any, i: number) => <div key={i} className="tiny muted">Escalation “{e.key}”: {e.accepted ? 'eligible — the simulation will process it' : e.reason}</div>)}
    </div>
  );
}

export function Meeting() {
  const { nav, go, refresh, toast, version } = useGame();
  const id = nav.param;
  const [view, setView] = useState<any>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const { data: inbox } = useView<any>('/inbox');
  const load = () => id && api.get(`/conversations/${id}`).then(setView).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    load();
  }, [id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [view, pendingText]);
  if (!id) return <Empty>No meeting selected. <button className="btn sm" onClick={() => go('inbox', 'meetings')}>Choose someone to meet</button></Empty>;
  if (!view) return <Loading />;
  const c = view.character;
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    setPendingText(t);
    setText('');
    try {
      await api.post(`/conversations/${id}/messages`, { text: t });
      await load();
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
      setText(t);
    } finally {
      setBusy(false);
      setPendingText(null);
    }
  };
  const commitments = (inbox?.commitments ?? []).filter((x: any) => (x.promiseeId === c?.id || x.promisorId === c?.id) && ['open', 'due'].includes(x.status));
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{view.conversation.title}</h1>
          <p>{c?.name}, {c?.title} · started {fmtDate(view.conversation.startedDate)}. Talking does not change the company: proposals they make appear under their reply for you to review, and they remember what you say and send them.</p>
        </div>
        <button className="btn sm" onClick={() => go('inbox', 'meetings')}>All meetings</button>
      </div>
      <div className="chat">
        <section className="card chat-main">
          <div className="chat-log" ref={logRef}>
            {view.messages.length === 0 && !pendingText && <Empty>Say something to {c?.name.split(' ')[0]}. Try asking about the situation, giving an instruction, making a promise, or negotiating.</Empty>}
            {view.messages.map((m: any) =>
              m.role === 'system' ? (
                <div key={m.id} className="msg system">
                  <div className="bubble">📎 {m.content}{m.structured?.body && <details><summary className="tiny">Show contents</summary><div className="tiny pre">{m.structured.body}</div></details>}</div>
                </div>
              ) : m.role === 'player' ? (
                <div key={m.id} className="msg player">
                  <div className="bubble">{m.content}</div>
                  <div className="meta" style={{ textAlign: 'right' }}>You · {fmtDate(m.simDate)}</div>
                </div>
              ) : (
                <Reply key={m.id} m={m} actions={view.actions} />
              ),
            )}
            {pendingText && (
              <>
                <div className="msg player"><div className="bubble">{pendingText}</div></div>
                <div className="msg character"><div className="bubble typing">{c?.name.split(' ')[0]} is thinking…</div></div>
              </>
            )}
          </div>
          <div className="chat-input">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={`Message ${c?.name ?? ''}… (Enter to send, Shift+Enter for a new line)`}
              disabled={busy}
              aria-label="Your message"
            />
            <button className="btn primary" disabled={busy || !text.trim()} onClick={send}>Send</button>
          </div>
        </section>
        <div className="stack" style={{ overflowY: 'auto' }}>
          {c && (
            <Card title={c.name} sub={c.title}>
              <div className="small stack" style={{ gap: 6 }}>
                <div className="row"><span className="muted">Trust in you</span><Progress value={c.trustInCeo / 100} tone={c.trustInCeo < 35 ? 'var(--critical)' : undefined} /><span className="num">{Math.round(c.trustInCeo)}</span></div>
                <div><span className="muted">Wants:</span> {c.objectives.join('; ')}</div>
                <div><span className="muted">Incentives:</span> {c.incentives}</div>
                <div><span className="muted">Style:</span> {c.communicationStyle}</div>
              </div>
            </Card>
          )}
          {view.negotiation && view.negotiation.status !== 'expired' && (
            <Card title="Negotiation" sub={view.negotiation.title}>
              <OfferForm neg={view.negotiation} conversationId={id} onDone={() => load()} />
            </Card>
          )}
          {c?.active && (
            <Card title="Share a document" sub={`Send ${c.name.split(' ')[0]} a report built from current figures, or a memo. They will use it in this and later meetings.`}>
              <ShareForm fixedRecipient={c.id} conversationId={id} onShared={() => load()} />
            </Card>
          )}
          <Card title="Commitments with this person" flush>
            {commitments.length === 0 ? <Empty>None open.</Empty> : (
              <div className="list">
                {commitments.map((x: any) => (
                  <div key={x.id} className="list-item">
                    <div style={{ flex: 1 }}>
                      <div className="small">{x.description}</div>
                      <div className="tiny muted">{x.promisorId === 'ceo' ? 'You promised' : 'They promised'} · due {x.dueDate ? fmtDate(x.dueDate) : 'n/a'}</div>
                    </div>
                    <Status s={x.status} />
                  </div>
                ))}
              </div>
            )}
          </Card>
          {view.conversation.summary && (
            <Card title="Meeting notes" sub="Running summary stored with the conversation">
              <div className="small pre">{view.conversation.summary}</div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
