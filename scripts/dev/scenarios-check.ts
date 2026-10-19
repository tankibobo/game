/** Build every scenario, advance a little, and print key facts plus consistency checks. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../server/db/connection';
import { loadWorld } from '../../server/db/repo';
import { advanceTime, createNewGame } from '../../server/game/game';
import { statement } from '../../server/game/queries';
import { confidenceTarget } from '../../server/engine/board';
import { liquidity } from '../../server/engine/metrics';
import { SCENARIOS } from '../../server/scenario/scenarios';
import { fmtEur } from '../../shared/money';

for (const sc of SCENARIOS) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'sc-')), 'g.sqlite'));
  createNewGame(db, 20270101, { scenario: sc.key });
  let w = loadWorld(db);
  const fc = w.meta.lastForecastSummary!;
  const st0 = statement(db, '2027-01-01', '2027-01-01');
  console.log(`\n== ${sc.name} (${sc.key})`);
  console.log(`cash ${fmtEur(w.balances['1000'])} liquidity ${fmtEur(liquidity(w))} rating ${w.meta.creditRating} conf ${w.meta.boardConfidence} target ${confidenceTarget(w).target}`);
  console.log(`forecast FY EBIT ${fmtEur(fc.fyEbitCents)} vs plan ${fmtEur(w.meta.boardPlan.ebitTargetCents)}; 12m low ${fmtEur(fc.minLiquidity12mCents ?? 0)}; Eon SOP ${fc.eonSopForecast ?? `blocked (${fc.eonSopConditional})`}`);
  console.log(`open issues: ${w.issues.filter((i) => !['resolved', 'closed'].includes(i.status)).map((i) => i.id).join(', ')}; negotiations: ${w.negotiations.map((n) => n.id).join(', ')}`);
  console.log(`BS check ${st0.reconciliation.balanceSheetCheck}; inbox ${(db.prepare('SELECT subject FROM inbox').all() as { subject: string }[]).map((r) => r.subject).join(' | ')}`);
  advanceTime(db, 60);
  w = loadWorld(db);
  const st = statement(db, '2027-01-01', '2027-02-28');
  console.log(`after 60 days: status ${w.meta.status}, cash ${fmtEur(w.balances['1000'])}, conf ${w.meta.boardConfidence}, recon diff ${st.reconciliation.difference}, BS ${st.reconciliation.balanceSheetCheck}; events: ${(db.prepare("SELECT title FROM events WHERE severity IN ('critical','warning') ORDER BY seq").all() as { title: string }[]).map((r) => r.title).slice(0, 6).join(' · ')}`);
}
