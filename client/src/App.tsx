import { useCallback, useEffect, useState } from 'react';
import { api, newKey } from './api';
import { ActionReview, type ActionRecord } from './components/ActionReview';
import { Modal } from './components/ui';
import { GameProvider, type Nav, type Page, type Toast } from './ctx';
import { llmLabel } from './components/ClaudeLink';
import { fmtDate, fmtEur } from './format';
import { Dashboard } from './pages/Dashboard';
import { Company } from './pages/Company';
import { Products } from './pages/Products';
import { Projects } from './pages/Projects';
import { Operations } from './pages/Operations';
import { Finance } from './pages/Finance';
import { World } from './pages/World';
import { Inbox } from './pages/Inbox';
import { History } from './pages/History';
import { Meeting } from './pages/Meeting';
import { Saves, Setup } from './pages/Saves';
import { Decisions } from './pages/Decisions';
import { Guide } from './components/Guide';

const NAV: [Page, string][] = [
  ['dashboard', 'Executive dashboard'],
  ['decisions', 'Decisions'],
  ['inbox', 'Inbox & meetings'],
  ['company', 'Company'],
  ['products', 'Products'],
  ['projects', 'Projects'],
  ['operations', 'Operations'],
  ['finance', 'Finance'],
  ['world', 'World'],
  ['history', 'History'],
  ['saves', 'Saves'],
];

function readHash(): Nav {
  const [page, param] = window.location.hash.replace(/^#\/?/, '').split('/');
  return { page: (NAV.some(([p]) => p === page) || page === 'meeting' ? page : 'dashboard') as Page, param: param ? decodeURIComponent(param) : null };
}

export function App() {
  const [status, setStatus] = useState<any>(null);
  const [version, setVersion] = useState(0);
  const [nav, setNav] = useState<Nav>(readHash());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [review, setReview] = useState<ActionRecord | null>(null);
  const [top, setTop] = useState<any>(null);
  const [advancing, setAdvancing] = useState(false);
  const [lastAdvance, setLastAdvance] = useState<any>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideTab, setGuideTab] = useState<'coach' | 'howto' | undefined>(undefined);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 5000);
  }, []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const go = useCallback((page: Page, param?: string | null) => {
    window.location.hash = `/${page}${param ? `/${encodeURIComponent(param)}` : ''}`;
  }, []);
  useEffect(() => {
    const h = () => setNav(readHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  useEffect(() => {
    api.get('/status').then(setStatus).catch((e) => toast(e.message, 'error'));
  }, [version, toast]);
  useEffect(() => {
    if (!status?.activeSave) return;
    api.get('/dashboard').then(setTop).catch(() => setTop(null));
  }, [status?.activeSave, version]);

  const propose = useCallback(
    async (type: string, payload: unknown, opts?: { rationale?: string }) => {
      try {
        const a = await api.post<ActionRecord>('/actions/propose', { type, payload, rationale: opts?.rationale, idempotencyKey: newKey() });
        setReview(a);
        refresh();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [toast, refresh],
  );
  const reviewAction = useCallback(
    async (id: string) => {
      try {
        setReview(await api.get<ActionRecord>(`/actions/${id}`));
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    [toast],
  );

  const advance = async (days: number) => {
    setAdvancing(true);
    try {
      const r = await api.post('/time/advance', { days, idempotencyKey: newKey() });
      setLastAdvance(r);
      if (r.stoppedEarly) toast(r.stoppedEarly, 'info');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setAdvancing(false);
    }
  };

  const ctx = { version, refresh, nav, go, toast, propose, reviewAction, status, openGuide: (tab?: 'coach' | 'howto') => { setGuideTab(tab); setGuideOpen(true); } };
  if (!status) return <div className="empty">Connecting to the simulation server…</div>;
  const hasGame = !!status.activeSave && !!status.game;
  const meta = top?.meta;
  const over = status.game?.status && status.game.status !== 'active';

  return (
    <GameProvider value={ctx}>
      {!hasGame ? (
        <Setup />
      ) : (
        <div className="app">
          <nav className="sidebar" aria-label="Main">
            <div className="brand">
              <div className="brand-mark">A</div>
              <div>
                <div className="brand-name">AUTOMANAGER</div>
                <div className="brand-sub">Asterion Automotive</div>
              </div>
            </div>
            {NAV.map(([p, l]) => (
              <button key={p} className={`nav-item ${nav.page === p || (p === 'inbox' && nav.page === 'meeting') ? 'active' : ''}`} onClick={() => go(p)}>
                <span>{l}</span>
                {p === 'inbox' && top?.unreadInbox > 0 && <span className="nav-badge">{top.unreadInbox}</span>}
                {p === 'decisions' && top?.pendingActions?.filter((a: any) => a.status === 'pending_confirmation' || a.status === 'approved').length > 0 && <span className="nav-badge" style={{ background: '#c98500' }} title="Drafts waiting for you, or approved decisions waiting to be carried out">{top.pendingActions.filter((a: any) => a.status === 'pending_confirmation' || a.status === 'approved').length}</span>}
              </button>
            ))}
            <div className="sidebar-foot">
              <div>Voices: {llmLabel(status.llm)}</div>
              <div style={{ marginTop: 4 }}>Save: {status.activeSave}</div>
            </div>
          </nav>
          <div className="main">
            <header className="topbar">
              <div className="date-block">
                <span className="s">Simulation date</span>
                <span className="d">{meta ? fmtDate(meta.currentDate, 'long') : '…'}</span>
              </div>
              <div className="time-controls" role="group" aria-label="Advance time">
                <button className="btn time" disabled={advancing || over} onClick={() => advance(1)}>+1 day</button>
                <button className="btn time" disabled={advancing || over} onClick={() => advance(7)}>+1 week</button>
                <button className="btn time" disabled={advancing || over} onClick={() => advance(meta ? daysToSameDayNextMonth(meta.currentDate) : 30)}>+1 month</button>
                {advancing && <span className="muted small">Simulating…</span>}
              </div>
              {top && (
                <div className="top-kpis">
                  <div className="top-kpi"><span className="l">Cash</span><span className="v">{fmtEur(top.kpis.cashCents)}</span></div>
                  <div className="top-kpi"><span className="l">Liquidity</span><span className="v" style={{ color: top.kpis.liquidityCents < 45_000_000_000 ? 'var(--critical-text)' : undefined }}>{fmtEur(top.kpis.liquidityCents)}</span></div>
                  <div className="top-kpi"><span className="l">Net leverage</span><span className="v">{top.kpis.netLeverage > 50 ? 'n/m' : `${top.kpis.netLeverage.toFixed(2)}x`}</span></div>
                  <div className="top-kpi"><span className="l">Board confidence</span><span className="v" style={{ color: top.board.confidence < 30 ? 'var(--critical-text)' : undefined }}>{Math.round(top.board.confidence)}/100</span></div>
                  <button className="btn sm guide-btn" onClick={() => setGuideOpen(true)} title="Coach and how-to help">? Guide</button>
                  <span className={`pill ${status.llm.available ? 'info' : ''}`} title={status.llm.available ? `Characters are voiced by ${llmLabel(status.llm)}; all outcomes are decided by the simulation engine.` : status.llm.note ?? 'Characters use the deterministic rule-based responder.'}>
                    {status.llm.available ? (status.llm.provider === 'claude-code' ? 'Claude characters' : 'LLM characters') : 'Deterministic mode'}
                  </span>
                </div>
              )}
            </header>
            {over && (
              <div className="callout critical" style={{ margin: '12px 20px 0' }}>
                <strong>Game over — {status.game.status === 'insolvent' ? 'insolvency' : status.game.status === 'not_renewed' ? 'mandate not renewed' : 'dismissed by the board'}.</strong> {status.game.terminal_reason} You can review the history, or start a new game (another scenario, difficulty or seed) / load a save under Saves.
              </div>
            )}
            {!over && status.game?.mandate?.passed && (
              <div className="callout good" style={{ margin: '12px 20px 0' }}>
                <strong>You won — mandate renewed (grade {status.game.mandate.grade}, {status.game.mandate.score}/100).</strong> The board reviewed your three years on {fmtDate(status.game.mandate.date, 'long')} and renewed your contract. You can keep running Asterion, or try a tougher scenario or difficulty under Saves.
              </div>
            )}
            <main className="content">
              {nav.page === 'dashboard' && <Dashboard />}
              {nav.page === 'decisions' && <Decisions />}
              {nav.page === 'company' && <Company />}
              {nav.page === 'products' && <Products />}
              {nav.page === 'projects' && <Projects />}
              {nav.page === 'operations' && <Operations />}
              {nav.page === 'finance' && <Finance />}
              {nav.page === 'world' && <World />}
              {nav.page === 'inbox' && <Inbox />}
              {nav.page === 'history' && <History />}
              {nav.page === 'meeting' && <Meeting />}
              {nav.page === 'saves' && <Saves />}
            </main>
          </div>
        </div>
      )}
      {review && <ActionReview key={review.id} action={review} onClose={() => { setReview(null); refresh(); }} />}
      {guideOpen && <Guide page={nav.page} initialTab={guideTab} onClose={() => { setGuideOpen(false); setGuideTab(undefined); }} />}
      {lastAdvance && (
        <Modal title={lastAdvance.briefing.subject} onClose={() => setLastAdvance(null)} footer={<><button className="btn" onClick={() => { setLastAdvance(null); go('inbox'); }}>Open inbox</button><button className="btn primary" onClick={() => setLastAdvance(null)}>Continue</button></>}>
          {lastAdvance.status !== 'active' && <div className="callout critical">{lastAdvance.terminalReason}</div>}
          <div className="pre">{lastAdvance.briefing.body}</div>
        </Modal>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </GameProvider>
  );
}

function daysToSameDayNextMonth(d: string): number {
  const dt = new Date(`${d}T00:00:00Z`);
  const next = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()));
  return Math.max(28, Math.min(31, Math.round((next.getTime() - dt.getTime()) / 86_400_000)));
}
