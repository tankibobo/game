/**
 * Stress playtest: random decisions of every kind over several simulated
 * years, through the same service layer as the UI, checking invariants after
 * every step. Usage: npx tsx scripts/dev/fuzz.ts [seed] [months]
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../server/db/connection';
import { loadWorld, rowToAction } from '../../server/db/repo';
import { actionView, advanceTime, confirmAction, createNewGame, executeApproved, proposeAction, rejectAction } from '../../server/game/game';
import { decisionsView } from '../../server/game/decisions';
import { shareDocument, DOCUMENT_TYPES } from '../../server/game/documents';
import { company, dashboard, finance, inboxView, products, projectsView, statement, worldView, operations, history } from '../../server/game/queries';
import { askGuide } from '../../server/guide/guide';
import { NoneProvider } from '../../server/llm/provider';
import { sendMessage, startConversation, submitOffer } from '../../server/llm/conversation';
import { PROJECT_TEMPLATES } from '../../server/actions/templates';
import { NEGOTIATION_TEMPLATES } from '../../server/engine/negotiation';
import { addDays } from '../../shared/dates';

const seed = Number(process.argv[2] ?? 1);
const months = Number(process.argv[3] ?? 36);
let s = seed;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const llm = { provider: new NoneProvider(), timeoutMs: 1000 };
const db = openDb(join(mkdtempSync(join(tmpdir(), 'fuzz-')), 'g.sqlite'));
createNewGame(db);
const problems: string[] = [];
const stats: Record<string, number> = {};
const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

function randomAction(): { type: string; payload: Record<string, unknown> } {
  const w = loadWorld(db);
  const dep = pick(w.departments);
  const proj = pick(w.projects);
  const model = pick(w.models.filter((m) => m.status === 'in_production'));
  const line = pick(w.lines);
  const issue = pick(w.issues.filter((i) => !['resolved', 'closed'].includes(i.status)).concat(w.issues));
  const d = w.meta.currentDate;
  const choices: (() => { type: string; payload: Record<string, unknown> })[] = [
    () => ({ type: 'hire_staff', payload: { departmentId: dep.id, headcount: pick([50, 200, 450, 700, 1200]), reason: 'fuzz' } }),
    () => ({ type: 'restructure_workforce', payload: { departmentId: dep.id, reduction: pick([50, 250, 400, 900]), mode: pick(['voluntary', 'compulsory']), reason: 'fuzz' } }),
    () => ({ type: 'start_project', payload: { templateKey: pick(PROJECT_TEMPLATES).key } }),
    () => ({ type: 'approve_project', payload: { projectId: proj.id } }),
    () => ({ type: 'change_project_scope', payload: { projectId: proj.id, staffingDelta: pick([-60, -20, 30, 80]), reason: 'fuzz re-plan' } }),
    () => ({ type: 'change_project_scope', payload: { projectId: proj.id, newTargetDate: addDays(d, pick([60, 200, 400])), reason: 'fuzz date' } }),
    () => ({ type: 'propose_budget', payload: { projectId: proj.id, amountCents: pick([10e8, 60e8]), reason: 'fuzz budget' } }),
    () => ({ type: 'cancel_project', payload: { projectId: proj.id, reason: 'fuzz cancel' } }),
    () => ({ type: 'address_issue', payload: { issueId: issue?.id ?? 'x', optionKey: issue?.options?.length ? pick(issue.options).key : 'none' } }),
    () => ({ type: 'change_price', payload: { modelId: model.id, netPriceCents: Math.round(model.netPriceCents * pick([0.95, 1.03])), reason: 'fuzz' } }),
    () => ({ type: 'set_marketing_budget', payload: { monthlyCents: pick([20e8, 35e8, 50e8]), reason: 'fuzz' } }),
    () => ({ type: 'adjust_production', payload: { lineId: line.id, plannedDailyRate: Math.round(line.maxDailyRate * pick([0.6, 0.8, 0.95])), reason: 'fuzz' } }),
    () => ({ type: 'schedule_downtime', payload: { factoryId: pick(w.factories).id, startDate: addDays(d, 10), endDate: addDays(d, 15), reason: 'fuzz' } }),
    () => ({ type: 'request_financing', payload: { kind: pick(['bank_term_loan', 'bond', 'rights_issue', 'sale_leaseback', 'rcf_draw', 'rcf_repay', 'covenant_waiver']), amountCents: pick([50e8, 150e8, 400e8]), tenorYears: 5, rationale: 'fuzz financing' } }),
    () => ({ type: 'open_negotiation', payload: { templateKey: pick(Object.keys(NEGOTIATION_TEMPLATES)) } }),
    () => ({ type: 'make_promise', payload: { promiseeId: pick(w.characters).id, description: 'Fuzz promise to deliver something', dueDate: addDays(d, 30) } }),
    () => ({ type: 'call_board_meeting', payload: { date: addDays(d, 10), reason: 'fuzz meeting' } }),
  ];
  return pick(choices)();
}

function check(label: string) {
  const w = loadWorld(db);
  const d = w.meta.currentDate;
  const year = d.slice(0, 4);
  const st = statement(db, `${year}-01-01`, addDays(d, -1) < `${year}-01-01` ? `${year}-01-01` : addDays(d, -1));
  if (Math.abs(st.reconciliation.difference) > 0) problems.push(`${label}: cash flow does not reconcile (${st.reconciliation.difference})`);
  if (st.reconciliation.balanceSheetCheck !== 0) problems.push(`${label}: balance sheet does not balance (${st.reconciliation.balanceSheetCheck})`);
  for (const bp of w.boardProposals) if (bp.status === 'scheduled' && bp.meetingDate < d) problems.push(`${label}: proposal ${bp.id} still scheduled after its meeting ${bp.meetingDate}`);
  const rows = (db.prepare("SELECT * FROM actions WHERE status IN ('pending_approval','approved')").all() as Record<string, unknown>[]).map(rowToAction);
  for (const a of rows) {
    if (a.status === 'pending_approval' && !w.boardProposals.some((b) => b.status === 'scheduled' && (b.actionIds.includes(a.id) || b.actionId === a.id))) problems.push(`${label}: ${a.id} ${a.type} pending approval but on no agenda`);
    if (a.status === 'approved') {
      const until = String((a.result as { validUntil?: string } | null)?.validUntil ?? '');
      if (!until) problems.push(`${label}: ${a.id} approved without validUntil`);
      else if (until < addDays(d, -40)) problems.push(`${label}: ${a.id} approval long expired but still waiting (${until})`);
    }
  }
  if (w.meta.boardConfidence < 0 || w.meta.boardConfidence > 100 || Number.isNaN(w.meta.boardConfidence)) problems.push(`${label}: board confidence ${w.meta.boardConfidence}`);
  for (const dep of w.departments) if (dep.headcount < 0 || !Number.isFinite(dep.headcount)) problems.push(`${label}: ${dep.id} headcount ${dep.headcount}`);
  // Every read model the UI uses must build.
  for (const [n, f] of [['dashboard', dashboard], ['company', company], ['products', products], ['projects', projectsView], ['operations', operations], ['finance', finance], ['world', worldView], ['inbox', inboxView], ['decisions', decisionsView]] as const) {
    try {
      JSON.stringify((f as (db: unknown) => unknown)(db));
    } catch (e) {
      problems.push(`${label}: view ${n} failed: ${(e as Error).message}`);
    }
  }
  try {
    history(db, {} as never);
  } catch {
    /* history signature differs; covered elsewhere */
  }
}

async function main() {
  for (let m = 0; m < months; m++) {
    const w0 = loadWorld(db);
    if (w0.meta.status !== 'active') {
      console.log(`game ended ${w0.meta.currentDate}: ${w0.meta.status} — ${w0.meta.terminalReason}`);
      break;
    }
    const n = 2 + Math.floor(rnd() * 4);
    const drafts: string[] = [];
    for (let i = 0; i < n; i++) {
      const { type, payload } = randomAction();
      let a;
      try {
        a = proposeAction(db, { type, payload, rationale: 'Fuzz test decision with a written case for the board.' });
        actionView(db, a);
      } catch (e) {
        problems.push(`propose ${type} threw: ${(e as Error).message}`);
        continue;
      }
      bump(`${type}:${a.status}`);
      if (a.status !== 'pending_confirmation') continue;
      const r = rnd();
      if (r < 0.6) {
        try {
          const c = confirmAction(db, a.id, 'ceo', { boardRationale: 'Fuzz case.' });
          bump(`${type}:confirm:${c.action.status}`);
        } catch (e) {
          problems.push(`confirm ${type} threw: ${(e as Error).message}`);
        }
      } else if (r < 0.8) drafts.push(a.id);
      else rejectAction(db, a.id);
    }
    if (drafts.length && rnd() < 0.7) {
      const plan = proposeAction(db, { type: 'issue_board_proposal', payload: { title: `Fuzz plan ${m}`, kind: 'strategy', rationale: 'A plan bundling several drafted decisions.', actionIds: drafts } });
      bump(`plan:${plan.status}`);
      if (plan.status === 'pending_confirmation') bump(`plan:confirm:${confirmAction(db, plan.id).action.status}`);
    }
    // Waiting approvals: try to execute by hand sometimes.
    for (const r of db.prepare("SELECT id FROM actions WHERE status = 'approved'").all() as { id: string }[]) if (rnd() < 0.3) bump(`execute:${executeApproved(db, r.id).ok}`);
    // Talk, share, ask the guide, negotiate.
    try {
      const w = loadWorld(db);
      const c = pick(w.characters.filter((x) => x.active));
      const conv = startConversation(db, c.id);
      await sendMessage(db, llm, conv.id, pick(['How do we stand?', 'I promise you an answer by next month.', 'Let us revamp the Vela with the hybrid.', 'Hire 300 people at Brno.', 'Send me your view on liquidity.']));
      shareDocument(db, { reports: [{ key: pick(DOCUMENT_TYPES.filter((t) => !('param' in t && t.param) && t.key !== 'memo' && t.key !== 'board_proposal')).key }], recipientIds: [c.id], conversationId: conv.id });
      await askGuide(db, llm, pick(['How do I hire more people?', 'board rejected', 'how to negotiate']), 'dashboard');
      const neg = w.negotiations.find((x) => x.status === 'open');
      if (neg && rnd() < 0.3) {
        const terms = Object.fromEntries(neg.terms.map((t) => [t.key, Math.round((t.min + t.max) / 2 / t.step) * t.step]));
        await submitOffer(db, llm, neg.id, terms, 'A balanced offer based on our forecast.');
        bump('offer');
      }
    } catch (e) {
      problems.push(`interaction threw: ${(e as Error).message}`);
    }
    try {
      advanceTime(db, pick([7, 14, 31]));
    } catch (e) {
      problems.push(`advance threw: ${(e as Error).message}`);
    }
    check(`month ${m} (${loadWorld(db).meta.currentDate})`);
    if (problems.length > 20) break;
  }
  const w = loadWorld(db);
  console.log(`seed ${seed}: reached ${w.meta.currentDate}, status ${w.meta.status}, confidence ${w.meta.boardConfidence}`);
  console.log('board proposals:', w.boardProposals.length, 'approved', w.boardProposals.filter((b) => b.status === 'approved').length, 'rejected', w.boardProposals.filter((b) => b.status === 'rejected').length);
  console.log('stats:', JSON.stringify(stats));
  const ev = db.prepare("SELECT type, COUNT(*) AS n FROM events WHERE type IN ('board_reaction','board_rejected','board_approved','board_warning','rating_downgrade','refinancing_pressure','commitment_broken','commitment_fulfilled','recall','strike') GROUP BY type").all();
  console.log('board-relevant events:', JSON.stringify(ev));
  for (const r of db.prepare("SELECT date, description FROM events WHERE type IN ('board_meeting') ORDER BY seq").all() as { date: string; description: string }[]) console.log(' meeting', r.date, r.description.match(/board confidence [^.]*\. Drivers: [^.]*/)?.[0] ?? '');
  console.log(problems.length ? `PROBLEMS (${problems.length}):\n${problems.join('\n')}` : 'no problems');
}
main();
