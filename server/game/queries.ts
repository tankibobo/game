/**
 * Read models for the UI. Everything displayed comes from authoritative state
 * or is explicitly labelled as an estimate/forecast. Private information
 * (characters' private facts, counterparties' reservation values) is stripped.
 */
import type { ActionRecord, Character, Negotiation } from '../../shared/domain';
import { addDays, diffDays, monthKey, type SimDate } from '../../shared/dates';
import type { DB } from '../db/connection';
import { loadJournal, loadWorld, rowToAction, rowToConversation, rowToEvent, rowToForecast, rowToHistory, rowToInbox, rowToMemory, rowToMessage } from '../db/repo';
import { boardMembers, confidenceTarget, predictVote, proposalActionIds, upcomingMeeting } from '../engine/board';
import { co2Target, fleetCo2Ytd } from '../engine/close';
import { modelAppeal, modelMonthlyDemand, powertrainPref, segmentMarketMonthly, segmentShares } from '../engine/demand';
import { EVENT_CATALOGUE } from '../engine/events';
import { balanceSheetFromBalances, balancesFromEntries, cashFlowFromEntries, incomeStatementFromMovements, movements } from '../engine/ledger';
import { engineeringFreeFte, grossDebt, headcount, interestCover, liquidity, netDebt, netLeverage, rcf, SUSTAINING_ENGINEERING_FTE } from '../engine/metrics';
import { NEGOTIATION_TEMPLATES, lastCounter } from '../engine/negotiation';
import { availableCrew, requiredCrew, unitCostOf } from '../engine/operations';
import { RULES } from '../engine/params';
import { milestonesOf } from '../engine/projects';
import { byId, type World } from '../engine/world';
import { difficultyOf } from '../engine/difficulty';
import { mandateObjectives, mandateScore } from '../engine/mandate';
import { ACTIONS } from '../actions/registry';
import { PROJECT_TEMPLATES } from '../actions/templates';
import { templateStatus } from './decisions';
import { unitMaterialCost, FY2026 } from '../scenario/initial';

type Row = Record<string, unknown>;

export function publicCharacter(c: Character) {
  const { privateInfo: _p, ...rest } = c;
  return { ...rest, privateInfoCount: c.privateInfo.length };
}

export function publicNegotiation(n: Negotiation) {
  const tpl = NEGOTIATION_TEMPLATES[n.templateKey];
  return {
    id: n.id,
    templateKey: n.templateKey,
    title: n.title,
    counterpartyId: n.counterpartyId,
    status: n.status,
    terms: n.terms,
    deadline: n.deadline,
    createdDate: n.createdDate,
    agreedTerms: n.agreedTerms,
    contractId: n.contractId,
    linkedIssueId: n.linkedIssueId,
    context: n.context,
    pendingDecision: n.pendingDecision,
    maxRounds: n.maxRounds,
    roundsUsed: n.rounds.filter((r) => r.by === 'ceo').length,
    latestCounter: lastCounter(n),
    latestCounterText: lastCounter(n) ? tpl.describe(lastCounter(n)!) : null,
    rounds: n.rounds.map((r) => ({ n: r.n, date: r.date, by: r.by, terms: r.terms, message: r.message, evaluation: r.evaluation ? { accepted: r.evaluation.accepted, violations: r.evaluation.violations, notes: r.evaluation.notes } : null })),
  };
}

function pendingActions(db: DB): ActionRecord[] {
  return (db.prepare("SELECT * FROM actions WHERE status IN ('pending_confirmation','pending_approval','approved') ORDER BY created_at DESC LIMIT 50").all() as Row[]).map(rowToAction);
}

function recentEvents(db: DB, limit = 25) {
  return (db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit) as Row[]).map(rowToEvent);
}

export function latestForecast(db: DB) {
  const r = db.prepare('SELECT * FROM forecasts ORDER BY rowid DESC LIMIT 1').get() as Row | undefined;
  return r ? rowToForecast(r) : null;
}

export function dashboard(db: DB) {
  const w = loadWorld(db);
  const d = w.meta.currentDate;
  const year = d.slice(0, 4);
  const ytd = incomeStatementFromMovements(w.meta.ytdByAccount);
  const months = w.snapshots.filter((s) => s.kind === 'month').sort((a, b) => (a.period < b.period ? -1 : 1));
  const lastMonth = months[months.length - 1];
  const commitments = w.commitments.filter((c) => ['open', 'due'].includes(c.status)).sort((a, b) => ((a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : 1));
  const fc = latestForecast(db);
  const conf = confidenceTarget(w);
  return {
    meta: { ...w.meta, mtdByAccount: undefined, ytdByAccount: undefined, cfMtd: undefined },
    kpis: {
      cashCents: w.balances['1000'] ?? 0,
      liquidityCents: liquidity(w),
      grossDebtCents: grossDebt(w),
      netDebtCents: netDebt(w),
      netLeverage: netLeverage(w),
      interestCover: interestCover(w),
      rcfDrawnCents: rcf(w)?.principalCents ?? 0,
      rcfLimitCents: rcf(w)?.limitCents ?? 0,
      revenueYtdCents: ytd.revenue,
      ebitYtdCents: ytd.ebit,
      netIncomeYtdCents: ytd.netIncome,
      ebitdaYtdCents: ytd.ebitda,
      headcount: headcount(w),
      fleetCo2: fleetCo2Ytd(w),
      co2Target: co2Target(w, Number(year)),
      yearLabel: year,
    },
    lastMonth: lastMonth ?? null,
    months: months.filter((m) => m.period >= '2026-07'),
    models: w.models.map((m) => ({ id: m.id, name: m.name, status: m.status, fgUnits: m.fgUnits, dealerStock: m.dealerStock, backlog: m.backlog, retailLastMonth: m.retailLastMonth, productionLastMonth: m.productionLastMonth, wholesaleLastMonth: m.wholesaleLastMonth, retailMtd: m.retailMtd, productionMtd: m.productionMtd, demandEstimate: Math.round(modelMonthlyDemand(w, m, d)), netPriceCents: m.netPriceCents })),
    projects: w.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, priority: p.priority, targetDate: p.targetDate, originalTargetDate: p.originalTargetDate, forecastDate: p.forecastDate, forecastP80Date: p.forecastP80Date, budgetCents: p.budgetCents, spentCents: p.spentCents, progress: progressOf(w, p.id) })),
    issues: w.issues.filter((i) => !['resolved', 'closed'].includes(i.status)).sort((a, b) => sevRank(b.severity) - sevRank(a.severity)),
    commitments: { upcoming: commitments.filter((c) => !c.dueDate || c.dueDate >= d).slice(0, 10), overdue: commitments.filter((c) => c.dueDate && c.dueDate < d) },
    board: { confidence: w.meta.boardConfidence, target: conf.target, factors: conf.factors, nextMeeting: upcomingMeeting(w), scheduled: w.boardProposals.filter((p) => p.status === 'scheduled'), plan: w.meta.boardPlan, lowConfidenceMeetings: w.meta.lowConfidenceMeetings, dismissalThreshold: difficultyOf(w).dismissalThreshold, dismissalMeetings: difficultyOf(w).dismissalMeetings },
    mandate: (() => {
      const objectives = mandateObjectives(w);
      return { score: mandateScore(objectives), passScore: difficultyOf(w).passScore, termEnd: w.meta.termEndDate, difficulty: difficultyOf(w).label, objectives, result: w.meta.mandate };
    })(),
    debtMaturities: w.debts.filter((x) => x.status === 'active').map((x) => ({ id: x.id, name: x.name, principalCents: x.principalCents, maturityDate: x.maturityDate, nextAmortization: x.amortization.find((a) => a.date >= d) ?? null })).sort((a, b) => (a.maturityDate < b.maturityDate ? -1 : 1)),
    covenants: w.covenants,
    forecast: fc ? { createdDate: fc.createdDate, trigger: fc.trigger, scenarios: fc.data.scenarios.map((s) => ({ key: s.key, label: s.label, summary: s.summary, months: s.months })), notes: fc.data.notes } : null,
    events: recentEvents(db, 25),
    pendingActions: pendingActions(db),
    unreadInbox: (db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE read = 0').get() as { n: number }).n,
    briefing: (db.prepare("SELECT * FROM inbox WHERE kind = 'briefing' ORDER BY rowid DESC LIMIT 1").get() as Row | undefined) ? rowToInbox(db.prepare("SELECT * FROM inbox WHERE kind = 'briefing' ORDER BY rowid DESC LIMIT 1").get() as Row) : null,
    fy2026: FY2026,
    names: Object.fromEntries(w.characters.map((c) => [c.id, c.name])),
  };
}

function sevRank(s: string) {
  return ({ low: 0, medium: 1, high: 2, critical: 3 } as Record<string, number>)[s] ?? 0;
}

function progressOf(w: World, projectId: string): number {
  const ms = milestonesOf(w, projectId);
  const tot = ms.reduce((a, m) => a + m.workTotal, 0);
  return tot > 0 ? ms.reduce((a, m) => a + Math.min(m.workDone, m.workTotal), 0) / tot : 0;
}

export function company(db: DB) {
  const w = loadWorld(db);
  return {
    characters: w.characters.map(publicCharacter),
    relationships: w.relationships,
    departments: w.departments,
    board: boardMembers(w).map((m) => m.id),
    rules: {
      ceoSpendLimitCents: RULES.ceoSpendLimitCents,
      ceoFinancingLimitCents: RULES.ceoFinancingLimitCents,
      boardRestructuringHeadcount: RULES.boardRestructuringHeadcount,
      ceoHiringLimit: RULES.ceoHiringLimit,
      matrix: [
        { decision: 'Spending / budgets / project approval', ceo: '≤ €50m', board: '> €50m', delegated: 'CFO ≤ €10m · COO/CTO ≤ €5m · CPO ≤ €5m · CSO ≤ €3m · CPeO ≤ €2m' },
        { decision: 'New borrowing', ceo: '≤ €100m (bank loans), RCF draws', board: '> €100m, all bonds', delegated: 'CFO: RCF draws ≤ €100m' },
        { decision: 'Equity issuance', ceo: '—', board: 'Board + shareholders (EGM)', delegated: '—' },
        { decision: 'Related-party transactions', ceo: '—', board: 'Independent directors', delegated: '—' },
        { decision: 'Workforce reductions', ceo: '≤ 300 jobs (after 60-day consultation)', board: '> 300 jobs', delegated: '—' },
        { decision: 'Hiring', ceo: '≤ 500 people per decision', board: '> 500', delegated: 'CPeO within approved headcount' },
        { decision: 'Prices & production plans', ceo: 'Yes', board: '—', delegated: 'CSO ±3% tactical · COO production' },
        { decision: 'Cancel a vehicle programme', ceo: '—', board: 'Yes', delegated: '—' },
        { decision: 'Asset sales (e.g. HQ sale-and-leaseback)', ceo: '—', board: 'Yes', delegated: '—' },
      ],
    },
    memoriesByCharacter: Object.fromEntries(w.characters.map((c) => [c.id, (db.prepare('SELECT * FROM character_memories WHERE character_id = ? ORDER BY seq DESC LIMIT 12').all(c.id) as Row[]).map(rowToMemory)])),
  };
}

export function products(db: DB) {
  const w = loadWorld(db);
  const d = w.meta.currentDate;
  return {
    models: w.models.map((m) => {
      const mat = unitMaterialCost(w, m);
      const contribution = m.netPriceCents - mat - m.logisticsPerUnitCents - m.warrantyPerUnitCents;
      return { ...m, appeal: modelAppeal(m, d), unitMaterialCostCents: mat, avgInventoryCostCents: unitCostOf(m), contributionPerUnitCents: contribution, marginPct: contribution / m.netPriceCents, demandEstimate: Math.round(modelMonthlyDemand(w, m, d)), dealerStockDays: m.retailLastMonth > 0 ? Math.round((m.dealerStock / m.retailLastMonth) * 30) : null };
    }),
    segments: w.segments.map((s) => ({ ...s, marketMonthly: Math.round(segmentMarketMonthly(w, s, d)), powertrainPrefNow: powertrainPref(w, s, d), shares: segmentShares(w, s.id, d).map((r) => ({ ...r, share: Math.round(r.share * 10000) / 10000, monthlyUnits: Math.round(r.monthlyUnits) })) })),
    competitorProducts: w.competitorProducts,
    competitors: w.competitors,
    templates: PROJECT_TEMPLATES.map((t) => ({ key: t.key, name: t.name, strategy: t.strategy, objective: t.objective, budgetCents: t.budgetCents, fte: t.fte, durationDays: t.durationDays, tradeoffs: t.tradeoffs, active: w.projects.some((p) => p.templateKey === t.key && !['completed', 'cancelled'].includes(p.status)), ...templateStatus(w, t.key) })),
    projects: w.projects.filter((p) => p.linkedModelId).map((p) => ({ id: p.id, name: p.name, linkedModelId: p.linkedModelId, status: p.status, targetDate: p.targetDate, forecastDate: p.forecastDate })),
  };
}

export function projectsView(db: DB) {
  const w = loadWorld(db);
  const history = (db.prepare('SELECT * FROM project_history ORDER BY date DESC, rowid DESC LIMIT 400').all() as Row[]).map(rowToHistory);
  return {
    today: w.meta.currentDate,
    engineering: { freeFte: Math.floor(engineeringFreeFte(w)), sustainingFte: SUSTAINING_ENGINEERING_FTE, headcount: w.departments.filter((x) => x.kind === 'engineering').reduce((a, x) => a + x.headcount, 0) },
    projects: w.projects.map((p) => ({ ...p, progress: progressOf(w, p.id), milestones: milestonesOf(w, p.id), issues: w.issues.filter((i) => i.projectId === p.id || i.linked.some((l) => l.id === p.id)), history: history.filter((h) => h.projectId === p.id) })),
    issues: w.issues,
    templates: PROJECT_TEMPLATES.map((t) => ({ key: t.key, name: t.name, strategy: t.strategy, budgetCents: t.budgetCents, fte: t.fte, durationDays: t.durationDays, tradeoffs: t.tradeoffs, objective: t.objective, ...templateStatus(w, t.key) })),
  };
}

export function operations(db: DB) {
  const w = loadWorld(db);
  const d = w.meta.currentDate;
  return {
    today: d,
    factories: w.factories.map((f) => ({ ...f, workforce: byId(w.departments, f.departmentId)?.headcount ?? 0, morale: byId(w.departments, f.departmentId)?.morale ?? 0, requiredCrew: Math.round(requiredCrew(w, f, d)), availableCrew: Math.round(availableCrew(w, f)), upcomingDowntime: f.downtime.filter((x) => x.end >= d).sort((a, b) => (a.start < b.start ? -1 : 1)) })),
    lines: w.lines,
    suppliers: w.suppliers,
    supplies: w.supplies,
    models: w.models.map((m) => ({ id: m.id, name: m.name, status: m.status, fgUnits: m.fgUnits, fgValueCents: m.fgValueCents, dealerStock: m.dealerStock, backlog: m.backlog, retailLastMonth: m.retailLastMonth, productionLastMonth: m.productionLastMonth, wholesaleLastMonth: m.wholesaleLastMonth, demandEstimate: Math.round(modelMonthlyDemand(w, m, d)) })),
    departments: w.departments,
    contracts: w.contracts.filter((c) => c.kind === 'supply' || c.kind === 'labor'),
  };
}

export function statement(db: DB, from: SimDate, to: SimDate) {
  const entries = loadJournal(db, '0000-01-01', to);
  const inPeriod = entries.filter((e) => e.date >= from && e.date <= to && e.sourceType !== 'opening');
  const is = incomeStatementFromMovements(movements(inPeriod, from, to));
  const cf = cashFlowFromEntries(entries, from, to);
  const bs = balanceSheetFromBalances(balancesFromEntries(entries, to));
  const bsOpen = balanceSheetFromBalances(balancesFromEntries(entries, addDays(from, -1)));
  return { from, to, incomeStatement: is, cashFlow: cf, balanceSheet: bs, openingBalanceSheet: bsOpen, reconciliation: { cashChange: bs.cash - bsOpen.cash, cashFlowNet: cf.netChange, difference: bs.cash - bsOpen.cash - cf.netChange, balanceSheetCheck: bs.check } };
}

export function finance(db: DB) {
  const w = loadWorld(db);
  const d = w.meta.currentDate;
  const snaps = (db.prepare("SELECT * FROM financial_snapshots WHERE kind = 'month' ORDER BY period").all() as Row[]).map((r) => ({ period: String(r.period), date: String(r.date), data: JSON.parse(String(r.data)) }));
  const ytdFrom = `${d.slice(0, 4)}-01-01`;
  const fc = latestForecast(db);
  const payables = db.prepare("SELECT category, SUM(amount_cents) AS amt, MIN(due_date) AS next_due, COUNT(*) AS n FROM payables WHERE status IN ('open','overdue') GROUP BY category").all() as Row[];
  const overdue = (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS amt FROM payables WHERE status = 'overdue'").get() as { amt: number }).amt;
  const receivables = (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS amt, COUNT(*) AS n FROM receivables WHERE status = 'open'").get() as { amt: number; n: number });
  return {
    today: d,
    ytd: statement(db, ytdFrom, addDays(d, -1) < ytdFrom ? ytdFrom : addDays(d, -1)),
    snapshots: snaps,
    debts: w.debts,
    covenants: w.covenants,
    metrics: { cashCents: w.balances['1000'] ?? 0, liquidityCents: liquidity(w), grossDebtCents: grossDebt(w), netDebtCents: netDebt(w), netLeverage: netLeverage(w), interestCover: interestCover(w), rating: w.meta.creditRating, outlook: w.meta.ratingOutlook, sharesOutstanding: w.meta.sharesOutstanding, sharePriceCents: w.meta.sharePriceCents, taxLossCarryforwardCents: w.meta.taxLossCarryforwardCents },
    financing: w.financing,
    forecast: fc,
    workingCapital: { payables, overdue, receivables, inventoryCents: w.balances['1200'] ?? 0 },
    budget: { marketingMonthlyCents: w.meta.marketingMonthlyCents, gaMonthlyCents: w.meta.gaMonthlyCents, sustainingCapexMonthlyCents: w.meta.sustainingCapexMonthlyCents, plan: w.meta.boardPlan },
    fy2026: FY2026,
    ceo: { personalLiquidCents: w.meta.ceoPersonalLiquidCents, netWorthCents: w.meta.ceoPersonalNetWorthCents },
  };
}

export function worldView(db: DB) {
  const w = loadWorld(db);
  const d = w.meta.currentDate;
  return {
    today: d,
    macro: w.macro,
    regulations: w.regulations,
    competitors: w.competitors.map((c) => ({ ...c, products: w.competitorProducts.filter((p) => p.competitorId === c.id) })),
    segments: w.segments.map((s) => ({ id: s.id, name: s.name, description: s.description, marketMonthly: Math.round(segmentMarketMonthly(w, s, d)), pref: powertrainPref(w, s, d), shares: segmentShares(w, s.id, d).map((r) => ({ id: r.id, name: r.name, kind: r.kind, powertrain: r.powertrain, priceCents: r.priceCents, share: r.share, monthlyUnits: Math.round(r.monthlyUnits) })) })),
    eventCatalogue: EVENT_CATALOGUE.map((e) => ({ key: e.key, label: e.label, kind: e.kind, frequency: e.frequency, cooldownDays: e.cooldownDays, preconditions: e.preconditions, magnitude: e.magnitude })),
    fleetCo2: fleetCo2Ytd(w),
    co2Target: co2Target(w, Number(d.slice(0, 4))),
  };
}

export function inboxView(db: DB) {
  const w = loadWorld(db);
  const items = (db.prepare('SELECT * FROM inbox ORDER BY date DESC, rowid DESC LIMIT 200').all() as Row[]).map(rowToInbox);
  const convs = (db.prepare('SELECT * FROM conversations ORDER BY last_date DESC, created_at DESC LIMIT 100').all() as Row[]).map(rowToConversation);
  return {
    today: w.meta.currentDate,
    items,
    conversations: convs,
    commitments: w.commitments,
    negotiations: w.negotiations.map(publicNegotiation),
    contracts: w.contracts,
    financing: w.financing,
    boardProposals: w.boardProposals.map((b) => {
      const ids = proposalActionIds(b);
      const decisions = ids.length ? (db.prepare(`SELECT id, summary, status FROM actions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; summary: string; status: string }[]) : [];
      return { ...b, decisions, outlook: b.status === 'scheduled' ? predictVote(w, b.analysis as Record<string, number>, b.rationale) : null };
    }),
    pendingActions: pendingActions(db),
    characters: w.characters.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, title: c.title, org: c.org, orgName: c.orgName, trustInCeo: c.trustInCeo })),
    negotiationTemplates: Object.values(NEGOTIATION_TEMPLATES).map((t) => ({ key: t.key, title: t.title, counterpartyId: t.counterpartyId, counterpartyName: byId(w.characters, t.counterpartyId)?.name ?? t.counterpartyId, open: w.negotiations.some((n) => n.templateKey === t.key && n.status === 'open'), unavailable: t.available?.(w) ?? null })),
    nextBoardMeeting: upcomingMeeting(w),
  };
}

export function conversationView(db: DB, id: string) {
  const conv = rowToConversation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row);
  const msgs = (db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(id) as Row[]).map(rowToMessage);
  const actions = (db.prepare('SELECT * FROM actions WHERE conversation_id = ? ORDER BY created_at').all(id) as Row[]).map(rowToAction);
  const w = loadWorld(db);
  const c = byId(w.characters, conv.characterId);
  const neg = conv.negotiationId ? byId(w.negotiations, conv.negotiationId) : w.negotiations.find((n) => n.counterpartyId === conv.characterId && n.status === 'open');
  return { conversation: conv, messages: msgs, actions, character: c ? publicCharacter(c) : null, negotiation: neg ? publicNegotiation(neg) : null };
}

export interface HistoryFilter {
  q?: string;
  type?: string;
  category?: string;
  severity?: string;
  entity?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function history(db: DB, f: HistoryFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  let join = '';
  if (f.q && f.q.trim()) {
    const terms = f.q.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
    join += ' JOIN events_fts ON events_fts.rowid = e.seq';
    where.push('events_fts MATCH ?');
    params.push(terms);
  }
  if (f.entity) {
    join += ' JOIN event_entities x ON x.event_id = e.id';
    where.push('x.entity_id = ?');
    params.push(f.entity);
  }
  if (f.type) {
    where.push('e.type = ?');
    params.push(f.type);
  }
  if (f.category) {
    where.push('e.category = ?');
    params.push(f.category);
  }
  if (f.severity) {
    where.push('e.severity = ?');
    params.push(f.severity);
  }
  if (f.from) {
    where.push('e.date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('e.date <= ?');
    params.push(f.to);
  }
  const sql = `SELECT DISTINCT e.* FROM events e${join}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY e.seq DESC LIMIT ?`;
  const events = (db.prepare(sql).all(...params, Math.min(500, f.limit ?? 200)) as Row[]).map(rowToEvent);
  const actions = (db.prepare("SELECT * FROM actions WHERE status NOT IN ('superseded') ORDER BY created_at DESC LIMIT 200").all() as Row[]).map(rowToAction);
  const types = (db.prepare('SELECT DISTINCT type FROM events ORDER BY type').all() as { type: string }[]).map((r) => r.type);
  return { events, actions, types };
}

export function journal(db: DB, from: string, to: string) {
  return loadJournal(db, from, to).slice(-500);
}

export function monthPeriod(d: SimDate) {
  return monthKey(d);
}

export function actionCatalog() {
  return ACTIONS.map((a) => ({ type: a.type, label: a.label, description: a.description, llmProposable: a.llmProposable }));
}

export function daysTo(a: SimDate, b: SimDate) {
  return diffDays(a, b);
}
