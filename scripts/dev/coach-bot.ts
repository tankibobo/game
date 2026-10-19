/**
 * Coach bot: plays a whole three-year mandate by following the Coach's advice
 * (and the negotiation guidance it gives), to check that the game is winnable.
 *
 *   npx tsx scripts/dev/coach-bot.ts [scenario|all] [difficulty] [seed] [--passive] [--quiet]
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../../server/db/connection';
import { loadWorld } from '../../server/db/repo';
import { advanceTime, confirmAction, createNewGame, executeApproved, proposeAction } from '../../server/game/game';
import { submitOffer } from '../../server/llm/conversation';
import { NoneProvider } from '../../server/llm/provider';
import { coachReport } from '../../server/guide/advisor';
import { mandateObjectives, mandateScore } from '../../server/engine/mandate';
import { SCENARIOS } from '../../server/scenario/scenarios';
import { fmtEur } from '../../shared/money';
import type { Difficulty } from '../../shared/domain';

const llm = { provider: new NoneProvider(), timeoutMs: 1000 };

/** Opening positions per the Coach's negotiation guidance. */
const OPENERS: Record<string, Record<string, number>> = {
  voltaris_supply: { dailyVolume: 300, priceEur: 9100, prepaymentM: 40, takeOrPayPct: 60 },
  labor_agreement: { wageIncreasePct: 3.25, oneOffBonusEur: 600, jobGuaranteeMonths: 24 },
};
const ARG = 'We commit firm volumes from our forecast; this deal funds your plans, we have a credible alternative, and the company situation is set out in the shared forecast.';

export interface BotResult {
  scenario: string;
  difficulty: string;
  seed: number;
  status: string;
  date: string;
  score: number;
  passed: boolean | null;
  minConfidence: number;
  log: string[];
}

export async function playMandate(scenario: string, difficulty: Difficulty, seed: number, opts: { passive?: boolean; quiet?: boolean; db?: DB; months?: number; onMonth?: (w: ReturnType<typeof loadWorld>) => void } = {}): Promise<BotResult> {
  const db = opts.db ?? openDb(join(mkdtempSync(join(tmpdir(), 'bot-')), 'g.sqlite'));
  createNewGame(db, seed, { scenario, difficulty });
  const log: string[] = [];
  const say = (s: string) => {
    log.push(s);
    if (!opts.quiet) console.log(s);
  };
  const w = () => loadWorld(db);
  const failed = new Map<string, number>();

  const act = (type: string, payload: Record<string, unknown>, why?: string, include = false): string | null => {
    const a = proposeAction(db, { type, payload, rationale: why ?? 'Coach recommendation with a clear factual case.' });
    if (a.status !== 'pending_confirmation') {
      say(`    ✗ ${type}: ${a.errors.join(' ')}`);
      return null;
    }
    if (include) return a.id;
    const r = confirmAction(db, a.id, 'ceo', { boardRationale: why ?? 'A clear, factual case for the board.' });
    say(`    ${r.ok ? '✓' : '✗'} ${a.summary} → ${r.message}`);
    return r.ok ? a.id : null;
  };

  const negotiate = async (negId: string, templateKey: string) => {
    const n0 = w().negotiations.find((x) => x.id === negId);
    if (!n0 || n0.status !== 'open') return;
    const mine = n0.rounds.filter((r) => r.by === 'ceo');
    let terms: Record<string, number>;
    const last = n0.rounds[n0.rounds.length - 1];
    if (!mine.length) terms = { ...(OPENERS[templateKey] ?? {}) };
    else if (last && last.by !== 'ceo') {
      // Concede halfway toward their counter; accept it outright from round 3.
      const prev = mine[mine.length - 1].terms;
      terms = {};
      for (const k of Object.keys(last.terms)) terms[k] = mine.length >= 3 ? last.terms[k] : (prev[k] ?? last.terms[k]) + ((last.terms[k] - (prev[k] ?? last.terms[k])) * 0.5);
    } else return;
    for (const k of Object.keys(terms)) terms[k] = Math.round(terms[k] * 100) / 100;
    const r = await submitOffer(db, llm, negId, terms, ARG);
    say(`    ⇄ ${n0.title}: offered ${JSON.stringify(terms)} → ${r.outcome}`);
  };

  let minConf = 100;
  for (let month = 0; month < (opts.months ?? 40); month++) {
    let x = w();
    if (x.meta.status !== 'active' || x.meta.mandate) break;
    if (!opts.passive) {
      const rep = coachReport(db, x);
      // Approved-but-waiting actions: try to execute.
      for (const a of db.prepare("SELECT id FROM actions WHERE status = 'approved'").all() as { id: string }[]) executeApproved(db, a.id);
      const included: string[] = [];
      for (const adv of rep.advice) {
        const fails = failed.get(adv.id) ?? 0;
        if (adv.action && fails < 2) {
          const isPlan = adv.action.type === 'issue_board_proposal';
          const id = act(adv.action.type, isPlan ? { ...adv.action.payload, actionIds: included.length ? included : undefined } : adv.action.payload, adv.action.rationale);
          if (!id) failed.set(adv.id, fails + 1);
        } else if (adv.id === 'eon-supply' || adv.id === 'union') {
          const neg = x.negotiations.find((g) => g.templateKey === (adv.id === 'union' ? 'labor_agreement' : 'voltaris_supply') && g.status === 'open');
          if (neg) await negotiate(neg.id, neg.templateKey);
        }
      }
      // Re-evaluate negotiations again (more rounds per month).
      for (let i = 0; i < 2; i++) {
        x = w();
        for (const neg of x.negotiations.filter((g) => g.status === 'open' && OPENERS[g.templateKey])) await negotiate(neg.id, neg.templateKey);
      }
      x = w();
      for (const c of x.contracts.filter((k) => k.status === 'agreed')) act('sign_contract', { contractId: c.id }, 'Secures a critical constraint negotiated at the table.');
      for (const c of x.commitments.filter((k) => k.promisorId === 'ceo' && k.check.type === 'freeform' && k.status === 'due')) {
        db.prepare("UPDATE commitments SET status = 'fulfilled' WHERE id = ?").run(c.id);
      }
    }
    let left = 31;
    const events: { title: string; severity: string }[] = [];
    while (left > 0) {
      const r = advanceTime(db, left);
      events.push(...r.events);
      left -= r.days;
      if (r.status !== 'active' || r.days === 0) break;
      if (left > 0 && r.stoppedEarly && !opts.passive) {
        for (const f of w().financing.filter((k) => k.status === 'offered')) act('accept_financing', { financingId: f.id });
      }
    }
    x = w();
    minConf = Math.min(minConf, x.meta.boardConfidence);
    opts.onMonth?.(x);
    const crit = events.filter((e) => e.severity === 'critical').map((e) => e.title);
    const fc = x.meta.lastForecastSummary;
    say(`${x.meta.currentDate} conf ${x.meta.boardConfidence.toFixed(0)} strikes ${x.meta.lowConfidenceMeetings} · cash ${fmtEur(x.balances['1000'] ?? 0)} · FY EBIT fc ${fmtEur(fc?.fyEbitCents ?? 0)} · 12m low ${fmtEur(fc?.minLiquidity12mCents ?? 0)} · mandate ${mandateScore(mandateObjectives(x))} · ${x.meta.status}${crit.length ? `\n    ! ${crit.join(' · ')}` : ''}`);
  }
  const x = w();
  const res: BotResult = { scenario, difficulty, seed, status: x.meta.status, date: x.meta.currentDate, score: x.meta.mandate?.score ?? mandateScore(mandateObjectives(x)), passed: x.meta.mandate?.passed ?? null, minConfidence: minConf, log };
  if (!opts.quiet) {
    console.log(`RESULT ${scenario}/${difficulty}/seed ${seed}: ${res.status} at ${res.date}, score ${res.score}, passed ${res.passed}`);
    for (const o of mandateObjectives(x)) console.log(`  ${o.label}: ${Math.round(o.score * o.weight)}/${o.weight} — ${o.detail}`);
    if (x.meta.terminalReason) console.log('  reason:', x.meta.terminalReason);
  }
  return res;
}

if (process.argv[1]?.endsWith('coach-bot.ts')) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const passive = process.argv.includes('--passive');
  const quiet = process.argv.includes('--quiet');
  const sc = args[0] ?? 'turnaround';
  const diff = (args[1] ?? 'standard') as Difficulty;
  const seeds = (args[2] ?? '20270101').split(',').map(Number);
  const list = sc === 'all' ? SCENARIOS.map((s) => s.key) : sc.split(',');
  (async () => {
    const out: BotResult[] = [];
    for (const s of list) for (const seed of seeds) out.push(await playMandate(s, diff, seed, { passive, quiet }));
    console.log('\nSUMMARY');
    for (const r of out) console.log(`  ${r.scenario.padEnd(14)} ${r.difficulty.padEnd(9)} seed ${r.seed}: ${r.status.padEnd(12)} ${r.date} score ${r.score} passed ${r.passed} minConf ${r.minConfidence.toFixed(0)}`);
  })();
}
