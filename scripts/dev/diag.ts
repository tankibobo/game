/** Board-vote diagnostic: what would the board do with typical proposals at the start of the game? */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../server/db/connection';
import { loadWorld } from '../../server/db/repo';
import { createNewGame, proposeAction, rejectAction } from '../../server/game/game';
import { predictVote, liquidityTightness } from '../../server/engine/board';
import { ACTION_BY_TYPE } from '../../server/actions/registry';

const db = openDb(join(mkdtempSync(join(tmpdir(), 'diag-')), 'g.sqlite'));
createNewGame(db);
const w0 = loadWorld(db);
console.log('tightness', liquidityTightness(w0).toFixed(2), 'confidence', w0.meta.boardConfidence);
const tests: [string, unknown][] = [
  ['start_project', { templateKey: 'vela_hybrid_refresh' }],
  ['hire_staff', { departmentId: 'DEP-BRNO', headcount: 900 }],
  ['hire_staff', { departmentId: 'DEP-LYON', headcount: 600 }],
  ['hire_staff', { departmentId: 'DEP-LTC', headcount: 600 }],
  ['restructure_workforce', { departmentId: 'DEP-LYON', reduction: 300, mode: 'voluntary' }],
  ['restructure_workforce', { departmentId: 'DEP-LYON', reduction: 1200, mode: 'compulsory' }],
  ['restructure_workforce', { departmentId: 'DEP-CORP', reduction: 350, mode: 'voluntary' }],
  ['start_project', { templateKey: 'lyon_cost_down' }],
  ['start_project', { templateKey: 'kora_premium' }],
  ['start_project', { templateKey: 'brno_eon_expansion' }],
  ['request_financing', { kind: 'bond', amountCents: 500e8, tenorYears: 5, rationale: 'refinance 2028 notes' }],
  ['request_financing', { kind: 'rights_issue', amountCents: 300e8, rationale: 'equity cushion' }],
  ['request_financing', { kind: 'sale_leaseback', amountCents: 150e8, rationale: 'HQ sale' }],
  ['cancel_project', { projectId: 'PRJ-EON', reason: 'too risky' }],
];
for (const [type, payload] of tests) {
  const a = proposeAction(db, { type, payload });
  const w = loadWorld(db);
  const def = ACTION_BY_TYPE.get(type)!;
  const needBoard = a.approvals.some((x) => x.approver === 'board' && x.kind === 'required');
  let line = `${type} ${JSON.stringify(payload)} → ${a.status}${a.errors.length ? ` ERR ${a.errors.join(' ')}` : ''}`;
  if (a.status !== 'invalid' && needBoard && def.boardAnalysis) {
    const o = predictVote(w, def.boardAnalysis(w, a.payload) as never, '');
    line += `\n   ${o.outlook} (${o.forCount} for / ${o.againstCount} against / ${o.leaningCount} undecided)\n` + o.members.map((m) => `     ${m.name.padEnd(20)} ${m.lean.padEnd(9)} ${m.score.toFixed(2)}  ${m.reason}`).join('\n');
  } else if (a.status !== 'invalid') line += ' (no board needed)';
  console.log(line);
  if (a.status === 'pending_confirmation') rejectAction(db, a.id);
}
