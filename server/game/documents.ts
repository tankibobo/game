/**
 * Documents the CEO can share with people (and memos the CEO can send).
 *
 * Characters often need information before they can help — a forecast, the
 * latest financials, a project status. A shared document is a snapshot built
 * from authoritative state at the moment it is shared. It is recorded once,
 * becomes part of each recipient's context (as dated facts) and memory, and
 * internal colleagues learn that it was circulated. Sharing never changes the
 * company itself.
 */
import { randomUUID } from 'node:crypto';
import { addDays, diffDays, fmtDate } from '../../shared/dates';
import { fmtEur } from '../../shared/money';
import type { DB } from '../db/connection';
import { loadWorld, writeWorld } from '../db/repo';
import { upcomingMeeting, proposalActionIds } from '../engine/board';
import { cash } from '../engine/ledger';
import { engineeringFreeFte, liquidity, netLeverage, rcf } from '../engine/metrics';
import { NEGOTIATION_TEMPLATES, lastCounter } from '../engine/negotiation';
import { milestonesOf } from '../engine/projects';
import { modelMonthlyDemand } from '../engine/demand';
import { byId, emit, remember, type World } from '../engine/world';
import { GameError } from './game';

export interface DocumentType {
  key: string;
  title: string;
  description: string;
  /** Which entity the document is about, if any. */
  param?: 'project' | 'negotiation' | 'board_proposal';
}

export const DOCUMENT_TYPES: DocumentType[] = [
  { key: 'forecast', title: 'Forecast report', description: '24-month base, downside and upside: operating profit, liquidity low point, Eon start of production, CO₂ premium.' },
  { key: 'financials', title: 'Financial results', description: 'Last month and year-to-date: revenue, margins, operating profit, cash flow.' },
  { key: 'liquidity', title: 'Liquidity & debt position', description: 'Cash, credit line, liquidity, debt maturities, covenants and financing in progress.' },
  { key: 'project_status', title: 'Project status report', description: 'One project: status, budget, staffing, milestones, open issues and forecast.', param: 'project' },
  { key: 'production', title: 'Production & sales report', description: 'Line rates, output, stocks, retail sales and estimated demand per model.' },
  { key: 'workforce', title: 'Workforce report', description: 'Headcount, morale, hiring and departures in progress, crew needs per plant.' },
  { key: 'board_plan', title: 'Board proposal', description: 'A proposal on the board agenda and the decisions it contains.', param: 'board_proposal' },
  { key: 'negotiation', title: 'Negotiation status', description: 'One negotiation: status, deadline, latest positions (no private limits).', param: 'negotiation' },
  { key: 'decisions', title: 'Decision log', description: 'Every decision you took in the last 90 days.' },
  { key: 'memo', title: 'Memo', description: 'A written message from you (your own words).' },
];

export interface SharedDocument {
  id: string;
  date: string;
  docKey: string;
  param: string | null;
  title: string;
  body: string;
  recipients: string[];
  note: string;
  conversationId: string | null;
  createdAt: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function buildBody(db: DB, w: World, key: string, param: string | null, note: string): { title: string; body: string } {
  const d = w.meta.currentDate;
  const lines: string[] = [];
  switch (key) {
    case 'forecast': {
      const row = db.prepare('SELECT * FROM forecasts ORDER BY rowid DESC LIMIT 1').get() as { created_date: string; data: string } | undefined;
      if (!row) throw new GameError('No forecast is available yet.');
      const data = JSON.parse(row.data) as { scenarios: { key: string; label: string; summary: Record<string, unknown> }[] };
      lines.push(`Forecast prepared ${fmtDate(row.created_date)} (estimates; excludes random shocks and decisions not yet taken).`);
      for (const sc of data.scenarios) {
        const s = sc.summary as { fyEbitCents: number; fyRevenueCents: number; minLiquidity12mCents?: number; minLiquidity12mDate?: string; minLiquidityCents: number; minLiquidityDate: string; eonSopForecast: string | null; eonSopConditional?: string | null; co2PenaltyFyCents: number };
        lines.push(`${sc.label}: FY revenue ${fmtEur(s.fyRevenueCents)}, FY operating profit ${fmtEur(s.fyEbitCents)}; 12-month liquidity low ${fmtEur(s.minLiquidity12mCents ?? s.minLiquidityCents)}${s.minLiquidity12mDate ? ` (${s.minLiquidity12mDate})` : ''}; 24-month low ${fmtEur(s.minLiquidityCents)} (${s.minLiquidityDate}); Eon SOP ${s.eonSopForecast ?? `blocked${s.eonSopConditional ? ` (≈${s.eonSopConditional} if supply secured)` : ''}`}; CO₂ premium ≈${fmtEur(s.co2PenaltyFyCents)}.`);
      }
      lines.push(`Board plan: operating profit ${fmtEur(w.meta.boardPlan.ebitTargetCents)}, minimum liquidity ${fmtEur(w.meta.boardPlan.minLiquidityCents)}, Eon SOP ${w.meta.boardPlan.eonSopDate}.`);
      return { title: `Forecast (${fmtDate(row.created_date)})`, body: lines.join('\n') };
    }
    case 'financials': {
      const months = w.snapshots.filter((s) => s.kind === 'month');
      const last = months[months.length - 1];
      if (!last) throw new GameError('No month has closed yet — financial results are available after the first month end.');
      const x = last.data;
      lines.push(`Month ${last.period}: revenue ${fmtEur(x.revenueCents)}, gross profit ${fmtEur(x.grossProfitCents)} (${pct(x.grossProfitCents / Math.max(1, x.revenueCents))}), operating profit ${fmtEur(x.ebitCents)} (${pct(x.ebitCents / Math.max(1, x.revenueCents))}), net income ${fmtEur(x.netIncomeCents)}.`);
      lines.push(`Cash flow: operating ${fmtEur(x.operatingCfCents)}, investing ${fmtEur(x.investingCfCents)}, financing ${fmtEur(x.financingCfCents)}. Month-end cash ${fmtEur(x.cashCents)}, debt ${fmtEur(x.debtCents)}, liquidity ${fmtEur(x.liquidityCents)}.`);
      const ytd = months.filter((m) => m.period.startsWith(d.slice(0, 4)));
      if (ytd.length > 1) {
        const sum = (k: keyof typeof x) => ytd.reduce((a, m) => a + Number(m.data[k] ?? 0), 0);
        lines.push(`Year to date (${ytd.length} months): revenue ${fmtEur(sum('revenueCents'))}, operating profit ${fmtEur(sum('ebitCents'))}, net income ${fmtEur(sum('netIncomeCents'))}, operating cash flow ${fmtEur(sum('operatingCfCents'))}.`);
      }
      return { title: `Financial results (${last.period})`, body: lines.join('\n') };
    }
    case 'liquidity': {
      const r = rcf(w);
      lines.push(`As of ${fmtDate(d)}: cash ${fmtEur(cash(w))}; credit line drawn ${fmtEur(r?.principalCents ?? 0)} of ${fmtEur(r?.limitCents ?? 0)}; liquidity ${fmtEur(liquidity(w))}; net leverage ${netLeverage(w).toFixed(2)}x; rating ${w.meta.creditRating} (${w.meta.ratingOutlook}).`);
      for (const debt of w.debts.filter((x) => x.status === 'active')) lines.push(`Debt: ${debt.name} — ${fmtEur(debt.principalCents)} at ${(debt.rateBps / 100).toFixed(2)}%, matures ${debt.maturityDate}.`);
      for (const c of w.covenants) lines.push(`Covenant: ${c.name} — ${c.status}${c.lastValue !== null ? ` (last test ${c.metric === 'min_liquidity' ? fmtEur(c.lastValue) : `${c.lastValue.toFixed(2)}x`})` : ''}.`);
      for (const f of w.financing.filter((x) => !['executed', 'withdrawn', 'expired', 'rejected'].includes(x.status))) lines.push(`Financing in progress: ${f.kind.replace(/_/g, ' ')} ${fmtEur(f.requestedCents)} with ${f.counterparty} — ${f.status.replace(/_/g, ' ')}.`);
      return { title: `Liquidity & debt (${fmtDate(d)})`, body: lines.join('\n') };
    }
    case 'project_status': {
      const p = byId(w.projects, param ?? '');
      if (!p) throw new GameError('Choose which project the report is about.');
      lines.push(`${p.name} (${p.id}) — ${p.status}, priority ${p.priority}. Target ${p.targetDate} (original ${p.originalTargetDate}); forecast ${p.forecastDate ?? 'cannot be forecast (blocked)'}${p.forecastP80Date ? `, P80 ${p.forecastP80Date}` : ''}.`);
      lines.push(`Budget ${fmtEur(p.budgetCents)}, spent ${fmtEur(p.spentCents)}; staffing ${Math.round(p.staffingFte)} engineers.`);
      for (const m of milestonesOf(w, p.id)) lines.push(`Milestone ${m.name}: ${m.status}${m.completedDate ? ` (${m.completedDate})` : ''}, ${Math.round((m.workDone / Math.max(1, m.workTotal)) * 100)}% done, planned ${m.plannedDate}.`);
      for (const i of w.issues.filter((x) => (x.projectId === p.id || x.linked.some((l) => l.id === p.id)) && !['resolved', 'closed'].includes(x.status))) lines.push(`Open issue: ${i.title} (${i.severity}).`);
      return { title: `Project status: ${p.name} (${fmtDate(d)})`, body: lines.join('\n') };
    }
    case 'production': {
      for (const m of w.models.filter((x) => x.status !== 'discontinued')) lines.push(`${m.name}: built ${m.productionLastMonth.toLocaleString('en-GB')} and sold ${m.retailLastMonth.toLocaleString('en-GB')} last month; company stock ${m.fgUnits.toLocaleString('en-GB')}, dealer stock ${m.dealerStock.toLocaleString('en-GB')}; estimated demand ≈${Math.round(modelMonthlyDemand(w, m, d)).toLocaleString('en-GB')}/month; net price ${fmtEur(m.netPriceCents)}.`);
      for (const l of w.lines) lines.push(`Line ${l.name}: ${l.status.replace('_', ' ')}, planned ${l.plannedDailyRate}/day (max ${l.maxDailyRate}).`);
      return { title: `Production & sales (${fmtDate(d)})`, body: lines.join('\n') };
    }
    case 'workforce': {
      for (const dep of w.departments) {
        const hiring = dep.hiring.map((h) => `${h.count} arriving ${h.arrivalDate}`).join(', ');
        const leaving = dep.leaving.map((l) => `${l.count} leaving ${l.date}`).join(', ');
        lines.push(`${dep.name}: ${dep.headcount.toLocaleString('en-GB')} people, morale ${Math.round(dep.morale)}${hiring ? `; hiring: ${hiring}` : ''}${leaving ? `; departures: ${leaving}` : ''}.`);
      }
      lines.push(`Engineers not assigned to projects: ${Math.max(0, Math.floor(engineeringFreeFte(w)))}.`);
      return { title: `Workforce report (${fmtDate(d)})`, body: lines.join('\n') };
    }
    case 'board_plan': {
      const p = byId(w.boardProposals, param ?? '');
      if (!p) throw new GameError('Choose which board proposal to share.');
      lines.push(`${p.title} (${p.id}) — ${p.status}, meeting ${p.meetingDate}.`);
      if (p.rationale) lines.push(`Case: ${p.rationale}`);
      const ids = proposalActionIds(p);
      if (ids.length) {
        const rows = db.prepare(`SELECT id, summary FROM actions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; summary: string }[];
        lines.push(`Decisions it contains: ${rows.map((r) => r.summary).join('; ')}.`);
      } else lines.push('Endorsement only — contains no decisions.');
      return { title: `Board proposal: ${p.title}`, body: lines.join('\n') };
    }
    case 'negotiation': {
      const n = byId(w.negotiations, param ?? '');
      if (!n) throw new GameError('Choose which negotiation to share.');
      const t = NEGOTIATION_TEMPLATES[n.templateKey];
      lines.push(`${n.title} with ${byId(w.characters, n.counterpartyId)?.name ?? n.counterpartyId} — ${n.status}${n.deadline ? `, deadline ${n.deadline}` : ''}.`);
      const lc = lastCounter(n);
      if (lc) lines.push(`Their latest position: ${t.describe(lc)}`);
      const lastCeo = [...n.rounds].reverse().find((r) => r.by === 'ceo');
      if (lastCeo) lines.push(`Our latest offer (${lastCeo.date}): ${t.describe(lastCeo.terms)}`);
      return { title: `Negotiation: ${n.title} (${fmtDate(d)})`, body: lines.join('\n') };
    }
    case 'decisions': {
      const rows = db.prepare("SELECT sim_date, summary, status FROM actions WHERE status IN ('committed','pending_approval','approved') AND type NOT IN ('advance_time','approve_budget') AND sim_date >= ? ORDER BY created_at").all(addDays(d, -90)) as { sim_date: string; summary: string; status: string }[];
      for (const r of rows) lines.push(`${r.sim_date}: ${r.summary}${r.status !== 'committed' ? ` (${r.status === 'approved' ? 'approved by the board, waiting' : 'awaiting the board'})` : ''}.`);
      if (!rows.length) lines.push('No decisions in the last 90 days.');
      return { title: `Decision log (to ${fmtDate(d)})`, body: lines.join('\n') };
    }
    case 'memo': {
      if (note.trim().length < 5) throw new GameError('Write the memo first.');
      return { title: `Memo from the CEO (${fmtDate(d)})`, body: note.trim() };
    }
  }
  throw new GameError(`Unknown document type "${key}".`);
}

export function rowToSharedDocument(r: Record<string, unknown>): SharedDocument {
  return { id: String(r.id), date: String(r.date), docKey: String(r.doc_key), param: (r.param as string | null) ?? null, title: String(r.title), body: String(r.body), recipients: JSON.parse(String(r.recipients)), note: String(r.note ?? ''), conversationId: (r.conversation_id as string | null) ?? null, createdAt: String(r.created_at) };
}

/** Documents shared with a character (most recent first). */
export function documentsFor(db: DB, characterId: string, sinceDate: string, limit = 5): SharedDocument[] {
  return (db.prepare("SELECT d.* FROM shared_documents d WHERE d.date >= ? AND EXISTS (SELECT 1 FROM json_each(d.recipients) j WHERE j.value = ?) ORDER BY d.rowid DESC LIMIT ?").all(sinceDate, characterId, limit) as Record<string, unknown>[]).map(rowToSharedDocument);
}

export function recentDocuments(db: DB, sinceDate: string, limit = 30): SharedDocument[] {
  return (db.prepare('SELECT * FROM shared_documents WHERE date >= ? ORDER BY rowid DESC LIMIT ?').all(sinceDate, limit) as Record<string, unknown>[]).map(rowToSharedDocument);
}

export interface ShareInput {
  docKey: string;
  param?: string | null;
  recipientIds: string[];
  note?: string;
  conversationId?: string | null;
}

/** Share a document (or send a memo) to one or more people. Changes what they know, nothing else. */
export function shareDocument(db: DB, input: ShareInput): SharedDocument {
  const w = loadWorld(db);
  if (w.meta.status !== 'active') throw new GameError(`The game is over: ${w.meta.terminalReason}`);
  const type = DOCUMENT_TYPES.find((t) => t.key === input.docKey);
  if (!type) throw new GameError(`Unknown document type "${input.docKey}".`);
  const recipients = [...new Set(input.recipientIds)];
  if (!recipients.length) throw new GameError('Choose at least one recipient.');
  if (recipients.length > 20) throw new GameError('At most 20 recipients at once.');
  for (const id of recipients) {
    const c = byId(w.characters, id);
    if (!c || !c.active) throw new GameError(`Unknown or departed recipient ${id}.`);
  }
  const note = (input.note ?? '').slice(0, 2000);
  const built = buildBody(db, w, type.key, input.param ?? null, note);
  const doc: SharedDocument = {
    id: `DOC-${randomUUID().slice(0, 8)}`,
    date: w.meta.currentDate,
    docKey: type.key,
    param: input.param ?? null,
    title: built.title,
    body: type.key === 'memo' ? built.body : `${built.body}${note.trim() ? `\nCEO's note: ${note.trim()}` : ''}`,
    recipients,
    note,
    conversationId: input.conversationId ?? null,
    createdAt: new Date().toISOString(),
  };
  const names = recipients.map((id) => byId(w.characters, id)!.name);
  db.transaction(() => {
    db.prepare('INSERT INTO shared_documents (id, date, doc_key, param, title, body, recipients, note, conversation_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(doc.id, doc.date, doc.docKey, doc.param, doc.title, doc.body, JSON.stringify(doc.recipients), doc.note, doc.conversationId, doc.createdAt);
    for (const id of recipients) remember(w, { characterId: id, kind: 'observation', summary: `The CEO sent me "${doc.title}"${recipients.length > 1 ? ` (also to ${names.filter((n) => n !== byId(w.characters, id)!.name).join(', ')})` : ''}.${note.trim() && type.key !== 'memo' ? ` Note: ${note.trim().slice(0, 200)}` : ''}${type.key === 'memo' ? ` It said: ${note.trim().slice(0, 300)}` : ''}`, importance: 3, sentiment: 0, sourceType: 'document', sourceId: doc.id, entityRefs: [] });
    emit(w, { type: 'document_shared', category: 'people', severity: 'info', title: `${type.key === 'memo' ? 'Memo' : `“${doc.title}”`} sent to ${names.join(', ')}`, description: type.key === 'memo' ? note.trim().slice(0, 220) : `${type.title} shared by the CEO.`, causeKind: 'player_action', source: 'action', entities: recipients.map((id) => ({ type: 'character' as const, id })) });
    writeWorld(db, w);
    if (doc.conversationId) {
      db.prepare('INSERT INTO messages (id, conversation_id, role, content, sim_date, created_at, structured) VALUES (?,?,?,?,?,?,?)').run(`MSGC-${randomUUID().slice(0, 8)}`, doc.conversationId, 'system', `You shared “${doc.title}”${recipients.length > 1 ? ` with ${names.join(', ')}` : ''}.`, doc.date, doc.createdAt, JSON.stringify({ documentId: doc.id, body: doc.body }));
    }
  })();
  return doc;
}

/** Context lines: documents this character received, plus (for colleagues) what was circulated internally. */
export function documentContext(db: DB, w: World, characterId: string): { mine: string[]; circulated: string[] } {
  const since = addDays(w.meta.currentDate, -150);
  const mine = documentsFor(db, characterId, since, 4).map((doc) => {
    const age = diffDays(w.meta.currentDate, doc.date);
    const others = doc.recipients.filter((r) => r !== characterId).map((r) => byId(w.characters, r)?.name ?? r);
    return `[FACT] ${doc.date}${age > 0 ? ` (${age} days ago)` : ''}: the CEO sent you "${doc.title}"${others.length ? ` (also sent to ${others.join(', ')})` : ''}. Contents as of that date:\n${doc.body.slice(0, 1400)}`;
  });
  const c = byId(w.characters, characterId);
  const circulated: string[] = [];
  if (c && (c.org === 'asterion' || c.org === 'board')) {
    for (const doc of recentDocuments(db, addDays(w.meta.currentDate, -60), 12)) {
      if (doc.recipients.includes(characterId)) continue;
      const internal = doc.recipients.filter((r) => {
        const x = byId(w.characters, r);
        return x && (c.org === 'board' ? x.org === 'board' : x.org === 'asterion' || x.org === 'board');
      });
      if (!internal.length) continue;
      circulated.push(`[FACT] ${doc.date}: the CEO sent "${doc.title}" to ${internal.map((r) => byId(w.characters, r)?.name ?? r).join(', ')} (you did not receive it; you may ask the CEO for it).`);
    }
  }
  return { mine, circulated };
}

export { upcomingMeeting };
