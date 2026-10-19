/**
 * Employees' own initiative. After every time advance, the executives:
 *  - report: monthly / quarterly reports to the CEO and to colleagues who need
 *    them (so the team works from the same figures);
 *  - propose: when their area needs a decision, they draft it for the CEO
 *    (it lands in Decisions → Your drafts; nothing happens until confirmed);
 *  - react: to the CEO's decisions (price moves, cuts, cancelled deals,
 *    signed contracts…) with a message, and with trust where it matters;
 *  - remind: of deadlines in their area (negotiations, unsigned agreements).
 * Everything is deterministic (rules on authoritative state) and rate-limited
 * through `meta.initiativeLog` so nobody repeats themselves.
 */
import type { ActionRecord, GameEvent } from '../../shared/domain';
import { addDays, diffDays, fmtDate, monthName } from '../../shared/dates';
import { fmtEur, mEur } from '../../shared/money';
import type { DB } from '../db/connection';
import { rowToAction } from '../db/repo';
import { modelMonthlyDemand } from '../engine/demand';
import { netLeverage } from '../engine/metrics';
import { adjustTrust, byId, emit, inbox, remember, type World } from '../engine/world';
import { staffingNeed } from '../actions/defs/people';
import { productionPlanFor } from '../guide/advisor';
import { unitEconomics } from '../reports/catalog';
import { recordDocument } from './documents';
import { proposeAction } from './game';

type Ctx = { db: DB; w: World; from: string; to: string };

const short = (n: string) => n.replace('Asterion ', '');
const first = (w: World, id: string) => byId(w.characters, id)?.name.split(' ').filter((x) => !/^Dr\.?$/.test(x))[0] ?? id;

function due(w: World, key: string, days: number): boolean {
  const last = w.meta.initiativeLog?.[key];
  return !last || diffDays(w.meta.currentDate, last) >= days;
}
function mark(w: World, key: string): void {
  w.meta.initiativeLog = { ...(w.meta.initiativeLog ?? {}), [key]: w.meta.currentDate };
}
const active = (w: World, id: string) => !!byId(w.characters, id)?.active;

/** A character sends reports to people (the CEO gets an inbox message with the reports attached). */
function report(c: Ctx, senderId: string, recipients: string[], reports: { key: string; param?: string | null }[], subject: string, memo: string): void {
  if (!active(c.w, senderId)) return;
  const to = recipients.filter((id) => id === 'ceo' || active(c.w, id));
  try {
    const doc = recordDocument(c.db, c.w, { reports, memo, recipientIds: to, senderId, quiet: to.length === 1 && to[0] === 'ceo' });
    if (to.includes('ceo')) inbox(c.w, { kind: 'report', fromId: senderId, subject, body: memo + (to.length > 1 ? `\n\n(Also sent to ${to.filter((x) => x !== 'ceo').map((id) => byId(c.w.characters, id)?.name).join(', ')}.)` : ''), priority: 'normal', linked: [], attachments: [doc.id] });
  } catch {
    /* a report that cannot be built yet is simply skipped */
  }
}

/** A character drafts a decision for the CEO and tells them why. */
function propose(c: Ctx, characterId: string, type: string, payload: Record<string, unknown>, subject: string, why: string): boolean {
  if (!active(c.w, characterId)) return false;
  // One open draft of a kind per person: no pile of identical suggestions.
  if (c.db.prepare("SELECT 1 FROM actions WHERE status = 'pending_confirmation' AND source = 'initiative' AND type = ? AND actor_id = ?").get(type, characterId)) return false;
  const a = proposeAction(c.db, { type, payload, actorId: characterId, source: 'initiative', rationale: why }, c.w);
  if (a.status !== 'pending_confirmation') return false;
  inbox(c.w, { kind: 'request', fromId: characterId, subject, body: `${why}\n\nI have prepared the decision for you: “${a.summary}”. It is waiting in Decisions → Your drafts — review the consequences and confirm, change or reject it.`, priority: 'high', linked: [] });
  return true;
}

function letter(c: Ctx, fromId: string, subject: string, body: string, opts: { trust?: number; priority?: 'low' | 'normal' | 'high' | 'urgent'; memory?: string } = {}): void {
  const ch = byId(c.w.characters, fromId);
  if (!ch || !ch.active) return;
  if (opts.trust) adjustTrust(c.w, ch.id, opts.trust);
  inbox(c.w, { kind: 'letter', fromId: ch.id, subject, body, priority: opts.priority ?? 'normal', linked: [{ type: 'character', id: ch.id }] });
  remember(c.w, { characterId: ch.id, kind: (opts.trust ?? 0) < 0 ? 'grievance' : 'observation', summary: opts.memory ?? `${subject}: ${body.slice(0, 200)}`, importance: 3, sentiment: Math.sign(opts.trust ?? 0), sourceType: 'initiative', sourceId: null, entityRefs: [] });
}

// ---------------------------------------------------------------- 1. regular reporting

function regularReports(c: Ctx): void {
  const { w } = c;
  const closed = w.snapshots.filter((s) => s.kind === 'month' && s.data.byAccount && s.date > c.from && s.date <= c.to).sort((a, b) => (a.period < b.period ? -1 : 1)).pop();
  if (!closed) return;
  const label = `${monthName(Number(closed.period.slice(5, 7)))} ${closed.period.slice(0, 4)}`;
  const ebit = closed.data.ebitCents;
  const quarter = ['03', '06', '09', '12'].includes(closed.period.slice(5, 7));
  report(c, 'CHR-HOLM', ['ceo', 'CHR-DUBREUIL'], [{ key: 'pnl' }, { key: 'cash' }], `${label} results`, `${label} closed with revenue of ${fmtEur(closed.data.revenueCents)} and an operating ${ebit >= 0 ? 'profit' : 'loss'} of ${fmtEur(Math.abs(ebit))}; cash at month end ${fmtEur(closed.data.cashCents)}. The breakdown and the cash position are attached${ebit < 0 ? ' — the cost categories show where the loss comes from' : ''}. I have copied the chair, as usual.`);
  const stock = w.models.filter((m) => m.status === 'in_production').map((m) => ({ m, days: Math.round(((m.dealerStock + m.fgUnits) / Math.max(1, modelMonthlyDemand(w, m, w.meta.currentDate))) * 30) }));
  const worst = stock.sort((a, b) => b.days - a.days)[0];
  report(c, 'CHR-GARNIER', ['ceo', 'CHR-MARCHETTI'], [{ key: 'sales' }], `Sales in ${label}`, `We sold ${closed.data.unitsRetail.toLocaleString('en-GB')} cars to customers in ${label}.${worst ? ` ${short(worst.m.name)}: ${worst.days} days of stock in the chain${worst.days > 70 ? ' — too many; we need to build fewer or push harder' : worst.days < 30 ? ' — we are short and losing sales' : ''}.` : ''} I have sent the same figures to Elena so production plans from the same numbers.`);
  if (quarter) {
    report(c, 'CHR-MARCHETTI', ['ceo', 'CHR-OKAFOR'], [{ key: 'production' }, { key: 'unit_economics' }], `Operations review — Q${Math.ceil(Number(closed.period.slice(5, 7)) / 3)} ${closed.period.slice(0, 4)}`, `Quarterly operations review: line rates against capacity, crews against need, and what each car costs us. Amara has it too, for the staffing plan.`);
    report(c, 'CHR-OKAFOR', ['ceo'], [{ key: 'workforce' }], 'Quarterly workforce report', 'Headcount, morale and the gaps between what each plant has and what the plan needs.');
    report(c, 'CHR-WIERZBICKI', ['ceo', 'CHR-HOLM'], [{ key: 'projects' }], 'Quarterly project review', 'Where every project stands and how the engineers are deployed. Margarethe has a copy for the cash plan.');
  }
}

// ---------------------------------------------------------------- 2. proposals

function proposals(c: Ctx): void {
  const { w } = c;
  const d = w.meta.currentDate;
  // Operations: production out of line with demand.
  for (const m of w.models.filter((x) => x.status === 'in_production')) {
    const plan = productionPlanFor(w, m);
    if (!plan || (plan.stockDays <= 75 && plan.stockDays >= 25)) continue;
    const line = w.lines.filter((l) => l.modelId === m.id && l.status === 'running').sort((a, b) => Math.abs((plan.targets[b.id] ?? b.plannedDailyRate) - b.plannedDailyRate) - Math.abs((plan.targets[a.id] ?? a.plannedDailyRate) - a.plannedDailyRate))[0];
    const target = line ? plan.targets[line.id] : undefined;
    if (!line || target === undefined || Math.abs(target - line.plannedDailyRate) < Math.max(30, line.plannedDailyRate * 0.08) || !due(w, `prod:${line.id}`, 45)) continue;
    if (propose(c, 'CHR-MARCHETTI', 'adjust_production', { lineId: line.id, plannedDailyRate: target, reason: `${short(m.name)} stock at ${plan.stockDays} days` }, `${short(m.name)}: ${target < line.plannedDailyRate ? 'we are building too many' : 'we are not building enough'}`, `The ${short(m.name)} chain holds ${plan.stockDays} days of stock against about 45 we need, with demand at roughly ${Math.round(plan.demand).toLocaleString('en-GB')} a month. I suggest ${line.name} goes from ${line.plannedDailyRate} to ${target} cars a day.`)) mark(w, `prod:${line.id}`);
  }
  // Sales: a campaign where there is stock to clear and margin to earn.
  const ue = unitEconomics(w);
  for (const m of w.models.filter((x) => x.status === 'in_production')) {
    const dem = modelMonthlyDemand(w, m, d);
    const days = ((m.dealerStock + m.fgUnits) / Math.max(1, dem)) * 30;
    const contribution = ue.find((u) => u.modelId === m.id)?.contributionCents ?? 0;
    if (days < 80 || contribution <= 0 || (w.meta.campaigns ?? []).some((x) => x.modelId === m.id && x.end >= d) || !due(w, `campaign:${m.id}`, 100)) continue;
    if (propose(c, 'CHR-GARNIER', 'launch_campaign', { modelId: m.id, spendCents: mEur(4), weeks: 6, name: `${short(m.name)} spring push`.replace('spring', ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][Number(d.slice(5, 7)) - 1]), reason: 'Clear excess stock' }, `A campaign for the ${short(m.name)}`, `We have ${Math.round(days)} days of ${short(m.name)} stock. A six-week, €4m campaign would move part of it — each extra car still earns about €${Math.round(contribution / 100).toLocaleString('en-GB')} before fixed costs.`)) mark(w, `campaign:${m.id}`);
  }
  // People: plants short of crews.
  for (const dep of w.departments.filter((x) => x.kind === 'plant')) {
    const need = staffingNeed(w, dep.id);
    if (need < 200 || dep.hiring.length || !due(w, `hire:${dep.id}`, 60)) continue;
    const n = Math.min(500, Math.ceil(need / 10) * 10);
    if (propose(c, 'CHR-OKAFOR', 'hire_staff', { departmentId: dep.id, headcount: n, reason: 'Crew shortfall for the production plan' }, `${dep.name}: we are short of people`, `${dep.name} is about ${need.toLocaleString('en-GB')} people short of what the production plan needs; output will fall short. Recruiting takes about six weeks for plant staff.`)) mark(w, `hire:${dep.id}`);
  }
  for (const dep of w.departments.filter((x) => x.kind === 'plant' && x.morale < 40)) {
    if (!due(w, `morale:${dep.id}`, 120)) continue;
    letter(c, 'CHR-OKAFOR', `Morale at ${dep.name}`, `Morale at ${dep.name} has fallen to ${Math.round(dep.morale)}/100. Absenteeism and the risk of unrest rise from here. A visit, a clear plan for the site, or the skills & ergonomics programme would help; more cuts without a plan would not.`, { priority: 'high' });
    mark(w, `morale:${dep.id}`);
  }
  // Finance: liquidity below the board's minimum and nothing in flight.
  const fc = w.meta.lastForecastSummary;
  const low = fc ? fc.minLiquidity12mCents : null;
  const inFlight = w.financing.some((f) => ['under_review', 'offered', 'pending_approval'].includes(f.status) && ['bond', 'bank_term_loan', 'rights_issue', 'sale_leaseback'].includes(f.kind));
  if (low !== null && low < w.meta.boardPlan.minLiquidityCents && !inFlight && due(w, 'funding', 60)) {
    const gap = w.meta.boardPlan.minLiquidityCents + mEur(100) - low;
    const amount = Math.max(mEur(300), Math.min(mEur(1000), Math.ceil(gap / mEur(50)) * mEur(50)));
    const kind = netLeverage(w) <= 3.8 ? 'bond' : 'rights_issue';
    if (propose(c, 'CHR-HOLM', 'request_financing', { kind, amountCents: amount, tenorYears: 6, rationale: 'Keep liquidity above the board minimum through the next 12 months' }, 'Our liquidity forecast', `The forecast's lowest liquidity over the next twelve months is ${fmtEur(low)}, below the board's minimum of ${fmtEur(w.meta.boardPlan.minLiquidityCents)}. I recommend we raise about ${fmtEur(amount)} ${kind === 'bond' ? 'with a bond' : 'in new equity — leverage is too high for bond investors'} now, while we still can on reasonable terms.`)) mark(w, 'funding');
  }
  // Engineering: idle engineers.
  const freeEng = Math.floor(w.departments.filter((x) => x.kind === 'engineering').reduce((a, x) => a + x.headcount, 0) - 1450 - w.projects.filter((p) => ['active', 'delayed', 'blocked', 'approved'].includes(p.status)).reduce((a, p) => a + p.staffingFte, 0));
  if (freeEng > 300 && due(w, 'engineers', 120)) {
    letter(c, 'CHR-WIERZBICKI', 'Engineers without a project', `${freeEng.toLocaleString('en-GB')} engineers are not assigned to any project — we pay them either way. There are good candidates in the catalogue (design-to-cost, quality, a model update), or you can design your own project (Projects → Start a project). Alternatively we stop backfilling departures.`);
    mark(w, 'engineers');
  }
}

// ---------------------------------------------------------------- 3. reminders

function reminders(c: Ctx): void {
  const { w } = c;
  const d = w.meta.currentDate;
  for (const n of w.negotiations.filter((x) => x.status === 'open' && x.deadline && diffDays(x.deadline, d) <= 21 && diffDays(x.deadline, d) >= 0)) {
    if (!due(w, `negdeadline:${n.id}`, 30)) continue;
    const owner = n.templateKey === 'labor_agreement' ? 'CHR-OKAFOR' : n.templateKey === 'dealer_agreement' ? 'CHR-GARNIER' : 'CHR-LINDQVIST';
    letter(c, owner, `Deadline: ${n.title}`, `The negotiation “${n.title}” expires on ${fmtDate(n.deadline!)} — ${diffDays(n.deadline!, d)} days from now. If we do not reach an agreement by then, the talks lapse. Make your best offer, or decide to walk away deliberately.`, { priority: 'high' });
    mark(w, `negdeadline:${n.id}`);
  }
}

// ---------------------------------------------------------------- 4. reactions to the CEO's decisions

const pctOf = (a: ActionRecord): number | null => {
  const m = a.consequences.map((x) => x.label).join(' ').match(/\(([+-]?\d+(?:\.\d+)?)%\)/);
  return m ? Number(m[1]) : null;
};

function reactions(c: Ctx, actions: ActionRecord[]): void {
  const { w } = c;
  for (const a of actions) {
    const p = a.payload as Record<string, unknown>;
    switch (a.type) {
      case 'change_price': {
        const pct = pctOf(a);
        const m = byId(w.models, String(p.modelId));
        if (pct === null || !m) break;
        if (pct <= -3) {
          letter(c, 'CHR-BELLINI', `${short(m.name)} price cut`, `My dealers welcome the lower ${short(m.name)} price — it will bring people into the showrooms. Just do not make a habit of it: customers learn to wait for the next cut.`, { trust: 1 });
          letter(c, 'CHR-HOLM', `Margin on the ${short(m.name)}`, `A ${Math.abs(pct).toFixed(1)}% cut gives up about ${fmtEur(Math.round((m.netPriceCents * Math.abs(pct)) / (100 - Math.abs(pct))))} per car. It pays only if volume rises by more than that costs; I will watch the monthly numbers.`);
        } else if (pct >= 3) {
          letter(c, 'CHR-GARNIER', `${short(m.name)} price increase`, `We will defend the higher ${short(m.name)} price, but expect fewer orders — our rivals will not follow us up.`);
          letter(c, 'CHR-BELLINI', `${short(m.name)} price increase`, `A ${pct.toFixed(1)}% increase makes the ${short(m.name)} harder to sell against the competition. My members will feel it first.`, { trust: -1 });
        }
        break;
      }
      case 'set_marketing_budget': {
        const pct = pctOf(a);
        const old = (a.summary.match(/€([\d.]+)m\/month →/) ?? [])[1];
        const now = Number(p.monthlyCents ?? 0);
        const before = old ? Number(old) * 1e8 : null;
        if (before && now < before * 0.75) letter(c, 'CHR-GARNIER', 'The marketing cut', `Cutting marketing to ${fmtEur(now)} a month saves money now and costs demand later — about ${Math.round((1 - Math.pow(now / before, 0.12)) * 100)}% of our orders by my estimate. If cash forces it, so be it, but let us review it in a quarter.`, { trust: -2 });
        else if (before && now > before * 1.5) letter(c, 'CHR-HOLM', 'Marketing spend', `The higher marketing budget adds ${fmtEur((now - before) * 12)} a year of cost. Please let us measure what it brings — the marketing performance report shows the estimate.`);
        void pct;
        break;
      }
      case 'restructure_workforce': {
        const dep = byId(w.departments, String(p.departmentId));
        const n = Number(p.reduction ?? 0);
        if (p.mode === 'compulsory') {
          letter(c, 'CHR-NOVAK', `Compulsory redundancies at ${dep?.name ?? 'the plant'}`, `You have announced ${n.toLocaleString('en-GB')} compulsory redundancies. The union will contest every one of them in the consultation. If there was another way, you did not look hard enough.`, { trust: -4, priority: 'urgent' });
          letter(c, 'CHR-PETIT', 'The redundancies', `As the employees' representative on the board, I must tell you the mood on the shop floor is very bad. I will ask the board to hear how the consultation is conducted.`, { trust: -3 });
        } else if (n > 0) {
          letter(c, 'CHR-OKAFOR', 'Voluntary departure programme', `We will open the voluntary programme (${n.toLocaleString('en-GB')} places) with the works council. Voluntary schemes cost more per head but keep the peace; consultation takes 60 days.`);
        }
        break;
      }
      case 'hire_staff': {
        const n = Number(p.headcount ?? 0);
        const dep = byId(w.departments, String(p.departmentId));
        if (n >= 300 && dep) letter(c, 'CHR-HOLM', `${n} new hires`, `${n.toLocaleString('en-GB')} hires at ${dep.name} add about ${fmtEur(Math.round(n * dep.annualCostPerHeadCents * w.meta.wageIndex))} a year to payroll. Worth it if the volume is there to use them.`);
        break;
      }
      case 'sign_contract': {
        const k = w.contracts.find((x) => x.id === p.contractId);
        if (!k) break;
        if (k.templateKey === 'voltaris_supply') letter(c, 'CHR-FERRER', 'Battery supply signed', 'With the Voltaris amendment signed I can finally plan the Eon ramp-up on real pack volumes. Thank you — the team needed this.', { trust: 2 });
        else if (k.kind === 'labor') letter(c, 'CHR-MARCHETTI', 'Wage agreement signed', 'With the agreement signed we have peace at the plants for its term. That is worth a lot to operations.', { trust: 1 });
        else if (k.templateKey === 'hanseatic_second_source') letter(c, 'CHR-LINDQVIST', 'Second battery source', 'We now have a second source for Eon packs. Voltaris will notice — our position with them is stronger.', { trust: 2 });
        else if (k.templateKey && k.counterpartyId) letter(c, k.counterpartyId, `Signed: ${k.title}`, 'Thank you — we look forward to working together on these terms.', { trust: 1 });
        break;
      }
      case 'withdraw_negotiation': {
        const n = w.negotiations.find((x) => x.id === p.negotiationId);
        if (!n) break;
        const owner = n.templateKey === 'labor_agreement' ? 'CHR-OKAFOR' : n.templateKey === 'voltaris_supply' ? 'CHR-FERRER' : n.templateKey === 'dealer_agreement' ? 'CHR-GARNIER' : 'CHR-LINDQVIST';
        letter(c, owner, `You ended the talks: ${n.title}`, n.templateKey === 'voltaris_supply' ? 'Without more Voltaris packs the Eon cannot ramp up. I hope there is a plan B — the second source takes months to qualify.' : n.templateKey === 'labor_agreement' ? 'Ending the wage talks leaves us without a peace obligation. Expect the union to escalate.' : `I had put a lot of work into these talks. I would like to understand the reason, so I can explain it to ${byId(w.characters, n.counterpartyId)?.orgName ?? 'them'}.`, { trust: -2 });
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- 5. agreements left unsigned lapse

function lapseUnsigned(c: Ctx, signing: { has(id: string): boolean }): void {
  const { w } = c;
  const d = w.meta.currentDate;
  for (const k of w.contracts.filter((x) => x.status === 'agreed' && x.agreedDate && !signing.has(x.id))) {
    const age = diffDays(d, k.agreedDate!);
    if (age >= 45) {
      k.status = 'expired';
      const n = w.negotiations.find((x) => x.contractId === k.id);
      if (n) n.status = 'expired';
      if (k.counterpartyId) adjustTrust(w, k.counterpartyId, -6);
      emit(w, { type: 'agreement_lapsed', category: 'negotiation', severity: 'warning', title: `Agreement lapsed: ${k.title}`, description: `Agreed on ${k.agreedDate} but never signed; ${k.counterpartyName} has withdrawn.`, causeKind: 'causal', entities: [{ type: 'contract', id: k.id }] });
      if (k.counterpartyId) letter(c, k.counterpartyId, `${k.title}: we withdraw`, `We agreed terms ${age} days ago and you never signed. We cannot keep capacity and prices on hold indefinitely, so we withdraw. If you want to talk again, the terms will have to be renegotiated.`, { priority: 'high' });
    } else if (age >= 20 && due(w, `unsigned:${k.id}`, 30)) {
      letter(c, 'CHR-LAURENT', `Unsigned: ${k.title}`, `The agreement with ${k.counterpartyName} was reached on ${fmtDate(k.agreedDate!)} and is still not signed. Until it is, none of its terms bind either side — and counterparties usually withdraw after about 45 days (${fmtDate(addDays(k.agreedDate!, 45))}). Legal has reviewed it; it is ready for your signature.`, { priority: 'high' });
      mark(w, `unsigned:${k.id}`);
    }
  }
}

/** Run after each time advance, inside its transaction. */
export function runInitiative(db: DB, w: World, from: string, events: GameEvent[], signing: { has(id: string): boolean }): void {
  if (w.meta.status !== 'active' || w.mode !== 'live') return;
  const c: Ctx = { db, w, from, to: w.meta.currentDate };
  const since = w.meta.initiativeLog?.lastRunAt ?? '0000';
  const decided = (db.prepare("SELECT * FROM actions WHERE status = 'committed' AND source = 'player' AND updated_at > ? ORDER BY updated_at").all(since) as Record<string, unknown>[]).map(rowToAction);
  // Suggestions nobody acted on for a month lapse (the situation has moved on).
  db.prepare("UPDATE actions SET status = 'expired', updated_at = ? WHERE status = 'pending_confirmation' AND source = 'initiative' AND sim_date < ?").run(new Date().toISOString(), addDays(w.meta.currentDate, -30));
  reactions(c, decided);
  regularReports(c);
  proposals(c);
  reminders(c);
  lapseUnsigned(c, signing);
  w.meta.initiativeLog = { ...(w.meta.initiativeLog ?? {}), lastRunAt: new Date().toISOString() };
  void events;
}
