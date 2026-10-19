/**
 * Context builder. Before every character interaction we assemble a compact
 * package from the database — never from the transcript alone — in priority
 * order, within a token budget. Every line carries an epistemic label:
 *   [FACT]      authoritative current state (database)
 *   [EST]       engine estimate / forecast (uncertain)
 *   [BELIEF]    a character's belief or memory (may be wrong)
 *   [RUMOR]     unverified hearsay
 *   [UNKNOWN]   explicitly not known
 * Characters only see what their role plausibly gives them access to.
 */
import type { Character, ConversationMessage, Issue, Project } from '../../shared/domain';
import { diffDays, fmtDate } from '../../shared/dates';
import { fmtEur } from '../../shared/money';
import type { DB } from '../db/connection';
import { rowToEvent, rowToMemory } from '../db/repo';
import { upcomingMeeting } from '../engine/board';
import { fleetCo2Ytd, co2Target } from '../engine/close';
import { modelMonthlyDemand } from '../engine/demand';
import { EVENT_CATALOGUE } from '../engine/events';
import { cash } from '../engine/ledger';
import { engineeringFreeFte, liquidity, netLeverage, rcf } from '../engine/metrics';
import { NEGOTIATION_TEMPLATES, lastCounter } from '../engine/negotiation';
import { RULES } from '../engine/params';
import { milestonesOf } from '../engine/projects';
import { byId, type World } from '../engine/world';
import { actionCatalogForLlm } from '../actions/registry';
import { PROJECT_TEMPLATES } from '../actions/templates';
import { documentContext } from '../game/documents';
import { buildReport, reportInfo, reportToText, reportsOwnedBy } from '../reports/catalog';
import { proposalActionIds } from '../engine/board';
import { addDays } from '../../shared/dates';

export interface ContextSection {
  name: string;
  priority: number;
  text: string;
  tokens: number;
  included: boolean;
}

export interface ContextPackage {
  text: string;
  tokens: number;
  sections: ContextSection[];
  entityIds: string[];
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 3.8);

const INTERNAL = (c: Character) => c.org === 'asterion';
const sees = (c: Character, scope: string) => c.org === 'asterion' || c.org === 'board' || c.knowledgeScope.includes(scope);

function trustLabel(t: number): string {
  return t >= 75 ? 'high' : t >= 55 ? 'reasonable' : t >= 40 ? 'guarded' : t >= 25 ? 'low' : 'very low';
}

/** Find entities referenced in free text by id, name or common alias. */
export function mentionedEntities(w: World, text: string): string[] {
  const t = text.toLowerCase();
  const ids = new Set<string>();
  const aliases: [RegExp, string][] = [
    [/\beon\b|electric crossover|\bev\b|crossover|e-flex/, 'PRJ-EON'],
    [/\bvela\b|compact car|hatchback/, 'MDL-VELA'],
    [/\bkora\b|hybrid suv/, 'MDL-KORA'],
    [/voltaris|battery supplier|battery pack|packs/, 'SUP-VOLTARIS'],
    [/hanseatic|inverter/, 'SUP-HANSEATIC'],
    [/thermal|propagation/, 'ISS-THERMAL'],
    [/\bunion\b|wage|strike|novak|collective/, 'NEG-UNION'],
    [/refinanc|\bbond\b|notes|lender|bank|loan|rcf|covenant|liquidity|cash/, 'DEBT-BOND28'],
    [/lyon/, 'FAC-LYON'],
    [/sevill|seville/, 'FAC-SEV'],
    [/brno/, 'FAC-BRNO'],
    [/euro ?7/, 'PRJ-VELA-E7'],
    [/dealer/, 'CHR-BELLINI'],
    [/co2|co₂|emission/, 'REG-CO2'],
    [/board/, 'CHR-DUBREUIL'],
  ];
  for (const [re, id] of aliases) if (re.test(t)) ids.add(id);
  const all = [...w.projects, ...w.models, ...w.suppliers, ...w.factories, ...w.issues, ...w.negotiations, ...w.characters, ...w.contracts, ...w.financing, ...w.debts];
  for (const e of all) {
    if (t.includes(e.id.toLowerCase())) ids.add(e.id);
    const name = 'name' in e ? String((e as { name: string }).name).toLowerCase() : 'title' in e ? String((e as { title: string }).title).toLowerCase() : '';
    if (name.length > 5 && t.includes(name)) ids.add(e.id);
  }
  return [...ids];
}

function projectBlock(w: World, p: Project, detailed: boolean): string {
  const ms = milestonesOf(w, p.id);
  const lines = [
    `[FACT] Project ${p.id} "${p.name}" — status ${p.status}, priority ${p.priority}. Sponsor ${byId(w.characters, p.sponsorId)?.name ?? p.sponsorId}, manager ${byId(w.characters, p.managerId)?.name ?? p.managerId}.`,
    `[FACT] Target date ${p.targetDate} (original ${p.originalTargetDate}). Budget ${fmtEur(p.budgetCents)} (original ${fmtEur(p.originalBudgetCents)}), spent ${fmtEur(p.spentCents)}. Staffing ${Math.round(p.staffingFte)} FTE.`,
    `[EST] Forecast completion ${p.forecastDate ?? 'cannot be forecast (blocked by an unmet gate)'}${p.forecastP80Date ? `, P80 ${p.forecastP80Date}` : ''}.`,
  ];
  if (detailed) {
    for (const m of ms) {
      const gates = m.gates.map((g) => (g.type === 'issue_resolved' ? `needs issue ${g.issueId} resolved` : g.type === 'supply_capacity' ? `needs battery supply ≥${g.minDaily}/day` : `not before ${g.date} (${g.reason})`));
      lines.push(`[FACT]   ${m.id} ${m.name}: ${m.status}${m.completedDate ? ` on ${m.completedDate}` : ''}, ${Math.round((m.workDone / Math.max(1, m.workTotal)) * 100)}% of work, planned ${m.plannedDate}${m.plannedDate !== m.originalPlannedDate ? ` (originally ${m.originalPlannedDate})` : ''}${gates.length ? `; ${gates.join('; ')}` : ''}.`);
    }
    if (p.lastDecision) lines.push(`[FACT] Last decision: ${p.lastDecision}`);
  }
  return lines.join('\n');
}

function issueBlock(w: World, i: Issue): string {
  const opts = i.options.filter((o) => !i.chosenOptions.includes(o.key)).map((o) => `${o.key} (${o.label}, ${fmtEur(o.costCents)})`);
  return `[FACT] Issue ${i.id} "${i.title}" — ${i.severity}, ${i.status}, owner ${byId(w.characters, i.ownerId ?? '')?.name ?? '—'}${i.deadline ? `, deadline ${i.deadline}` : ''}. ${i.description}${i.resolutionWorkTotal > 0 ? ` Resolution work ${Math.round((i.resolutionWorkDone / i.resolutionWorkTotal) * 100)}% done.` : ''}${opts.length ? ` Options: ${opts.join('; ')}.` : ''}${i.chosenOptions.length ? ` Already chosen: ${i.chosenOptions.join(', ')}.` : ''}`;
}

export interface BuildOpts {
  characterId: string;
  conversationId: string | null;
  playerMessage: string;
  budgetTokens?: number;
}

export function buildContext(db: DB, w: World, opts: BuildOpts): ContextPackage {
  const c = byId(w.characters, opts.characterId);
  if (!c) throw new Error(`Unknown character ${opts.characterId}`);
  const budget = opts.budgetTokens ?? 9000;
  const sections: ContextSection[] = [];
  const entityIds = new Set<string>();
  const add = (name: string, priority: number, text: string) => {
    if (text.trim()) sections.push({ name, priority, text, tokens: estimateTokens(text), included: false });
  };
  const d = w.meta.currentDate;
  const mentioned = mentionedEntities(w, opts.playerMessage);
  mentioned.forEach((x) => entityIds.add(x));

  // P0 — situation header
  add('header', 0, [
    `SIMULATION DATE: ${fmtDate(d, 'long')} (${d}). Company: Asterion Automotive (Lyon). You are speaking with the CEO (the player).`,
    `Labels: [FACT]=authoritative current state; [EST]=forecast/estimate (uncertain); [BELIEF]=your own memory/belief; [RUMOR]=unverified; [UNKNOWN]=you do not know.`,
    `If something is not in this context, you do not know it. Current facts override older remarks in the conversation.`,
  ].join('\n'));

  // P1 — character profile
  const rels = w.relationships.filter((r) => r.fromId === c.id || r.toId === c.id).map((r) => {
    const other = byId(w.characters, r.fromId === c.id ? r.toId : r.fromId);
    return `${other?.name ?? '?'} (${r.kind}, ${r.strength > 0 ? '+' : ''}${r.strength}): ${r.note}`;
  });
  const revealed = c.privateInfo.filter((p) => c.trustInCeo >= p.revealAtTrust);
  add('profile', 1, [
    `YOU ARE ${c.name}, ${c.title} (${c.orgName}).`,
    `Bio: ${c.bio}`,
    `Personality: ${c.personality}`,
    `Communication style: ${c.communicationStyle}`,
    `Expertise: ${c.expertise.join(', ')}. Skills: ${c.skills.join(', ')}.`,
    `Objectives: ${c.objectives.join('; ')}. Incentives: ${c.incentives}. Risk tolerance ${c.riskTolerance}/100.`,
    `Your trust in the CEO: ${Math.round(c.trustInCeo)}/100 (${trustLabel(c.trustInCeo)}). Stress ${Math.round(c.stress)}/100.`,
    `Your formal authority: ${c.authority.notes}`,
    rels.length ? `Relationships: ${rels.join(' | ')}` : '',
    revealed.length ? `PRIVATE knowledge (you may choose whether to share it; trust permits candour): ${revealed.map((p) => p.fact).join(' ')}` : 'You hold private views you are not yet willing to share with this CEO.',
  ].filter(Boolean).join('\n'));

  // P2 — commitments involving the character, plus CEO commitments due soon
  const coms = w.commitments.filter((x) => ['open', 'due'].includes(x.status) && (x.promiseeId === c.id || x.promisorId === c.id || (x.dueDate && diffDays(x.dueDate, d) <= 45)));
  const recentBroken = w.commitments.filter((x) => x.promiseeId === c.id && ['broken', 'fulfilled'].includes(x.status));
  add('commitments', 2, [
    ...coms.map((x) => `[FACT] Commitment ${x.id}: ${x.promisorId === 'ceo' ? 'CEO' : byId(w.characters, x.promisorId)?.name} → ${byId(w.characters, x.promiseeId)?.name ?? x.promiseeId}: "${x.description}" due ${x.dueDate ?? 'n/a'} — ${x.status}${x.dueDate && x.dueDate < d ? ' (OVERDUE)' : ''}.`),
    ...recentBroken.map((x) => `[FACT] Past promise to you: "${x.description}" — ${x.status} on ${x.resolvedDate}.`),
  ].join('\n'));

  // P2 — what the CEO can actually do (so characters only ask for things that exist)
  add('ceo_capabilities', 2, [
    'WHAT THE CEO CAN DO IN THIS GAME — only ask the CEO for these:',
    '- Take a decision (an action from the ACTION CATALOG). Decisions above the CEO’s authority go to the board automatically when confirmed and are carried out if approved.',
    '- Send you (or others) any report from the REPORT CATALOGUE, or a written memo. If you need information you do not have, ask for a report by its key (request_reports) — nothing else exists.',
    '- Meet anyone (you cannot arrange meetings between other people), put a plan to the board, make and keep promises, and let time pass.',
    'REPORT CATALOGUE (key — title: contents): ' + reportInfo().map((r) => `${r.key}${r.param ? `:<${r.param} id>` : ''} — ${r.title}: ${r.description}`).join(' | '),
    INTERNAL(c) ? `You can attach reports your department produces (YOUR REPORTS below) to your answer (attach_reports), and, when the CEO asks, send them to colleagues (share_reports). You cannot send anything else, and you cannot promise to "come back later" with work: give your analysis now, from this context and your reports, with their numbers, and be clear about what you do not know.` : 'You cannot send files yourself. Give your view now, from this context, and be clear about what you do not know.',
    'When you recommend something concrete, propose the concrete action itself (e.g. start_project, hire_staff), not a board proposal — it is submitted to the board automatically if needed. Only use issue_board_proposal to bundle already-drafted decisions (actionIds) or for a pure strategy endorsement, and say that an endorsement changes nothing by itself.',
  ].join('\n'));

  // P2 — documents this character received
  const docs = documentContext(db, w, c.id);
  add('shared_documents', 2, docs.mine.length ? ['DOCUMENTS YOU RECEIVED (snapshots as of their date; newer facts elsewhere in this context override them):', ...docs.mine].join('\n') : '[FACT] Nobody has sent you any documents recently.');

  // P3 — the reports this character's department produces, computed live (their own numbers)
  const owned = INTERNAL(c) ? reportsOwnedBy(c.id).filter((r) => !r.param) : [];
  if (owned.length) {
    const lines = ['YOUR REPORTS (your department’s current figures — quote them precisely; attach the report when you use it):'];
    for (const r of owned) {
      try {
        lines.push(`[FACT] key "${r.key}":\n${reportToText(buildReport(db, w, r.key, null, c.id), 1500)}`);
      } catch {
        /* not available yet */
      }
    }
    const paramOwned = reportsOwnedBy(c.id).filter((r) => r.param);
    if (paramOwned.length) lines.push(`You can also attach: ${paramOwned.map((r) => `"${r.key}:<${r.param} id>" (${r.title})`).join(', ')}.`);
    add('own_reports', 3, lines.join('\n'));
  }

  // P3 — company knowledge shared across the leadership (internal + board only)
  if (c.org === 'asterion' || c.org === 'board') {
    const know: string[] = ['COMPANY KNOWLEDGE (shared across the leadership team; you know this because colleagues talk):'];
    const decided = db.prepare("SELECT sim_date, summary, status, type, result FROM actions WHERE status IN ('committed','pending_approval','approved') AND type NOT IN ('advance_time','approve_budget','negotiate_contract') AND sim_date >= ? ORDER BY created_at DESC LIMIT 14").all(addDays(d, -90)) as { sim_date: string; summary: string; status: string }[];
    for (const r of decided.reverse()) know.push(`[FACT] ${r.sim_date}: CEO decision — ${r.summary}${r.status === 'pending_approval' ? ' (submitted to the board, not yet decided)' : r.status === 'approved' ? ' (approved by the board but not yet possible to carry out)' : ''}.`);
    for (const bp of w.boardProposals.filter((b) => b.status === 'scheduled')) know.push(`[FACT] On the agenda of the board meeting on ${bp.meetingDate}: "${bp.title}" (${bp.id})${proposalActionIds(bp).length ? '' : ' — endorsement only'}.`);
    for (const bp of w.boardProposals.filter((b) => b.decidedDate && b.decidedDate >= addDays(d, -120))) know.push(`[FACT] ${bp.decidedDate}: the board ${bp.status} "${bp.title}" (${bp.outcomeNote ?? ''}).`);
    const peerOrg = c.org === 'board' ? ['board', 'asterion'] : ['asterion', 'board'];
    const convs = db.prepare("SELECT character_id, last_date, summary, title FROM conversations WHERE character_id != ? AND last_date >= ? AND summary != '' ORDER BY last_date DESC LIMIT 12").all(c.id, addDays(d, -60)) as { character_id: string; last_date: string; summary: string }[];
    let n = 0;
    for (const cv of convs) {
      const other = byId(w.characters, cv.character_id);
      if (!other || !peerOrg.includes(other.org) || n >= 6) continue;
      if (c.org === 'board' && other.org === 'asterion' && !other.knowledgeScope.includes('board')) continue;
      n++;
      know.push(`[FACT] ${cv.last_date}: the CEO met ${other.name} (${other.title}). Gist: ${cv.summary.slice(0, 260)}`);
    }
    know.push(...docs.circulated);
    if (know.length > 1) add('company_knowledge', 3, know.join('\n'));
  }

  // P3 — entities in focus: mentioned + character's domain
  const focusProjects = new Set<string>();
  for (const id of mentioned) {
    if (id.startsWith('PRJ-')) focusProjects.add(id);
    const m = byId(w.models, id);
    if (m?.projectId) focusProjects.add(m.projectId);
    const iss = byId(w.issues, id);
    if (iss?.projectId) focusProjects.add(iss.projectId);
  }
  if (c.knowledgeScope.includes('eon') || c.id === 'CHR-WIERZBICKI') focusProjects.add('PRJ-EON');
  const projText: string[] = [];
  if (sees(c, 'projects') || c.knowledgeScope.includes('eon')) {
    for (const p of w.projects) {
      if (['cancelled'].includes(p.status) && !focusProjects.has(p.id)) continue;
      projText.push(projectBlock(w, p, focusProjects.has(p.id)));
      if (focusProjects.has(p.id)) entityIds.add(p.id);
    }
  } else if (c.org !== 'asterion') {
    projText.push('[UNKNOWN] Internal project details are confidential to Asterion; you only know what has been announced publicly.');
    const eon = byId(w.projects, 'PRJ-EON');
    if (eon) projText.push(`[FACT] Publicly announced: Eon launch planned for ${eon.targetDate}.`);
  }
  add('projects', 3, projText.join('\n'));

  // P4 — unresolved issues (relevant ones first)
  const issues = w.issues.filter((i) => !['resolved', 'closed'].includes(i.status));
  const relevant = issues.filter((i) => mentioned.includes(i.id) || (i.projectId && focusProjects.has(i.projectId)) || i.ownerId === c.id || i.linked.some((l) => mentioned.includes(l.id) || l.id === c.id));
  const others = issues.filter((i) => !relevant.includes(i));
  if (sees(c, 'projects') || INTERNAL(c)) {
    add('issues', 4, [...relevant.map((i) => issueBlock(w, i)), ...others.map((i) => `[FACT] Issue ${i.id} "${i.title}" (${i.severity}, ${i.status}).`)].join('\n'));
  } else {
    add('issues', 4, relevant.filter((i) => i.linked.some((l) => l.id === c.id || (l.type === 'negotiation' && byId(w.negotiations, l.id)?.counterpartyId === c.id))).map((i) => issueBlock(w, i)).join('\n'));
  }
  relevant.forEach((i) => entityIds.add(i.id));

  // P5 — operations, products, finance, by access
  const ops: string[] = [];
  if (sees(c, 'operations') || sees(c, 'sales') || sees(c, 'products') || c.org === 'board' || INTERNAL(c)) {
    for (const m of w.models) {
      const demand = modelMonthlyDemand(w, m, d);
      ops.push(`[FACT] ${m.id} ${m.name} (${m.powertrain}, ${m.status}): net price ${fmtEur(m.netPriceCents)}, quality ${m.quality}, company stock ${m.fgUnits.toLocaleString('en-GB')}, dealer stock ${m.dealerStock.toLocaleString('en-GB')}, last month retail ${m.retailLastMonth.toLocaleString('en-GB')}, built ${m.productionLastMonth.toLocaleString('en-GB')}. [EST] demand ≈${Math.round(demand).toLocaleString('en-GB')}/month.`);
    }
    for (const l of w.lines) ops.push(`[FACT] Line ${l.id} ${l.name}: ${l.status}, planned ${l.plannedDailyRate}/day, max ${l.maxDailyRate}/day.`);
    for (const f of w.factories) {
      const dep = byId(w.departments, f.departmentId);
      ops.push(`[FACT] ${f.id} ${f.name}: workforce ${dep?.headcount.toLocaleString('en-GB')}, morale ${Math.round(dep?.morale ?? 0)}, absenteeism ${f.absenteeismPct.toFixed(1)}%.`);
    }
    for (const s of w.supplies.filter((x) => mentioned.includes(x.supplierId) || x.modelIds.some((mm) => mentioned.includes(mm)) || c.knowledgeScope.includes('suppliers'))) {
      ops.push(`[FACT] Supply ${s.id}: ${byId(w.suppliers, s.supplierId)?.name} ${s.component} for ${s.modelIds.join('/')}: capacity ${s.dailyCapacity}/day at ${fmtEur(s.unitPriceCents)}${s.pendingCapacity.length ? `; contracted increase to ${s.pendingCapacity.map((p) => `${p.dailyCapacity}/day from ${p.date}`).join(', ')}` : ''}${s.disruptionUntil ? `; DISRUPTED −${Math.round(s.disruptionFactor * 100)}% until ${s.disruptionUntil}` : ''}.`);
    }
    ops.push(`[FACT] Engineering capacity: ${Math.max(0, Math.floor(engineeringFreeFte(w)))} engineers currently unassigned.`);
    for (const dep of w.departments) ops.push(`[FACT] Department ${dep.id} ${dep.name}: ${dep.headcount.toLocaleString('en-GB')} people, morale ${Math.round(dep.morale)}.`);
  } else {
    for (const m of w.models.filter((x) => x.status === 'in_production')) ops.push(`[FACT] ${m.name} is on sale at a list price of ${fmtEur(m.listPriceCents)}.`);
  }
  add('operations', 5, ops.join('\n'));

  const fin: string[] = [];
  const fc = w.meta.lastForecastSummary;
  if (sees(c, 'finance') || c.org === 'board' || c.id === 'CHR-HOLM') {
    const r = rcf(w);
    fin.push(`[FACT] Cash ${fmtEur(cash(w))}; liquidity incl. undrawn RCF ${fmtEur(liquidity(w))}; RCF drawn ${fmtEur(r?.principalCents ?? 0)} of ${fmtEur(r?.limitCents ?? 0)}. Net leverage ${netLeverage(w).toFixed(2)}x (covenant ≤3.50x). Rating ${w.meta.creditRating} (${w.meta.ratingOutlook}).`);
    for (const debt of w.debts.filter((x) => x.status === 'active')) fin.push(`[FACT] Debt ${debt.id}: ${debt.name}, ${fmtEur(debt.principalCents)} at ${(debt.rateBps / 100).toFixed(2)}%, matures ${debt.maturityDate}.`);
    for (const cv of w.covenants) fin.push(`[FACT] Covenant ${cv.name}: ${cv.status}${cv.lastValue !== null ? `, last test ${cv.metric === 'min_liquidity' ? fmtEur(cv.lastValue) : `${cv.lastValue.toFixed(2)}x`} on ${cv.lastTestDate}` : ''}.`);
    if (fc) fin.push(`[EST] Latest forecast (${fc.createdDate}, base case): FY operating profit ${fmtEur(fc.fyEbitCents)} vs board plan ${fmtEur(w.meta.boardPlan.ebitTargetCents)}; 12-month minimum liquidity ${fmtEur(fc.minLiquidity12mCents ?? fc.minLiquidityCents)}; Eon SOP ${fc.eonSopForecast ?? `blocked (≈${fc.eonSopConditional ?? 'n/a'} if battery supply is secured)`}; CO₂ premium this year ≈${fmtEur(fc.co2PenaltyFyCents)}.`);
    fin.push(`[FACT] Fleet CO₂ YTD ${fleetCo2Ytd(w).toFixed(1)} g/km vs target ${co2Target(w, Number(d.slice(0, 4)))}. Board confidence in the CEO: ${Math.round(w.meta.boardConfidence)}/100. Next board meeting ${upcomingMeeting(w)}.`);
    for (const f of w.financing.filter((x) => !['executed', 'withdrawn', 'expired'].includes(x.status))) fin.push(`[FACT] Financing ${f.id} (${f.kind}, ${fmtEur(f.requestedCents)}): ${f.status}${f.offer ? `; offer ${fmtEur(f.offer.amountCents)} at ${(f.offer.rateBps / 100).toFixed(2)}% valid until ${f.offer.validUntil}` : ''}.`);
  } else if (c.knowledgeScope.includes('finance_public') || c.knowledgeScope.includes('debt')) {
    const last = [...w.snapshots].filter((s) => s.kind === 'month').pop();
    fin.push(`[FACT] Published data: gross debt ${fmtEur(w.debts.reduce((a, x) => a + (x.status === 'active' ? x.principalCents : 0), 0))}; rating ${w.meta.creditRating} (${w.meta.ratingOutlook}). Last reported month revenue ${fmtEur(last?.data.revenueCents ?? 0)}, cash ${fmtEur(last?.data.cashCents ?? 0)}.`);
    fin.push('[UNKNOWN] Internal forecasts are not shared with you unless the CEO chooses to.');
    for (const f of w.financing.filter((x) => x.counterpartyId === c.id && !['withdrawn', 'expired'].includes(x.status))) fin.push(`[FACT] Request ${f.id} to your institution: ${f.kind}, ${fmtEur(f.requestedCents)}, ${f.status}.`);
  }
  add('finance', 5, fin.join('\n'));

  // P5b — negotiations with this character
  const negs = w.negotiations.filter((n) => n.counterpartyId === c.id || mentioned.includes(n.id) || (INTERNAL(c) && c.knowledgeScope.includes('negotiations')));
  const negText: string[] = [];
  for (const n of negs) {
    const t = NEGOTIATION_TEMPLATES[n.templateKey];
    const lc = lastCounter(n);
    negText.push(`[FACT] Negotiation ${n.id} "${n.title}" — ${n.status}${n.deadline ? `, deadline ${n.deadline}` : ''}. ${n.context}`);
    if (lc) negText.push(`[FACT]   Latest position of ${byId(w.characters, n.counterpartyId)?.name}: ${t.describe(lc)}`);
    const lastCeo = [...n.rounds].reverse().find((r) => r.by === 'ceo');
    if (lastCeo) negText.push(`[FACT]   Last CEO offer (${lastCeo.date}): ${t.describe(lastCeo.terms)}${lastCeo.evaluation ? ` — ${lastCeo.evaluation.accepted ? 'acceptable' : 'not acceptable'}${lastCeo.evaluation.violations.length ? `: ${lastCeo.evaluation.violations.join(' ')}` : ''}` : ''}`);
    if (n.pendingDecision) negText.push(`[FACT]   Awaiting ${n.pendingDecision.approver} decision by ${n.pendingDecision.date}.`);
    if (n.counterpartyId === c.id && n.status === 'open') negText.push(`[BELIEF] Your private walk-away limits in this negotiation are yours alone; never state them as numbers. Your opening position: ${t.describe(n.ideal)}.`);
    entityIds.add(n.id);
  }
  for (const k of w.contracts.filter((x) => x.counterpartyId === c.id || mentioned.includes(x.id))) negText.push(`[FACT] Contract ${k.id} "${k.title}": ${k.status}${k.signedDate ? `, signed ${k.signedDate}` : ' (NOT signed)'}. ${k.summary}`);
  add('negotiations', 5, negText.join('\n'));

  // P6 — recent relevant events (event ledger)
  const evRows = db
    .prepare(
      `SELECT DISTINCT e.* FROM events e LEFT JOIN event_entities x ON x.event_id = e.id
       WHERE e.date >= date(?, '-60 days') AND (x.entity_id IN (${[...entityIds, c.id, 'x'].map(() => '?').join(',')}) OR e.severity IN ('critical','warning'))
       ORDER BY e.seq DESC LIMIT 14`,
    )
    .all(d, ...entityIds, c.id, 'x') as Record<string, unknown>[];
  add('events', 6, evRows.map((r) => rowToEvent(r)).map((e) => `[FACT] ${e.date}: ${e.title}. ${e.description.slice(0, 220)}`).join('\n'));

  // P7 — character memories (FTS relevance + importance + recency)
  const terms = opts.playerMessage.toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g)?.slice(0, 12) ?? [];
  let memRows: Record<string, unknown>[] = [];
  if (terms.length) {
    try {
      memRows = db.prepare(`SELECT m.* FROM memories_fts f JOIN character_memories m ON m.seq = f.rowid WHERE memories_fts MATCH ? AND m.character_id = ? ORDER BY m.importance DESC, m.seq DESC LIMIT 6`).all(terms.map((x) => `"${x}"`).join(' OR '), c.id) as Record<string, unknown>[];
    } catch {
      memRows = [];
    }
  }
  const recentMem = db.prepare(`SELECT * FROM character_memories WHERE character_id = ? ORDER BY importance >= 4 DESC, seq DESC LIMIT 10`).all(c.id) as Record<string, unknown>[];
  const seen = new Set<string>();
  const mems = [...memRows, ...recentMem].filter((r) => (seen.has(String(r.id)) ? false : (seen.add(String(r.id)), true))).slice(0, 12).map(rowToMemory);
  add('memories', 7, mems.length ? mems.map((m) => `[BELIEF] ${m.date} (${m.kind}, importance ${m.importance}): ${m.summary}`).join('\n') : '[UNKNOWN] You have no recorded memories of earlier dealings with this CEO.');

  // P8 — rules & action catalogue (internal only proposes Asterion actions)
  const rules = [
    `RULES: The CEO may commit up to ${fmtEur(RULES.ceoSpendLimitCents)} per decision; above that, new debt above ${fmtEur(RULES.ceoFinancingLimitCents)}, equity, asset sales, vehicle-programme cancellations and restructurings above ${RULES.boardRestructuringHeadcount} jobs need the board. Job cuts require 60 days of consultation.`,
    'Nothing you say changes the world by itself. Proposed actions are validated by the simulation and decided by the CEO. Agreements are not contracts until signed; requests are not money until executed.',
  ];
  if (INTERNAL(c) || c.org === 'board') {
    rules.push('ACTION CATALOG (type: params):');
    for (const a of actionCatalogForLlm()) rules.push(`- ${a.type}: ${a.schema}`);
    rules.push(`Project templates: ${PROJECT_TEMPLATES.map((t) => `${t.key} (${t.name}, ${fmtEur(t.budgetCents)}, ${t.fte} FTE)`).join('; ')}.`);
    rules.push(`Negotiation templates: ${Object.values(NEGOTIATION_TEMPLATES).map((t) => `${t.key} with ${byId(w.characters, t.counterpartyId)?.name}`).join('; ')}.`);
  } else {
    rules.push('You represent an external party: you cannot propose Asterion actions except make_promise records of what the CEO promised; leave proposed_actions empty otherwise.');
  }
  rules.push(`Escalation event keys you may propose (rarely, only if in character and justified): ${EVENT_CATALOGUE.filter((e) => e.proposable).map((e) => e.key).join(', ')}.`);
  add('rules', 8, rules.join('\n'));

  // Pack within budget in priority order (lower number = more important).
  let used = 0;
  const ordered = [...sections].sort((a, b) => a.priority - b.priority);
  const out: string[] = [];
  for (const s of ordered) {
    if (used + s.tokens <= budget) {
      s.included = true;
      used += s.tokens;
      out.push(`## ${s.name.toUpperCase()}\n${s.text}`);
    } else {
      // Include a truncated version when meaningful room is left.
      const room = budget - used;
      if (room > 200) {
        const text = s.text.slice(0, Math.floor(room * 3.6));
        out.push(`## ${s.name.toUpperCase()} (truncated)\n${text}`);
        used += estimateTokens(text);
        s.included = true;
      }
    }
  }
  return { text: out.join('\n\n'), tokens: used, sections, entityIds: [...entityIds] };
}

export function transcriptForLlm(msgs: ConversationMessage[], keep = 10): { role: 'user' | 'assistant'; content: string }[] {
  return msgs
    .filter((m) => m.role !== 'system')
    .slice(-keep)
    .map((m) => ({ role: m.role === 'player' ? ('user' as const) : ('assistant' as const), content: m.role === 'player' ? m.content : JSON.stringify({ dialogue: m.content }) }));
}
