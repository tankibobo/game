/** A careful CEO over two years: covers year-two flows (budget rollover, refinancing, bond repayment). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../server/db/connection';
import { loadWorld } from '../../server/db/repo';
import { advanceTime, confirmAction, createNewGame, proposeAction } from '../../server/game/game';
import { submitOffer } from '../../server/llm/conversation';
import { NoneProvider } from '../../server/llm/provider';
import { statement } from '../../server/game/queries';
import { fmtEur, mEur } from '../../shared/money';
import { addDays } from '../../shared/dates';

const llm = { provider: new NoneProvider(), timeoutMs: 1000 };
const db = openDb(join(mkdtempSync(join(tmpdir(), 'two-')), 'g.sqlite'));
createNewGame(db);
const w = () => loadWorld(db);
const act = (type: string, payload: unknown, why = '') => {
  const a = proposeAction(db, { type, payload, rationale: why || 'Careful CEO decision with a clear case.' });
  if (a.status !== 'pending_confirmation') return console.log(`  ✗ ${type}: ${a.errors.join(' ')}`);
  const r = confirmAction(db, a.id, 'ceo', { boardRationale: why || 'A clear, factual case for the board.' });
  console.log(`  ${r.ok ? '✓' : '✗'} ${a.summary} → ${r.message}`);
};
async function negotiate(id: string, first: Record<string, number>) {
  let r = await submitOffer(db, llm, id, first, 'We commit volume; our forecast needs this, and we have a credible alternative.');
  for (let i = 0; i < 5 && r.outcome === 'countered'; i++) {
    const n = w().negotiations.find((x) => x.id === id)!;
    r = await submitOffer(db, llm, id, n.rounds[n.rounds.length - 1].terms, 'Agreed on your terms.');
  }
  console.log(`  negotiation ${id}: ${r.outcome}`);
}
const status = (label: string) => {
  const x = w();
  const fc = x.meta.lastForecastSummary!;
  console.log(`${label} ${x.meta.currentDate}: cash ${fmtEur(x.balances['1000'] ?? 0)} · confidence ${x.meta.boardConfidence} · rating ${x.meta.creditRating} · FY EBIT fc ${fmtEur(fc.fyEbitCents)} vs plan ${fmtEur(x.meta.boardPlan.ebitTargetCents)} · min liq 12m ${fmtEur(fc.minLiquidity12mCents ?? 0)} · status ${x.meta.status}`);
};
async function main() {
  act('approve_project', { projectId: 'PRJ-VELA-E7' });
  act('adjust_production', { lineId: 'LINE-LYON-VELA', plannedDailyRate: 520, reason: 'Align with demand' });
  act('address_issue', { issueId: 'ISS-THERMAL', optionKey: 'barrier_redesign' });
  act('address_issue', { issueId: 'ISS-KORA-INV', optionKey: 'investigate' });
  await negotiate('NEG-VOLTARIS', { dailyVolume: 300, priceEur: 9200, prepaymentM: 40, takeOrPayPct: 60 });
  const c = w().contracts.find((x) => x.negotiationId === 'NEG-VOLTARIS' && x.status === 'agreed');
  if (c) act('sign_contract', { contractId: c.id }, 'Secures Eon battery supply.');
  act('hire_staff', { departmentId: 'DEP-BRNO', headcount: 450, reason: 'Eon ramp-up' });
  act('request_financing', { kind: 'bond', amountCents: mEur(600), tenorYears: 6, rationale: 'Refinance the 2028 notes early' }, 'Refinance the 2028 notes well ahead of maturity.');
  advanceTime(db, 31);
  status('Feb');
  await negotiate('NEG-UNION', { wageIncreasePct: 3.0, oneOffBonusEur: 400, jobGuaranteeMonths: 12 });
  act('hire_staff', { departmentId: 'DEP-BRNO', headcount: 450, reason: 'Eon ramp-up, second wave' });
  for (let m = 0; m < 24; m++) {
    const x = w();
    if (x.meta.status !== 'active') break;
    for (const k of x.contracts.filter((k) => k.status === 'agreed')) act('sign_contract', { contractId: k.id });
    for (const f of x.financing.filter((f) => f.status === 'offered')) act('accept_financing', { financingId: f.id });
    for (const i of x.issues.filter((i) => i.id === 'ISS-KORA-INV' && i.data.rootCause === 'confirmed' && i.status !== 'resolved')) act('address_issue', { issueId: i.id, optionKey: 'service_campaign' });
    const recov = x.commitments.find((k) => k.status === 'open' && k.check.type === 'deliver_plan' && k.check.topic === 'recovery');
    if (recov) act('issue_board_proposal', { title: `Recovery plan ${x.meta.currentDate}`, kind: 'recovery_plan', rationale: 'Protect liquidity: production discipline, refinancing in place, Eon on track, cost control at Lyon.' });
    const r = advanceTime(db, 31);
    const bad = r.events.filter((e) => e.severity === 'critical').map((e) => e.title);
    if (bad.length) console.log(`  critical: ${bad.join(' · ')}`);
    if (m % 3 === 2) status(`M${m + 2}`);
  }
  status('End');
  const x = w();
  const d = x.meta.currentDate;
  const st = statement(db, `${d.slice(0, 4)}-01-01`, addDays(d, -1));
  console.log('reconciliation', st.reconciliation);
  console.log('debts', x.debts.map((k) => `${k.id}:${k.status}:${fmtEur(k.principalCents)}`).join(' '));
  console.log('stuck approvals', (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status IN ('approved','pending_approval')").get() as { n: number }).n, 'scheduled', x.boardProposals.filter((b) => b.status === 'scheduled').map((b) => `${b.id}@${b.meetingDate}`));
  console.log('budgets', (db.prepare("SELECT title FROM events WHERE type = 'budget_approved'").all() as { title: string }[]).map((r) => r.title));
}
main();
