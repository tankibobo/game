/**
 * The Coach: a deterministic analysis of the current game that says what to
 * do next and why. Every piece of advice is computed from authoritative state
 * (never invented) and, where possible, carries a ready-made decision the
 * player can preview with one click. The automated test player follows the
 * same advice, which is how we check that the advice actually wins games.
 */
import { addDays, diffDays } from '../../shared/dates';
import { fmtEur, mEur } from '../../shared/money';
import type { DB } from '../db/connection';
import { rowToAction } from '../db/repo';
import { confidenceTarget, meetingForSubmission, upcomingMeeting } from '../engine/board';
import { co2Target, fleetCo2Ytd } from '../engine/close';
import { modelMonthlyDemand } from '../engine/demand';
import { difficultyOf } from '../engine/difficulty';
import { mandateObjectives, mandateScore } from '../engine/mandate';
import { engineeringFreeFte, interestCover, liquidity, netLeverage, rcf } from '../engine/metrics';
import { byId, type World } from '../engine/world';
import { staffingNeed } from '../actions/defs/people';
import { templateStatus } from '../game/decisions';

export interface AdviceAction {
  type: string;
  payload: Record<string, unknown>;
  label: string;
  /** A case for the board, used when the decision needs board approval. */
  rationale?: string;
}

export interface Advice {
  id: string;
  /** 1 = do it now … 4 = when you have time. */
  priority: 1 | 2 | 3 | 4;
  area: 'board' | 'eon' | 'vela' | 'operations' | 'people' | 'finance' | 'deals' | 'promises';
  title: string;
  why: string;
  steps: string[];
  action?: AdviceAction;
  link?: { page: string; param?: string | null; label: string };
  deadline?: string | null;
}

export interface CoachReport {
  date: string;
  scenario: string;
  confidence: { now: number; target: number; projectedNextMeeting: number; nextMeeting: string; threshold: number; strikes: number; strikesAllowed: number; drivers: { label: string; delta: number }[] };
  mandate: { score: number; passScore: number; termEnd: string; objectives: ReturnType<typeof mandateObjectives> };
  headline: string;
  advice: Advice[];
  principles: string[];
}

const P = (n: number) => n as 1 | 2 | 3 | 4;

function pendingTypes(db: DB): { type: string; payload: Record<string, unknown>; status: string; id: string }[] {
  return (db.prepare("SELECT * FROM actions WHERE status IN ('pending_confirmation','pending_approval','approved')").all() as Record<string, unknown>[]).map(rowToAction);
}

/**
 * Production plan for a model: smoothed demand over the next three months,
 * stock in the whole chain (factory, transit, dealers) and per-line daily
 * rates that bring stock back to ~45 days over about five months (gradually,
 * so that factories and margins are not shocked).
 */
export function productionPlanFor(w: World, m: World['models'][number]): { demand: number; stock: number; stockDays: number; targets: Record<string, number> } | null {
  const d = w.meta.currentDate;
  const lines = w.lines.filter((l) => l.modelId === m.id && l.status === 'running');
  if (!lines.length) return null;
  const demand = [0, 30, 60].reduce((a, k) => a + modelMonthlyDemand(w, m, addDays(d, k)), 0) / 3;
  if (demand <= 0) return null;
  const stock = m.dealerStock + m.fgUnits + m.inTransit;
  const stockDays = Math.round((stock / demand) * 30);
  const wanted = Math.max(0, demand + (demand * 1.5 - stock) / 5);
  const capacity = lines.reduce((a, l) => a + l.maxDailyRate, 0);
  const daily = Math.min(capacity, wanted / 21.5);
  const targets: Record<string, number> = {};
  for (const l of lines) targets[l.id] = Math.min(l.maxDailyRate, Math.max(0, Math.round((daily * (l.maxDailyRate / capacity)) / 5) * 5));
  return { demand, stock, stockDays, targets };
}

export function coachReport(db: DB, w: World): CoachReport {
  const d = w.meta.currentDate;
  const dset = difficultyOf(w);
  const adv: Advice[] = [];
  const pending = pendingTypes(db);
  const inFlight = (type: string, pred: (p: Record<string, unknown>) => boolean = () => true) => pending.some((a) => a.type === type && a.status !== 'pending_confirmation' && pred(a.payload));
  const meeting = upcomingMeeting(w);
  const submitBy = meetingForSubmission(w);

  // ---- board confidence projection
  const ct = confidenceTarget(w);
  const now = w.meta.boardConfidence;
  const projected = Math.round((now + (ct.target - now) * dset.meetingPull) * 10) / 10;
  const drivers = ct.factors.filter((f) => Math.abs(f.delta) >= 1).sort((a, b) => a.delta - b.delta);

  // ---- open contracts to sign, offers to accept, approvals waiting
  for (const c of w.contracts.filter((x) => x.status === 'agreed')) {
    adv.push({ id: `sign-${c.id}`, priority: P(1), area: 'deals', title: `Sign the agreement: ${c.title}`, why: 'An agreement reached at the table does nothing until it is signed — the other side can still walk away.', steps: ['Click “Preview this decision” below, read the cost, then confirm (or submit to the board if it asks).'], action: { type: 'sign_contract', payload: { contractId: c.id }, label: `Sign ${c.title}`, rationale: `This agreement was negotiated to resolve a critical constraint: ${c.summary}` }, link: { page: 'inbox', param: 'contracts', label: 'Contracts' } });
  }
  for (const f of w.financing.filter((x) => x.status === 'offered' && x.offer)) {
    adv.push({ id: `accept-${f.id}`, priority: P(1), area: 'finance', title: `Accept the financing offer from ${f.counterparty}`, why: `${fmtEur(f.offer!.amountCents)} at ${(f.offer!.rateBps / 100).toFixed(2)}% — the offer expires on ${f.offer!.validUntil}. Money only arrives once you accept.`, steps: ['Preview the acceptance, check the cost and covenants, then confirm.'], action: { type: 'accept_financing', payload: { financingId: f.id }, label: 'Accept the offer' }, deadline: f.offer!.validUntil });
  }
  for (const a of pending.filter((x) => x.status === 'approved')) {
    adv.push({ id: `waiting-${a.id}`, priority: P(2), area: 'board', title: 'A board-approved decision is waiting', why: 'The board approved it, but it could not be carried out yet. Fix the cause shown in Decisions → In progress, then click “Execute now”.', steps: ['Open Decisions → In progress and read the reason.', 'Usually: free engineers by re-planning another project, or hire engineers.'], link: { page: 'decisions', param: 'progress', label: 'In progress' } });
  }

  // ---- Eon battery supply
  const volIssue = byId(w.issues, 'ISS-VOLTARIS');
  const volNeg = w.negotiations.find((n) => n.templateKey === 'voltaris_supply' && n.status === 'open');
  if (volIssue && !['resolved', 'closed'].includes(volIssue.status) && !w.contracts.some((c) => c.templateKey === 'voltaris_supply' && c.status === 'agreed')) {
    adv.push({
      id: 'eon-supply',
      priority: P(1),
      area: 'eon',
      title: 'Secure battery supply for the Eon',
      why: `Without at least 250 packs a day the Eon cannot reach production — the forecast shows its launch as “blocked”, which costs board confidence every month (−4 now, −10 after April) and puts the EIB loan condition (production by March 2028) at risk.`,
      steps: [
        volNeg ? 'Open Inbox & meetings → Negotiations → Voltaris volume & capacity amendment.' : 'Voltaris talks are closed — start the second battery source project (Decisions → Projects & issues) or the Hanseatic second-source negotiation (Deals).',
        'Offer about 300 packs/day. Voltaris opened at €9,650/pack, €80m prepayment and 85% take-or-pay; a realistic landing zone is roughly €9,100–9,400, €40–60m and 60–70%.',
        'Argue with facts: committed Eon volumes, the funding the deal gives their second line, and a credible alternative (a second battery source in progress makes them softer).',
        'Concede a little each round rather than meeting them halfway at once. When they accept, sign the agreement — it needs the board because of the prepayment.',
      ],
      link: volNeg ? { page: 'inbox', param: volNeg.id, label: 'Voltaris negotiation' } : { page: 'decisions', param: 'projects', label: 'Projects & issues' },
      deadline: volNeg?.deadline ?? null,
    });
  }

  // ---- Eon validation issues
  const thermal = byId(w.issues, 'ISS-THERMAL');
  if (thermal && !['resolved', 'closed'].includes(thermal.status) && !thermal.chosenOptions.length) {
    adv.push({ id: 'eon-thermal', priority: P(1), area: 'eon', title: 'Fix the Eon thermal-propagation problem', why: 'Battery-system validation cannot be signed off until this issue is resolved; it absorbs a quarter of the Eon team. The redesign removes most of the remaining risk for €14m.', steps: ['Preview the “Redesign inter-module thermal barrier” option and confirm.', 'If the Eon is still late later on, add the external test lab as well.'], action: { type: 'address_issue', payload: { issueId: 'ISS-THERMAL', optionKey: 'barrier_redesign' }, label: 'Redesign the thermal barrier (€14m)' }, deadline: thermal.deadline });
  }
  const bms = byId(w.issues, 'ISS-EON-BMS');
  if (bms && !['resolved', 'closed'].includes(bms.status) && !bms.chosenOptions.length && bms.options.some((o) => o.key === 'software_house')) {
    adv.push({ id: 'eon-bms', priority: P(2), area: 'eon', title: 'Clear the Eon battery-software backlog', why: 'A 1,900-case test backlog slows the Eon; contractors clear it for €4.5m.', steps: ['Preview “Contract an external software house” and confirm.'], action: { type: 'address_issue', payload: { issueId: 'ISS-EON-BMS', optionKey: 'software_house' }, label: 'Hire the software house (€4.5m)' }, deadline: bms.deadline });
  }

  // ---- Vela / Euro 7
  const vela = byId(w.models, 'MDL-VELA');
  const cutoff = String(byId(w.regulations, 'REG-EURO7')?.params.allNewCarsDate ?? '2027-11-29');
  const e7 = w.projects.find((p) => p.templateKey === 'vela_euro7');
  const vprog = w.projects.find((p) => (p.templateKey === 'vela_euro7' || p.templateKey === 'vela_hybrid_refresh') && !['cancelled', 'proposed'].includes(p.status));
  const vpending = inFlight('start_project', (p) => p.templateKey === 'vela_hybrid_refresh') || inFlight('approve_project', (p) => p.projectId === e7?.id);
  if (vela && vela.status === 'in_production' && !vela.euro7Compliant && !vprog && !vpending && d < cutoff) {
    const hybrid = templateStatus(w, 'vela_hybrid_refresh');
    const daysLeft = diffDays(cutoff, d);
    const hybridFits = hybrid.available && daysLeft > 300;
    adv.push({
      id: 'vela-euro7',
      priority: P(1),
      area: 'vela',
      title: 'Make the Vela Euro 7 compliant before the cut-off',
      why: `From ${cutoff} an uncertified Vela cannot be registered in the EU — about 130,000 sales a year would stop. ${daysLeft} days left; the compliance project takes about 10 months.`,
      steps: e7?.status === 'proposed'
        ? ['Approve the “Vela Euro 7 compliance” project (€42m, 160 engineers) — the cheapest safe route, within your authority.', hybridFits ? 'Alternative: the mild-hybrid refresh (€165m, needs the board) also cuts CO₂ and lifts demand, but only if started at the January board meeting.' : 'It is too late for the mild-hybrid refresh to beat the cut-off.']
        : ['Start the “Vela mild-hybrid refresh” (Decisions → Projects & issues).'],
      action: e7?.status === 'proposed' ? { type: 'approve_project', payload: { projectId: e7.id }, label: 'Approve Vela Euro 7 compliance (€42m)' } : { type: 'start_project', payload: { templateKey: 'vela_hybrid_refresh' }, label: 'Start the Vela mild-hybrid refresh', rationale: 'Euro 7 is mandatory from 29 Nov 2027; without it the Vela cannot be sold.' },
      deadline: cutoff,
    });
  }

  // ---- Production discipline: build what dealers sell, keep ~45 days of stock
  for (const m of w.models.filter((x) => x.status === 'in_production')) {
    const lines = w.lines.filter((l) => l.modelId === m.id && l.status === 'running');
    if (!lines.length) continue;
    const plan = productionPlanFor(w, m);
    if (!plan) continue;
    const { demand, stock, stockDays, targets } = plan;
    for (const line of lines) {
      const target = targets[line.id];
      if (target === undefined) continue;
      if (Math.abs(target - line.plannedDailyRate) < Math.max(20, line.plannedDailyRate * 0.06)) continue;
      const cut = target < line.plannedDailyRate;
      adv.push({
        id: `rate-${line.id}`,
        priority: P(cut && stockDays > 75 ? 1 : 2),
        area: 'operations',
        title: `${cut ? 'Build fewer' : 'Build more'} ${m.name.replace('Asterion ', '')}s: ${line.name} ${line.plannedDailyRate} → ${target} a day`,
        why: `Demand for the ${m.name.replace('Asterion ', '')} over the next three months averages about ${Math.round(demand).toLocaleString('en-GB')} cars a month; dealers and the factory hold ${stock.toLocaleString('en-GB')} (≈${stockDays} days; aim for ~45). ${cut ? 'Every surplus car ties up about €14k of cash and ends up discounted.' : 'Dealers are running short — you are losing sales.'}`,
        steps: ['Preview the new rate and confirm. Check again every month or two: demand moves with prices, competitors and the season.'],
        action: { type: 'adjust_production', payload: { lineId: line.id, plannedDailyRate: target, reason: 'Match production to demand (Coach)' }, label: `Set ${line.name} to ${target}/day` },
      });
    }
  }

  // ---- People: union, crews, surplus
  const union = w.negotiations.find((n) => n.templateKey === 'labor_agreement' && n.status === 'open');
  if (union) {
    adv.push({
      id: 'union',
      priority: P(diffDays(union.deadline ?? addDays(d, 365), d) < 75 ? 1 : 2),
      area: 'people',
      title: 'Settle the wage agreement with the union',
      why: `Without a signed agreement there is no peace obligation: the union can strike (2–4 days of lost production at all plants each time). The negotiation deadline is ${union.deadline}.`,
      steps: [
        'Open Inbox & meetings → Negotiations → Collective wage agreement.',
        'The union opened at 6.0%, €1,200 and a 48-month job guarantee. Deals usually land around 4–5%, €600–900 and 24–36 months. Start low (≈3–3.5%), concede in small steps, and explain the company’s situation with facts.',
        'A job guarantee costs nothing if you only plan voluntary departures — but it rules out compulsory redundancies at the plants.',
        'After the members’ ballot, sign the agreement (Contracts).',
      ],
      link: { page: 'inbox', param: union.id, label: 'Union negotiation' },
      deadline: union.deadline,
    });
  }
  if (!union) {
    const labour = w.contracts.filter((c) => c.kind === 'labor' && c.status === 'active' && c.signedDate && c.signedDate >= '2027-01-01' && c.endDate && c.endDate >= d).sort((a, b) => String(b.endDate).localeCompare(String(a.endDate)))[0];
    const awaiting = w.contracts.some((c) => c.kind === 'labor' && c.status === 'agreed');
    if (!awaiting && (!labour || diffDays(String(labour.endDate), d) <= 180)) {
      const strike = byId(w.issues, 'ISS-STRIKE');
      adv.push({
        id: 'union-renew',
        priority: P(!labour || (strike && strike.status !== 'resolved') ? 1 : 2),
        area: 'people',
        title: labour ? `Open talks on the next wage agreement (current one ends ${labour.endDate})` : 'Reopen wage talks with the union — no agreement is in force',
        why: 'Without a collective agreement there is no peace obligation: the union can call rolling strikes that stop all three plants for days at a time, every month.',
        steps: ['Preview “Open negotiation” for the collective wage agreement and confirm — it is your decision.', 'Then negotiate as before: start around 3–3.5%, concede in small steps, explain the company’s situation, and sign after the members’ ballot.'],
        action: { type: 'open_negotiation', payload: { templateKey: 'labor_agreement' }, label: 'Open wage negotiation' },
      });
    }
  }
  const brnoNeed = staffingNeed(w, 'DEP-BRNO');
  if (brnoNeed > 60 && !inFlight('hire_staff', (p) => p.departmentId === 'DEP-BRNO')) {
    const n = Math.min(500, Math.ceil(brnoNeed / 10) * 10);
    adv.push({ id: 'hire-brno', priority: P(2), area: 'people', title: `Hire ${n} people at Brno for the Eon ramp-up`, why: `Brno is short of about ${brnoNeed} people for its production plan (the Eon line needs crews from launch). Plants hire in ~45 days.`, steps: [`Preview “Hire ${n}” for Brno and confirm (up to 500 is your decision).`, brnoNeed > 500 ? 'Hire the rest next month, or put a larger number to the board.' : ''].filter(Boolean), action: { type: 'hire_staff', payload: { departmentId: 'DEP-BRNO', headcount: n, reason: 'Eon ramp-up crews (Coach)' }, label: `Hire ${n} at Brno` } });
  }
  const lyonSurplus = -staffingNeed(w, 'DEP-LYON');
  const lyon = byId(w.departments, 'DEP-LYON');
  if (lyonSurplus > 250 && lyon && lyon.leaving.length === 0 && !inFlight('restructure_workforce') && w.lines.find((l) => l.id === 'LINE-LYON-VELA')?.plannedDailyRate !== undefined) {
    const n = Math.min(300, Math.floor(lyonSurplus / 10) * 10);
    adv.push({ id: 'lyon-surplus', priority: P(3), area: 'people', title: `Reduce Lyon’s surplus crew by ${n} (voluntary)`, why: `At its current production rate Lyon has about ${lyonSurplus} more people than it needs — roughly ${fmtEur(Math.round(lyonSurplus * 64_000 * 100))} a year of payroll. A voluntary programme up to 300 is your decision and angers the union less.`, steps: ['Preview the voluntary programme and confirm; people leave after 60 days of consultation.', 'Avoid compulsory cuts if you gave the union a job guarantee.'], action: { type: 'restructure_workforce', payload: { departmentId: 'DEP-LYON', reduction: n, mode: 'voluntary', reason: 'Align Lyon crew with the production plan (Coach)' }, label: `Voluntary programme: −${n} at Lyon` } });
  }

  // ---- Funding plan: refinance maturities, keep the 12-month low above the board minimum
  const refi = byId(w.issues, 'ISS-REFI');
  const bond = byId(w.debts, 'DEBT-BOND28');
  const fc0 = w.meta.lastForecastSummary;
  const low0 = fc0 ? (fc0.minLiquidity12mCents ?? fc0.minLiquidityCents) : liquidity(w);
  const raising = ['bond', 'bank_term_loan', 'rights_issue', 'sale_leaseback', 'shareholder_loan'];
  const flight = w.financing.filter((f) => raising.includes(f.kind) && ['under_review', 'offered', 'accepted', 'pending_approval'].includes(f.status)).reduce((a, f) => a + (f.offer?.amountCents ?? f.requestedCents), 0)
    + pending.filter((a) => a.type === 'request_financing' && a.status !== 'pending_confirmation' && raising.includes(String(a.payload.kind))).reduce((a, x) => a + Number(x.payload.amountCents ?? 0), 0);
  const refiOpen = !!refi && !['resolved', 'closed'].includes(refi.status) && bond?.status === 'active';
  const refiGap = refiOpen ? mEur(700) - Number(refi!.data.securedCents ?? 0) : 0;
  const buffer = w.meta.boardPlan.minLiquidityCents + mEur(100);
  const liqGap = buffer - low0;
  const need = Math.max(refiGap, liqGap) - flight;
  const lev = netLeverage(w);
  const bondPending = w.financing.some((f) => f.kind === 'bond' && ['under_review', 'offered', 'pending_approval'].includes(f.status)) || inFlight('request_financing', (p) => p.kind === 'bond');
  const loanPending = w.financing.some((f) => f.kind === 'bank_term_loan' && ['under_review', 'offered', 'pending_approval'].includes(f.status)) || inFlight('request_financing', (p) => p.kind === 'bank_term_loan');
  if (need > mEur(50)) {
    const amt = Math.max(mEur(300), Math.min(mEur(1000), Math.ceil(need / mEur(50)) * mEur(50)));
    const urgent = low0 < mEur(450) || (refiOpen && (diffDays(bond!.maturityDate, d) < 600 || w.commitments.some((c) => c.id === 'COM-001' && c.status === 'open')));
    const why = refiOpen
      ? `The ${fmtEur(bond!.principalCents)} notes mature on ${bond!.maturityDate} and only ${fmtEur(Number(refi!.data.securedCents ?? 0))} of the €700m refinancing is secured. Until it is, the rating agency and the board keep raising the pressure. Refinancing early is cheaper than refinancing late.`
      : `The forecast’s lowest liquidity over the next 12 months is ${fmtEur(low0)}, below the board’s minimum of ${fmtEur(w.meta.boardPlan.minLiquidityCents)} (debt repayments and investment). The board marks you down for every month this is not fixed; below €400m you breach the EIB covenant, and running out of cash ends the game.`;
    let action: AdviceAction | undefined;
    const steps: string[] = [];
    const rightsPending = w.financing.some((f) => f.kind === 'rights_issue' && ['under_review', 'offered', 'pending_approval'].includes(f.status)) || inFlight('request_financing', (p) => p.kind === 'rights_issue');
    const hqFree = !w.meta.assetsSold.includes('HQ_CAMPUS') && !w.financing.some((f) => f.kind === 'sale_leaseback' && ['under_review', 'offered', 'pending_approval'].includes(f.status)) && !inFlight('request_financing', (p) => p.kind === 'sale_leaseback');
    if (!bondPending && lev <= 3.8) {
      action = { type: 'request_financing', payload: { kind: 'bond', amountCents: amt, tenorYears: 6, rationale: 'Refinance upcoming maturities and keep liquidity above the board minimum (Coach)' }, label: `Request a ${fmtEur(amt)} bond`, rationale: 'Raising long-term money now secures liquidity through the coming debt maturities, protects the rating and removes the largest risk to the turnaround.' };
      steps.push(`Request a new bond of about ${fmtEur(amt)} (6 years). It needs the board; directors support refinancing that protects liquidity.`, 'About a month later the bond market makes an offer; time pauses when it arrives — accept it before it expires.');
    } else if (!rightsPending && !bondPending) {
      const eq = Math.max(mEur(300), Math.min(mEur(1000), amt));
      action = { type: 'request_financing', payload: { kind: 'rights_issue', amountCents: eq, rationale: 'Strengthen the balance sheet: leverage is too high for new debt (Coach)' }, label: `Propose a ${fmtEur(eq)} rights issue`, rationale: `Net leverage is ${lev.toFixed(1)}x — too high for bond investors and banks. New equity restores liquidity, brings leverage down, and reopens the debt markets for the refinancing.` };
      steps.push(`Net leverage is ${lev.toFixed(1)}x: bond investors stop buying above about 4x and banks refuse waivers above 4.5x. Raise new equity — a rights issue of about ${fmtEur(eq)} (board + shareholders’ meeting, ~45 days).`, 'Meet Ingrid Halvorsen first: if the anchor shareholder trusts you (trust 45+), she commits to her share and the fees are lower.');
    } else if (hqFree && urgent) {
      action = { type: 'request_financing', payload: { kind: 'sale_leaseback', amountCents: mEur(180), rationale: 'Release cash tied up in the HQ campus (Coach)' }, label: 'Sell and lease back the HQ campus', rationale: 'Selling the HQ campus and leasing it back releases €150–200m of cash quickly.' };
      steps.push('Bridge the gap while the larger financing is under way: sell and lease back the HQ campus (€150–200m).');
    } else steps.push('Money already requested is on its way — accept the offers when they arrive (time pauses for them).');
    steps.push('Meanwhile: cut production of anything dealers are not selling, and postpone projects that do not pay back within two years.');
    adv.push({ id: refiOpen ? 'refinance' : 'funding', priority: P(urgent ? 1 : 2), area: 'finance', title: refiOpen ? `Refinance the ${fmtEur(bond!.principalCents)} bond (${fmtEur(Number(refi!.data.securedCents ?? 0))} of €700m secured)` : `Raise about ${fmtEur(amt)} to keep liquidity above the board minimum`, why, steps, action, link: { page: 'decisions', param: 'money', label: 'Money' } });
  }
  const rcfInst = rcf(w);
  if (rcfInst && diffDays(rcfInst.maturityDate, d) < 600 && !w.financing.some((f) => f.kind === 'rcf_extension' && ['under_review', 'offered', 'pending_approval'].includes(f.status)) && !inFlight('request_financing', (p) => p.kind === 'rcf_extension')) {
    adv.push({ id: 'rcf-extend', priority: P(diffDays(rcfInst.maturityDate, d) < 300 ? 1 : 2), area: 'finance', title: `Extend the ${fmtEur(rcfInst.limitCents)} credit line before ${rcfInst.maturityDate}`, why: `The revolving credit facility expires on ${rcfInst.maturityDate}. After that its undrawn amount no longer counts as liquidity, and anything drawn must be repaid in cash that day — a default if the cash is not there.`, steps: ['Ask the banks to extend it by three years (a fee, no new money). It is your decision; the banks answer in about three weeks.', 'Accept the offer when it arrives. Banks refuse while a covenant is breached — get a waiver first if needed.'], action: { type: 'request_financing', payload: { kind: 'rcf_extension', amountCents: 0, rationale: 'Extend the RCF by three years (Coach)' }, label: 'Ask the banks to extend the RCF' }, deadline: rcfInst.maturityDate });
  }
  const breached = w.covenants.filter((c) => c.status === 'breached');
  // Judge headroom on today's figures, not last quarter's test: a waiver agreed before the breach is far easier.
  const liveValue = (c: (typeof w.covenants)[number]) => (c.metric === 'net_leverage' ? netLeverage(w) : c.metric === 'interest_cover' ? interestCover(w) : c.lastValue);
  const tight = w.covenants.filter((c) => {
    const v = liveValue(c);
    return c.status === 'compliant' && v !== null && c.metric !== 'min_liquidity' && (c.comparator === 'max' ? v > c.threshold * 0.93 : v < c.threshold * 1.07);
  });
  const waived = w.covenants.some((c) => c.waiverUntil && c.waiverUntil > addDays(d, 45));
  if ((breached.some((c) => c.metric !== 'min_liquidity') || (tight.length && !waived)) && !w.financing.some((f) => f.kind === 'covenant_waiver' && ['under_review', 'offered', 'pending_approval'].includes(f.status)) && !inFlight('request_financing', (p) => p.kind === 'covenant_waiver')) {
    const list = (breached.length ? breached : tight).map((c) => c.name).join(' and ');
    adv.push({ id: 'covenant-waiver', priority: P(breached.length ? 1 : 2), area: 'finance', title: breached.length ? `Get a waiver for the ${list} covenant breach` : `Protect the ${list} covenant (close to its limit)`, why: breached.length ? 'A covenant breach is an event of default: the credit line is frozen (it stops counting as liquidity) and the board marks you down heavily for as long as it lasts.' : 'The next quarterly test may breach it. A waiver agreed in advance costs a fee; a breach freezes the credit line and costs a lot of board confidence.', steps: ['Ask the banks for a six-month covenant waiver (fee and a small margin increase). Lenders refuse above 4.5x leverage or when board confidence is very low — ask early.', 'Then improve operating profit (EBITDA): sell more of what earns money, cut surplus production and fixed cost.'], action: { type: 'request_financing', payload: { kind: 'covenant_waiver', amountCents: 0, rationale: 'Covenant relief while the turnaround lifts EBITDA (Coach)' }, label: 'Ask the banks for a covenant waiver' } });
  }

  // ---- Board requests and meetings
  const recovery = w.commitments.find((c) => ['open', 'due'].includes(c.status) && c.check.type === 'deliver_plan' && c.check.topic === 'recovery');
  if (recovery && !w.boardProposals.some((b) => b.status === 'scheduled' && b.submittedDate >= recovery.createdDate)) {
    adv.push({
      id: 'recovery-plan',
      priority: P(1),
      area: 'board',
      title: 'Bring the chair the recovery plan she asked for',
      why: `The chair expects a plan by ${recovery.dueDate}. Missing it counts as a broken promise to the board (−8 confidence for a year); delivering it counts as kept (+4).`,
      steps: [`Put a board plan to the board before ${addDays(recovery.dueDate ?? submitBy, -7)} (Decisions → Board → Put a plan to the board).`, 'Best: include the corrective decisions you have drafted (production cuts, savings, refinancing) so the board can approve them together.'],
      action: { type: 'issue_board_proposal', payload: { title: `Recovery plan ${d.slice(0, 7)}`, kind: 'recovery_plan', rationale: 'Protect liquidity and margins: production matched to demand, refinancing under way, the Eon on track, cost discipline at Lyon and in overheads.' }, label: 'Put a recovery plan to the board' },
      deadline: recovery.dueDate,
    });
  }
  const dueFree = w.commitments.filter((c) => c.promisorId === 'ceo' && c.check.type === 'freeform' && ['open', 'due'].includes(c.status) && c.dueDate && c.dueDate <= addDays(d, 21));
  for (const c of dueFree) {
    adv.push({ id: `promise-${c.id}`, priority: P(c.status === 'due' ? 1 : 2), area: 'promises', title: `Promise due ${c.dueDate}: ${c.description.slice(0, 70)}`, why: 'Free-form promises are not checked automatically: report them as kept when you have delivered, or they count as broken 14 days after the due date.', steps: ['If you delivered, mark it “Fulfilled” in Inbox & meetings → Commitments.', 'If you cannot, say so to the person first — it costs less trust than silence.'], link: { page: 'inbox', param: 'commitments', label: 'Commitments' }, deadline: c.dueDate });
  }

  // ---- Kora inverter
  const kora = byId(w.issues, 'ISS-KORA-INV');
  if (kora && !['resolved', 'closed'].includes(kora.status)) {
    if (!kora.chosenOptions.includes('investigate') && kora.options.some((o) => o.key === 'investigate')) {
      adv.push({ id: 'kora-investigate', priority: P(2), area: 'operations', title: 'Investigate the Kora inverter fault', why: 'Field incidents keep rising; if they pass the regulator’s threshold you face a forced recall (~€95m and lost Kora sales). An investigation (€2.5m) finds the cause and opens a cheaper targeted fix.', steps: ['Preview “Root-cause investigation with Hanseatic” and confirm.'], action: { type: 'address_issue', payload: { issueId: 'ISS-KORA-INV', optionKey: 'investigate' }, label: 'Investigate (€2.5m)' }, deadline: kora.deadline });
    } else if (kora.data.rootCause === 'confirmed' && !kora.chosenOptions.includes('service_campaign') && kora.options.some((o) => o.key === 'service_campaign')) {
      adv.push({ id: 'kora-campaign', priority: P(1), area: 'operations', title: 'Run the targeted Kora service campaign', why: 'The root cause is confirmed. A targeted campaign (~41,000 cars) is far cheaper than a regulator-ordered recall and restores Kora quality.', steps: ['Preview the service campaign and confirm.', 'Then open the Hanseatic cost-sharing negotiation (Deals) to recover part of the cost.'], action: { type: 'address_issue', payload: { issueId: 'ISS-KORA-INV', optionKey: 'service_campaign' }, label: 'Targeted service campaign' } });
    }
  }

  const fc = w.meta.lastForecastSummary;
  const low = fc ? (fc.minLiquidity12mCents ?? fc.minLiquidityCents) : liquidity(w);

  // ---- Directors' trust
  const lowTrust = w.characters.filter((c) => c.isBoardMember && c.active && c.trustInCeo < 45);
  if (lowTrust.length && projected < 55) {
    adv.push({ id: 'meet-directors', priority: P(3), area: 'board', title: `Spend time with ${lowTrust.map((c) => c.name.split(' ').pop()).join(', ')}`, why: 'Directors’ trust in you is part of board confidence and moves their votes. Meetings where you listen, answer with facts and make (and keep) concrete promises build it.', steps: ['Company → People → “Meet”. Ask what worries them; share the forecast or a project report if they ask for numbers.', 'Only promise what you control, with a date — and keep it.'], link: { page: 'company', label: 'Company' } });
  }
  if (diffDays(meeting, d) <= 14 && diffDays(meeting, d) >= 0) {
    adv.push({ id: 'meeting-soon', priority: P(2), area: 'board', title: `Board meeting on ${meeting}`, why: `At regular meetings the board reviews your performance: confidence moves ${Math.round(dset.meetingPull * 100)}% of the way to its target (now ${ct.target.toFixed(0)}). Decisions submitted less than 7 days before go to the following meeting.`, steps: ['Make sure everything you want voted is submitted now.', 'Meet the chair beforehand to brief her on progress.'], link: { page: 'inbox', param: 'board', label: 'Board' } });
  }

  // ---- Strategic, once the basics are covered
  const basicsDone = !adv.some((a) => a.priority === 1);
  const free = Math.floor(engineeringFreeFte(w));
  if (basicsDone) {
    const lyonCost = templateStatus(w, 'lyon_cost_down');
    if (lyonCost.available && !inFlight('start_project', (p) => p.templateKey === 'lyon_cost_down') && low > mEur(600)) {
      adv.push({ id: 'lyon-costdown', priority: P(3), area: 'operations', title: 'Automate Lyon to cut fixed cost', why: 'The Lyon cost-down programme (€120m, 90 engineers, ~12 months) lowers fixed cost and crew needs for years; the board usually supports it.', steps: ['Preview the project; it goes to the board (above €50m).'], action: { type: 'start_project', payload: { templateKey: 'lyon_cost_down' }, label: 'Start the Lyon cost-down programme', rationale: 'Automation at Lyon cuts fixed cost and crew requirements; payback in about three years.' } });
    }
    const quality = templateStatus(w, 'quality_programme');
    const recentQuality = w.projects.some((p) => p.templateKey === 'quality_programme' && p.status !== 'cancelled' && (!p.completedDate || diffDays(d, p.completedDate) < 365));
    if (quality.available && !recentQuality && free >= 70 && !inFlight('start_project', (p) => p.templateKey === 'quality_programme')) {
      adv.push({ id: 'quality', priority: P(4), area: 'operations', title: 'Start the quality & warranty programme', why: 'Cheap (€32m) and low-risk: fewer warranty claims and better quality scores support prices.', steps: ['Preview the project and confirm (within your authority).'], action: { type: 'start_project', payload: { templateKey: 'quality_programme' }, label: 'Start the quality programme' } });
    }
  }

  // ---- CO₂ (information)
  const yr = Number(d.slice(0, 4));
  const co2 = fleetCo2Ytd(w);
  if (co2 > 0 && co2 > co2Target(w, yr) + 3) {
    adv.push({ id: 'co2', priority: P(4), area: 'vela', title: `Fleet CO₂ ${co2.toFixed(0)} g/km vs target ${co2Target(w, yr)}`, why: 'Each gram above target costs €95 per car registered. The Eon’s launch and the Vela hybrid lower the average; selling fewer petrol Velas does too.', steps: ['Keep the Eon on schedule; consider the Vela mild-hybrid refresh; price the Eon to sell volume.'] });
  }

  adv.sort((a, b) => a.priority - b.priority);
  const objs = mandateObjectives(w);
  const danger = projected < dset.dismissalThreshold + 5;
  const headline = danger
    ? `Board confidence is heading for about ${Math.round(projected)} at the ${meeting} meeting — close to the ${dset.dismissalThreshold} danger line. Fix the top items below first.`
    : adv.some((a) => a.priority === 1)
      ? `You have ${adv.filter((a) => a.priority === 1).length} urgent item${adv.filter((a) => a.priority === 1).length > 1 ? 's' : ''}. Board confidence is ${Math.round(now)} and heading for about ${Math.round(projected)} at the next meeting.`
      : `No urgent problems. Board confidence ${Math.round(now)} (heading for ~${Math.round(projected)}). Use the time for the strategic items below.`;

  return {
    date: d,
    scenario: w.meta.scenarioKey,
    confidence: { now, target: ct.target, projectedNextMeeting: projected, nextMeeting: meeting, threshold: dset.dismissalThreshold, strikes: w.meta.lowConfidenceMeetings, strikesAllowed: dset.dismissalMeetings, drivers },
    mandate: { score: mandateScore(objs), passScore: dset.passScore, termEnd: w.meta.termEndDate, objectives: objs },
    headline,
    advice: adv,
    principles: [
      'The board judges results against its plan: profit, liquidity, the Eon date, battery supply, covenants, promises and trust. Fix what is driving confidence down first — the drivers are listed above.',
      'In the first months you are protected by a grace period; use it to fix the inherited problems (battery supply, Euro 7, thermal validation, production discipline, the wage deal, refinancing) before the board judges you on them fully.',
      'Build what dealers sell. Overproduction quietly drains cash and margins.',
      'Refinance early, and keep liquidity well above the €400m covenant floor.',
      'Promise only what you control, with a date, and report it kept. Broken promises to directors are expensive.',
      'Use the board’s vote outlook before submitting; meet directors who are against.',
    ],
  };
}
