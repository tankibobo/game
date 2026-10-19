/** Complete the Lyon automation and the online sales platform; print what changed and who reacted. */
import { loadWorld } from '../../server/db/repo';
import { advanceTime, confirmAction, createNewGame, proposeAction } from '../../server/game/game';
import { openDb } from '../../server/db/connection';
import { tempFile } from '../../tests/helpers';
const db = openDb(tempFile());
createNewGame(db, 21, { scenario: 'steady_start', difficulty: 'relaxed' });
for (const k of ['lyon_cost_down', 'direct_sales']) {
  const a = proposeAction(db, { type: 'start_project', payload: { templateKey: k }, rationale: 'Test' });
  console.log(k, a.status, a.errors.join(' '));
  if (a.status === 'pending_confirmation') console.log(' ', confirmAction(db, a.id, 'ceo', { boardRationale: 'A clear, factual case for the board.' }).message);
}
const start = loadWorld(db).meta.currentDate;
for (let i = 0; i < 15; i++) {
  if (loadWorld(db).meta.status !== 'active') { console.log('GAME OVER', loadWorld(db).meta.terminalReason); break; }
  advanceTime(db, 31);
  const w = loadWorld(db);
  const ps = w.projects.filter((p) => ['lyon_cost_down', 'direct_sales'].includes(p.templateKey ?? ''));
  if (ps.every((p) => p.status === 'completed')) break;
}
const w = loadWorld(db);
for (const p of w.projects.filter((p) => ['lyon_cost_down', 'direct_sales'].includes(p.templateKey ?? ''))) console.log(`\n${p.name}: ${p.status} ${p.completedDate}\n  ${p.impact.join('\n  ')}`);
console.log('\nFEATURES', w.models.map((m) => `${m.name}: ${m.features.join(' | ')}`));
const mail = db.prepare("SELECT date, from_id, subject, substr(body,1,220) b FROM inbox WHERE date >= ? AND from_id IN ('CHR-NOVAK','CHR-BELLINI','CHR-MARCHETTI','CHR-GARNIER','CHR-WIERZBICKI') AND kind != 'briefing' ORDER BY rowid").all(start) as any[];
for (const m of mail) console.log(`✉ ${m.date} ${m.from_id}: ${m.subject}\n    ${m.b.replace(/\n/g, ' ')}`);
console.log('\nTEMPLATE STATUS', ['lyon_cost_down', 'direct_sales'].map((k) => proposeAction(db, { type: 'start_project', payload: { templateKey: k } }).errors.join(' ')));
