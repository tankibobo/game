import { newGameDb, noLlm } from '../../tests/helpers';
import { loadWorld } from '../../server/db/repo';
import { submitOffer } from '../../server/llm/conversation';
import { proposeAction, confirmAction, advanceTime } from '../../server/game/game';
const { db } = newGameDb();
let res = await submitOffer(db, noLlm, 'NEG-VOLTARIS', { dailyVolume: 300, priceEur: 9_350, prepaymentM: 60, takeOrPayPct: 75 }, 'We can commit volume for three years; Hanseatic is our alternative if we cannot agree.');
console.log(res.outcome, res.reply.content, (res.reply.structured as any).negotiation);
let guard = 0;
while (res.outcome === 'countered' && guard++ < 6) {
  const n = loadWorld(db).negotiations.find((x) => x.id === 'NEG-VOLTARIS')!;
  const counter = n.rounds[n.rounds.length - 1].terms;
  console.log('counter', counter);
  res = await submitOffer(db, noLlm, 'NEG-VOLTARIS', counter, 'We accept your proposal.');
  console.log(res.outcome);
}
const w = loadWorld(db);
const c = w.contracts.find((c) => c.negotiationId === 'NEG-VOLTARIS')!;
const s = proposeAction(db, { type: 'sign_contract', payload: { contractId: c.id } });
console.log(s.status, s.approvals);
const r = confirmAction(db, s.id, 'ceo', { boardRationale: 'Secures Eon battery supply for 300 packs a day.' });
console.log(r.message);
const t = advanceTime(db, 30, 'x1');
const w2 = loadWorld(db);
console.log(w2.contracts.find((x) => x.id === c.id)!.status, w2.boardProposals.map((b) => [b.title, b.status, b.votes.map((v) => v.vote + ':' + v.score)]), w2.supplies.find((x) => x.id === 'SPL-VOL-PACK'));
console.log(w2.projects.find(p=>p.id==='PRJ-EON')!.forecastDate, w2.meta.lastForecastSummary);
