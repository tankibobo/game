/**
 * Deterministic fallback "character engine". Used when no LLM is configured,
 * or when an LLM call fails or returns invalid output. It parses common
 * intents with patterns, answers in a templated voice from authoritative
 * facts, and produces the same structured output as the LLM path — so all
 * proposals still go through the validator. Clearly labelled in the UI.
 */
import type { Character } from '../../shared/domain';
import { diffDays, fmtDate, parseLooseDate } from '../../shared/dates';
import { fmtEur, mEur, parseMoney } from '../../shared/money';
import { modelMonthlyDemand } from '../engine/demand';
import { cash } from '../engine/ledger';
import { engineeringFreeFte, liquidity, netLeverage } from '../engine/metrics';
import { PROJECT_TEMPLATES } from '../actions/templates';
import { NEGOTIATION_TEMPLATES, lastCounter } from '../engine/negotiation';
import { byId, type World } from '../engine/world';
import { mentionedEntities } from './context';
import { REPORT_BY_KEY, reportsOwnedBy } from '../reports/catalog';
import type { CharacterTurn } from './schemas';

type Proposal = CharacterTurn['proposed_actions'][number];

const pick = <T,>(xs: T[], seed: string): T => xs[[...seed].reduce((a, ch) => a + ch.charCodeAt(0), 0) % xs.length];

function pctIn(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/i);
  return m ? Number(m[1]) / 100 : null;
}

function intIn(text: string, after: RegExp): number | null {
  const m = text.match(after);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export function detectProposals(w: World, msg: string, speaker: Character): { proposals: Proposal[]; notes: string[] } {
  const t = msg.toLowerCase();
  const out: Proposal[] = [];
  const notes: string[] = [];
  const ids = mentionedEntities(w, msg);
  const date = parseLooseDate(msg, w.meta.currentDate);
  const internal = speaker.org === 'asterion';
  const P = (type: string, params: unknown, rationale: string) => out.push({ type, params_json: JSON.stringify(params), rationale });

  if (!internal) return { proposals: out, notes };

  // Project re-planning / deadlines
  const projectId = ids.find((x) => x.startsWith('PRJ-')) ?? (/(electric|crossover|\beon\b)/.test(t) ? 'PRJ-EON' : null);
  const pr = byId(w.projects, projectId ?? '');
  if (pr && date && /(delay|postpone|push back|move .* to|slip|re-?plan|rephase)/.test(t)) {
    P('change_project_scope', { projectId: pr.id, newTargetDate: date, reason: `CEO decision: re-plan ${pr.name} to ${date}.` }, `Re-plan ${pr.name} to ${date}; staffing would be adjusted to the slower schedule.`);
  } else if (pr && /(more engineers|add (\d+ )?(engineers|people|staff)|staff up|accelerate|speed up)/.test(t)) {
    const n = intIn(t, /add\s+(\d[\d,]*)/) ?? Math.min(150, Math.max(0, Math.floor(engineeringFreeFte(w))));
    if (n > 0) P('change_project_scope', { projectId: pr.id, staffingDelta: n, reason: 'CEO asked to accelerate the programme.' }, `Add ${n} engineers (diminishing returns apply).`);
    else notes.push('There are no unassigned engineers; we would have to hire first (≈90 days).');
  }
  // Approvals of proposed projects
  if (/(approve|go ahead|green light|launch).*(euro ?7|vela compliance)/.test(t) || /(euro ?7).*(approve|go ahead)/.test(t)) {
    const p = byId(w.projects, 'PRJ-VELA-E7');
    if (p?.status === 'proposed') P('approve_project', { projectId: p.id }, 'Approve the Vela Euro 7 compliance project.');
  }
  // Catalogue projects named in an instruction
  const projectIntents: [RegExp, string][] = [
    [/(hybrid|revamp|refresh|facelift|upgrade|modernis|moderniz).{0,40}vela|vela.{0,40}(hybrid|revamp|refresh|facelift|upgrade|modernis|moderniz)/, 'vela_hybrid_refresh'],
    [/kora gt|premium (line|trim|version)/, 'kora_premium'],
    [/automation|cost.?down|automate lyon/, 'lyon_cost_down'],
    [/second (battery )?source|qualify hanseatic/, 'second_battery_source'],
    [/brno.{0,30}(expansion|capacity|expand)|expand.{0,20}brno/, 'brno_eon_expansion'],
    [/quality (and warranty )?programme|quality program|warranty programme/, 'quality_programme'],
    [/direct (online )?sales|online sales/, 'direct_sales'],
    [/compact ev|\bnova\b|vela successor/, 'compact_ev'],
  ];
  if (/(start|launch|begin|kick off|go ahead|green light|revamp|refresh|upgrade|let'?s do|we should do|approve|fund)/.test(t)) {
    for (const [re, key] of projectIntents) {
      if (!re.test(t)) continue;
      const tpl = PROJECT_TEMPLATES.find((x) => x.key === key);
      if (tpl && !w.projects.some((p) => p.templateKey === key && !['cancelled', 'completed'].includes(p.status))) P('start_project', { templateKey: key }, `Start ${tpl.name} (${fmtEur(tpl.budgetCents)}, ${tpl.fte} engineers${tpl.budgetCents > mEur(50) ? '; needs the board' : ''}).`);
      break;
    }
  }
  // Issues
  const optMap: [RegExp, string, string][] = [
    [/external (lab|test)|test capacity/, 'ISS-THERMAL', 'external_lab'],
    [/redesign|barrier/, 'ISS-THERMAL', 'barrier_redesign'],
    [/conditional sign|accept (the )?risk/, 'ISS-THERMAL', 'conditional_signoff'],
    [/software house|contractors/, 'ISS-EON-BMS', 'software_house'],
    [/service campaign|recall campaign|proactive campaign/, 'ISS-KORA-INV', 'service_campaign'],
    [/investigat|root cause/, 'ISS-KORA-INV', 'investigate'],
  ];
  for (const [re, issueId, key] of optMap) {
    const iss = byId(w.issues, issueId);
    if (re.test(t) && iss && !['resolved', 'closed'].includes(iss.status) && iss.options.some((o) => o.key === key) && !iss.chosenOptions.includes(key)) P('address_issue', { issueId, optionKey: key }, `${iss.title}: ${iss.options.find((o) => o.key === key)!.label}.`);
  }
  // Pricing
  const modelId = ids.find((x) => x.startsWith('MDL-'));
  const pct = pctIn(t);
  if (modelId && pct && /(price|discount|incentive)/.test(t)) {
    const m = byId(w.models, modelId)!;
    const down = /(cut|lower|reduce|discount|decrease|drop)/.test(t);
    const newPrice = Math.round((m.netPriceCents * (down ? 1 - pct : 1 + pct)) / 1000) * 1000;
    P('change_price', { modelId, netPriceCents: newPrice, reason: `CEO: ${down ? 'cut' : 'raise'} price by ${(pct * 100).toFixed(1)}%` }, `${down ? 'Cut' : 'Raise'} the ${m.name} net price by ${(pct * 100).toFixed(1)}% to ${fmtEur(newPrice)}.`);
  }
  // Production
  const rate = intIn(t, /(\d{2,4})\s*(?:cars|vehicles|units|jobs)?\s*(?:a|per)\s*day/);
  if (rate !== null && /(production|build|rate|line|output)/.test(t)) {
    const line = w.lines.find((l) => ids.includes(l.modelId) || ids.includes(l.factoryId)) ?? (modelId ? w.lines.find((l) => l.modelId === modelId) : undefined);
    if (line) P('adjust_production', { lineId: line.id, plannedDailyRate: rate, reason: 'CEO instruction' }, `Set ${line.name} to ${rate}/day.`);
  } else if (pct && /(cut|reduce|lower).*(production|output)/.test(t)) {
    const line = w.lines.find((l) => ids.includes(l.modelId) || ids.includes(l.factoryId));
    if (line) P('adjust_production', { lineId: line.id, plannedDailyRate: Math.round(line.plannedDailyRate * (1 - pct)), reason: 'CEO instruction' }, `Reduce ${line.name} by ${(pct * 100).toFixed(0)}%.`);
  }
  // Hiring / restructuring
  const n = intIn(t, /(\d[\d,]*)\s*(?:people|engineers|workers|operators|staff|jobs|positions|employees)/);
  const dept = w.departments.find((d) => (d.factoryId && ids.includes(d.factoryId)) || t.includes(d.name.toLowerCase().split(' ')[0])) ?? (/engineer/.test(t) ? byId(w.departments, 'DEP-BEC') : undefined);
  if (n && dept && /(hire|recruit)/.test(t)) P('hire_staff', { departmentId: dept.id, headcount: n, reason: 'CEO instruction' }, `Recruit ${n} for ${dept.name}.`);
  if (n && dept && /(cut|lay ?off|redundan|reduce headcount|eliminate)/.test(t)) P('restructure_workforce', { departmentId: dept.id, reduction: n, mode: /voluntar/.test(t) ? 'voluntary' : 'compulsory', reason: 'CEO instruction' }, `${/voluntar/.test(t) ? 'Voluntary' : 'Compulsory'} reduction of ${n} at ${dept.name}.`);
  // Financing
  const amount = parseMoney(msg);
  if (/(my own money|personal(ly)?|out of my pocket|my own funds)/.test(t) && amount) P('request_financing', { kind: 'ceo_contribution', amountCents: amount, rationale: 'CEO offers to invest personal funds.' }, 'CEO personal share subscription (subject to source-of-funds verification and independent-director approval).');
  else if (/rights issue|equity|capital increase/.test(t) && amount) P('request_financing', { kind: 'rights_issue', amountCents: amount, rationale: 'CEO instruction' }, 'Prepare a rights issue (board and EGM required).');
  else if (/\bbond\b/.test(t) && /(issue|raise|launch)/.test(t) && amount) P('request_financing', { kind: 'bond', amountCents: amount, tenorYears: 5, rationale: 'CEO instruction' }, 'Mandate banks for a bond issue (board approval required).');
  else if (/(loan|borrow|term loan|refinanc)/.test(t) && amount && amount >= mEur(100)) P('request_financing', { kind: 'bank_term_loan', amountCents: amount, tenorYears: 5, rationale: 'CEO instruction' }, 'Ask Banque Continentale for a term loan (credit committee decides).');
  else if (/(draw|use) (the )?rcf|revolver/.test(t) && amount) P('request_financing', { kind: 'rcf_draw', amountCents: amount, rationale: 'CEO instruction' }, 'Draw on the revolving credit facility.');
  else if (/sale.and.lease|sell (the )?(hq|headquarters|campus)/.test(t)) P('request_financing', { kind: 'sale_leaseback', amountCents: mEur(175), rationale: 'CEO instruction' }, 'Market the HQ campus for a sale-and-leaseback.');
  // Negotiations
  if (/(open|start|begin).*(talks|negotiat)/.test(t)) {
    for (const tpl of Object.values(NEGOTIATION_TEMPLATES)) {
      const cp = byId(w.characters, tpl.counterpartyId);
      if (cp && (t.includes(cp.name.split(' ').pop()!.toLowerCase()) || t.includes(cp.orgName.split(' ')[0].toLowerCase())) && !w.negotiations.some((x) => x.templateKey === tpl.key && x.status === 'open')) P('open_negotiation', { templateKey: tpl.key }, `Open: ${tpl.title}.`);
    }
  }
  // Board
  if (/(call|convene).*(board meeting|extraordinary)/.test(t) && date) P('call_board_meeting', { date, reason: 'CEO request' }, `Extraordinary board meeting on ${date}.`);
  return { proposals: out.slice(0, 3), notes };
}

export function detectCommitments(w: World, msg: string, promiseeId: string): CharacterTurn['ceo_commitments'] {
  const out: CharacterTurn['ceo_commitments'] = [];
  const sentences = msg.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (/\b(i promise|i commit|i guarantee|you have my word|i will make sure|i'll make sure|i give you my word|we will guarantee|i pledge)\b/i.test(s)) {
      out.push({ description: s.trim().replace(/^(and|but)\s+/i, '').slice(0, 300), due_date: parseLooseDate(s, w.meta.currentDate), promisee_id: promiseeId });
    }
  }
  return out.slice(0, 2);
}

function stanceFor(c: Character, w: World, msg: string): CharacterTurn['perspective']['stance'] {
  const t = msg.toLowerCase();
  if (c.trustInCeo < 30) return 'opposed';
  if (/(failure is not an option|no excuses|whatever it takes)/.test(t) && c.riskTolerance < 40) return 'skeptical';
  if (c.id === 'CHR-HOLM' && /(spend|invest|discount|hire|loan|borrow|accelerate)/.test(t)) return 'skeptical';
  if (c.id === 'CHR-GARNIER' && /(discount|price cut|marketing|volume)/.test(t)) return 'supportive';
  if (c.org === 'union' && /(cut|layoff|redundan|automation)/.test(t)) return 'opposed';
  return c.trustInCeo >= 60 ? 'supportive' : 'neutral';
}

/** Facts this character would cite, in their voice (all from authoritative state). */
function domainFacts(w: World, c: Character, msg: string): string[] {
  const facts: string[] = [];
  const ids = mentionedEntities(w, msg);
  const eon = byId(w.projects, 'PRJ-EON');
  const fc = w.meta.lastForecastSummary;
  const wantsEon = ids.includes('PRJ-EON') || c.knowledgeScope.includes('eon');
  if (c.org === 'asterion' || c.org === 'board') {
    if (wantsEon && eon) {
      facts.push(`The Eon target is ${fmtDate(eon.targetDate)}; our current forecast is ${eon.forecastDate ? fmtDate(eon.forecastDate) : 'that it cannot finish until battery supply of 250 packs a day is secured'}${eon.forecastP80Date ? ` (P80 ${fmtDate(eon.forecastP80Date)})` : ''}.`);
      const open = w.issues.filter((i) => i.projectId === 'PRJ-EON' && !['resolved', 'closed'].includes(i.status));
      if (open.length) facts.push(`Open issues: ${open.map((i) => `${i.title} (${Math.round((i.resolutionWorkDone / Math.max(1, i.resolutionWorkTotal)) * 100)}% worked off)`).join('; ')}.`);
      const vol = byId(w.issues, 'ISS-VOLTARIS');
      if (vol && vol.status !== 'resolved') facts.push('Voltaris is still contracted for only 140 packs a day.');
    }
    if (c.id === 'CHR-HOLM' || ids.includes('DEBT-BOND28')) {
      facts.push(`Cash is ${fmtEur(cash(w))}, liquidity including the RCF ${fmtEur(liquidity(w))}, net leverage ${netLeverage(w).toFixed(2)}x against a 3.50x covenant.`);
      if (fc) facts.push(`Our latest forecast shows ${fmtEur(fc.fyEbitCents)} operating profit for the year against a board plan of ${fmtEur(w.meta.boardPlan.ebitTargetCents)}, and 12-month minimum liquidity of ${fmtEur(fc.minLiquidity12mCents ?? fc.minLiquidityCents)} — that is an estimate.`);
    }
    if (c.id === 'CHR-GARNIER' || ids.some((x) => x.startsWith('MDL-'))) {
      for (const m of w.models.filter((x) => x.status === 'in_production')) facts.push(`${m.name}: dealers hold ${m.dealerStock.toLocaleString('en-GB')} cars; we sold ${m.retailLastMonth.toLocaleString('en-GB')} last month and expect about ${Math.round(modelMonthlyDemand(w, m, w.meta.currentDate)).toLocaleString('en-GB')} this month (estimate).`);
    }
    if (c.id === 'CHR-MARCHETTI' || ids.some((x) => x.startsWith('FAC-'))) {
      for (const l of w.lines.filter((x) => x.status !== 'not_ready')) facts.push(`${l.name} is planned at ${l.plannedDailyRate}/day (max ${l.maxDailyRate}).`);
    }
    if (c.id === 'CHR-OKAFOR' || c.id === 'CHR-PETIT') {
      const neg = byId(w.negotiations, 'NEG-UNION');
      if (neg) facts.push(`The wage negotiation is ${neg.status}; the union's latest position is ${NEGOTIATION_TEMPLATES[neg.templateKey].describe(lastCounter(neg) ?? neg.ideal)}.`);
    }
  } else {
    const negs = w.negotiations.filter((n) => n.counterpartyId === c.id && n.status === 'open');
    for (const n of negs) facts.push(`Our position on “${n.title}” stands: ${NEGOTIATION_TEMPLATES[n.templateKey].describe(lastCounter(n) ?? n.ideal)}.`);
    if (c.org === 'bank') facts.push(`Asterion is rated ${w.meta.creditRating} with a ${w.meta.ratingOutlook} outlook; the €900m notes mature in November 2028.`);
  }
  const revealed = c.privateInfo.filter((p) => c.trustInCeo >= p.revealAtTrust + 5);
  if (revealed.length && /(honest|frankly|between us|really|truth|candid|what do you think)/i.test(msg)) facts.push(`Frankly: ${revealed[0].fact}`);
  return facts.slice(0, 5);
}

/** Which catalogue reports a message is about (most relevant first). */
const REPORT_INTENTS: [RegExp, string][] = [
  [/(losing money|lose money|lost money|where.{0,20}money|p ?& ?l|profit and loss|income statement|break.?even|why .{0,20}(loss|losing)|cost breakdown|break ?down)/, 'pnl'],
  [/(margin|per car|unit cost|profitab|contribution|each car)/, 'unit_economics'],
  [/(cash|liquidity|burn)/, 'cash'],
  [/(forecast|outlook|projection|next (year|months))/, 'forecast'],
  [/(debt|covenant|leverage|\bbond\b|loan|rating|refinanc)/, 'debt'],
  [/(market share|competitor|competition|segment|rival)/, 'market'],
  [/(marketing|campaign|advertis|brand)/, 'marketing'],
  [/(sales|selling|sold|demand|stock|dealer)/, 'sales'],
  [/(production|plant|factory|factories|\bline\b|capacity|output|utili[sz]ation)/, 'production'],
  [/(supplier|supply|battery|component|shortage)/, 'supply'],
  [/(quality|warranty|defect|recall)/, 'quality'],
  [/(workforce|headcount|staff|people|employees|morale|hiring|surplus)/, 'workforce'],
  [/(project|portfolio|engineers)/, 'projects'],
  [/(co2|co₂|emission|euro ?7)/, 'co2'],
  [/(contract|agreement|obligation|legal|sign)/, 'contracts'],
  [/(profit|loss|earn|costs?\b|result|financ)/, 'pnl'],
];

export function reportIntents(msg: string): string[] {
  const t = msg.toLowerCase();
  const out: string[] = [];
  for (const [re, key] of REPORT_INTENTS) if (re.test(t) && !out.includes(key)) out.push(key);
  return out;
}

export function fallbackTurn(w: World, c: Character, msg: string, summary: string): CharacterTurn {
  const stance = stanceFor(c, w, msg);
  const { proposals, notes } = detectProposals(w, msg, c);
  const facts = domainFacts(w, c, msg);
  const t = msg.toLowerCase();
  const openers: Record<string, string[]> = {
    supportive: ['I can work with that.', 'Understood — let me be concrete.', 'Good, that is the right question.'],
    neutral: ['Let me give you the facts first.', 'Fair question.', 'Here is where we actually stand.'],
    skeptical: ['I have to push back a little.', 'Before we commit to that, look at the numbers.', 'I understand the intent, but I am not comfortable yet.'],
    opposed: ['With respect, I cannot support that.', 'No — not on this basis.', 'You are asking for something I will fight.'],
  };
  const parts = [pick(openers[stance], c.id + msg.length)];
  if (/(failure is not an option|no excuses|whatever it takes)/.test(t) && c.org === 'asterion') parts.push('Pressure does not shorten a test programme. Resources, scope or the date can move — physics cannot.');
  parts.push(...facts);
  parts.push(...notes);
  if (proposals.length) parts.push(`I have put ${proposals.length === 1 ? 'a concrete proposal' : `${proposals.length} concrete proposals`} on the table for your decision — the numbers and consequences are attached.`);
  else if (c.org === 'asterion' && facts.length === 0) parts.push(`Tell me what you want to change — price, production, staffing, a project or financing — and I will put a concrete proposal in front of you.`);
  if (c.org === 'union' && /(wage|raise|pay|offer)/.test(t)) parts.push('Put a number on the table in the negotiation. Words are cheap; our members will judge you on the agreement.');
  if (c.org === 'supplier' && /(volume|capacity|price|prepay)/.test(t)) parts.push('If you want capacity, make us an offer in the negotiation. Our line will not finance itself.');
  const commitments = detectCommitments(w, msg, c.id);
  if (commitments.length) parts.push('I will hold you to that.');
  // Reports: attach the ones this person produces that the question is about; circulate them when asked.
  const owned = c.org === 'asterion' ? reportsOwnedBy(c.id).map((r) => r.key) : [];
  const wanted = reportIntents(msg).filter((k) => owned.includes(k)).slice(0, 2);
  const asksData = /(\?|how|what|why|show|report|numbers|figures|data|analy|explain|break)/i.test(msg);
  const attach = asksData ? wanted : [];
  if (attach.length) parts.push(`I have attached the ${attach.map((k) => `“${REPORT_BY_KEY.get(k)?.title}”`).join(' and ')} with the current figures.`);
  const share_reports: CharacterTurn['share_reports'] = [];
  if (/(send|share|forward|circulate|copy)\b.{0,80}\bto\b/i.test(msg) && owned.length) {
    const recipients = w.characters.filter((x) => x.active && x.id !== c.id && (x.org === 'asterion' || x.org === 'board') && msg.toLowerCase().includes(x.name.split(' ').pop()!.toLowerCase())).map((x) => x.id);
    const key = wanted[0] ?? owned[0];
    if (recipients.length) {
      share_reports.push({ report: key, recipient_ids: recipients, note: 'Sent at the CEO’s request.' });
      parts.push(`I will send the “${REPORT_BY_KEY.get(key)?.title}” to ${recipients.map((id) => byId(w.characters, id)?.name).join(', ')} right away.`);
    }
  }
  const outsideScope = reportIntents(msg).filter((k) => !owned.includes(k));
  const request_reports: CharacterTurn['request_reports'] = c.org === 'asterion' && asksData && !attach.length && outsideScope.length ? [{ report: outsideScope[0], reason: `I would need the ${REPORT_BY_KEY.get(outsideScope[0])?.title ?? outsideScope[0]} to answer that properly.` }] : [];
  if (request_reports.length) parts.push(`That is not my department's data — send me the ${REPORT_BY_KEY.get(request_reports[0].report)?.title} and I will give you my view.`);
  const dialogue = parts.join(' ');
  const trust = commitments.length ? 1 : stance === 'opposed' ? -1 : 0;
  return {
    dialogue,
    emotion: stance === 'opposed' ? 'frustrated' : stance === 'skeptical' ? 'wary' : stance === 'supportive' ? 'engaged' : 'measured',
    perspective: { stance, concerns: c.objectives.slice(0, 2), interests: [c.incentives] },
    proposed_actions: proposals,
    claims: facts.map((f) => ({ statement: f.slice(0, 380), basis: /estimate|forecast|expect/.test(f) ? 'estimate' : 'fact', entity_ids: [] })),
    memory_candidates: [{ summary: `CEO discussed: ${msg.slice(0, 160)}${msg.length > 160 ? '…' : ''}`, importance: proposals.length || commitments.length ? 3 : 2, sentiment: trust, kind: commitments.length ? 'promise' : 'conversation' }],
    ceo_commitments: commitments,
    event_proposals: [],
    trust_delta: trust,
    trust_reason: commitments.length ? 'The CEO made an explicit commitment.' : stance === 'opposed' ? 'Disagreement with the CEO’s instruction.' : 'Routine exchange.',
    follow_up_questions: proposals.length ? ['Do you want me to proceed on that basis?'] : [],
    attach_reports: attach,
    request_reports,
    share_reports,
    summary_update: `${summary ? `${summary} ` : ''}${fmtDate(w.meta.currentDate)}: CEO — “${msg.slice(0, 140)}”. ${c.name.split(' ').pop()} (${stance})${proposals.length ? ` proposed ${proposals.map((p) => p.type).join(', ')}` : ''}.`.slice(-1100),
  };
}

export function fallbackNegotiationLine(c: Character, outcome: string, response: string): string {
  const voice: Record<string, string> = {
    accepted: `${c.name.split(' ')[0]} nods. "We have a deal in principle. Let our lawyers prepare the signature."`,
    pending_approval: `"I can live with this, but I need my people to approve it. You will have an answer shortly."`,
    countered: `"Not yet. Here is what would work for us."`,
    rejected_final: `"We are done for now."`,
  };
  return `${voice[outcome] ?? ''} ${response}`.trim();
}

export function daysUntil(w: World, d: string): number {
  return diffDays(d, w.meta.currentDate);
}
