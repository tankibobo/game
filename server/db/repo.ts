/**
 * Mapping between the in-memory World and SQLite. `persistWorld` writes the
 * full mutable state plus all append-only outputs (journal, events, memories,
 * history, inbox, snapshots, forecasts) in ONE transaction, so a failure at
 * any point leaves the database exactly as it was.
 */
import type {
  ActionRecord,
  CharacterMemory,
  Conversation,
  ConversationMessage,
  FinancialSnapshot,
  Forecast,
  GameEvent,
  InboxItem,
  JournalEntry,
  ProjectHistory,
} from '../../shared/domain';
import { ACCOUNTS } from '../engine/accounts';
import { emptyOutput, type World } from '../engine/world';
import type { DB } from './connection';
import type { Statement } from 'better-sqlite3';

type Stmt = Statement<unknown[], unknown>;
import { WORLD_TABLES, snake, type TableSpec } from './tables';

type Row = Record<string, unknown>;

function toRow(spec: TableSpec, obj: Row): unknown[] {
  return spec.columns.map(([f, t]) => {
    const v = obj[f];
    if (v === undefined) throw new Error(`${spec.table}.${f} is undefined on ${JSON.stringify(obj).slice(0, 120)}`);
    if (t === 'JSON') return v === null ? null : JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

function fromRow(spec: TableSpec, row: Row): Row {
  const o: Row = {};
  for (const [f, t] of spec.columns) {
    const v = row[snake(f)];
    o[f] = t === 'JSON' ? (v === null || v === undefined ? null : JSON.parse(String(v))) : v;
  }
  return o;
}

const stmtCache = new WeakMap<DB, Map<string, Stmt>>();
function stmt(db: DB, sql: string): Stmt {
  let m = stmtCache.get(db);
  if (!m) {
    m = new Map();
    stmtCache.set(db, m);
  }
  let s = m.get(sql);
  if (!s) {
    s = db.prepare(sql) as Stmt;
    m.set(sql, s);
  }
  return s;
}

function upsertSql(spec: TableSpec): string {
  const cols = spec.columns.map(([f]) => `"${snake(f)}"`);
  const pk = cols[0];
  const updates = cols.slice(1).map((c) => `${c}=excluded.${c}`);
  return `INSERT INTO "${spec.table}" (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(${pk}) DO UPDATE SET ${updates.join(',')}`;
}

export function loadWorld(db: DB): World {
  const w: Row = {};
  for (const spec of WORLD_TABLES) {
    const rows = stmt(db, `SELECT * FROM "${spec.table}"${spec.loadWhere ? ` WHERE ${spec.loadWhere}` : ''} ORDER BY rowid`).all() as Row[];
    const objs = rows.map((r) => fromRow(spec, r));
    w[spec.worldKey] = spec.single ? objs[0] : objs;
  }
  if (!w.meta) throw new Error('No game in this save file');
  const balances: Record<string, number> = {};
  for (const r of stmt(db, 'SELECT account, SUM(amount_cents) AS s FROM journal_lines GROUP BY account').all() as { account: string; s: number }[]) balances[r.account] = r.s;
  const snaps = (stmt(db, "SELECT * FROM financial_snapshots WHERE kind = 'month' ORDER BY period DESC LIMIT 30").all() as Row[]).map((r) => ({ ...r, data: JSON.parse(String(r.data)) }) as unknown as FinancialSnapshot).reverse();
  return { ...(w as unknown as World), balances, snapshots: snaps, out: emptyOutput(), mode: 'live', scenarioDemandFactor: 1 };
}

/** Write the complete world state and drain its pending outputs. Call inside a transaction. */
export function writeWorld(db: DB, w: World): void {
  for (const spec of WORLD_TABLES) {
    const s = stmt(db, upsertSql(spec));
    const val = (w as unknown as Row)[spec.worldKey];
    const arr = spec.single ? [val] : (val as Row[]);
    for (const obj of arr) s.run(...toRow(spec, obj as Row));
  }
  appendOutputs(db, w);
}

export function persistWorld(db: DB, w: World): void {
  db.transaction(() => writeWorld(db, w))();
}

function appendOutputs(db: DB, w: World): void {
  const o = w.out;
  const je = stmt(db, 'INSERT INTO journal_entries (id, date, description, source_type, source_id, cf_category, cf_line) VALUES (?,?,?,?,?,?,?)');
  const jl = stmt(db, 'INSERT INTO journal_lines (entry_id, line_no, account, amount_cents, memo) VALUES (?,?,?,?,?)');
  for (const e of o.journal) insertJournal(je, jl, e);
  const ev = stmt(db, 'INSERT INTO events (id, date, type, category, severity, title, description, cause_kind, cause, entities, consequences, follow_ups, source, action_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const ee = stmt(db, 'INSERT INTO event_entities (event_id, entity_type, entity_id) VALUES (?,?,?)');
  for (const e of o.events) insertEvent(ev, ee, e);
  const mem = stmt(db, 'INSERT INTO character_memories (id, character_id, date, kind, summary, importance, sentiment, source_type, source_id, entity_refs) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const m of o.memories) insertMemory(mem, m);
  const ph = stmt(db, 'INSERT INTO project_history (id, project_id, date, field, old_value, new_value, reason, action_id) VALUES (?,?,?,?,?,?,?,?)');
  for (const h of o.history) ph.run(h.id, h.projectId, h.date, h.field, h.oldValue, h.newValue, h.reason, h.actionId);
  const ib = stmt(db, 'INSERT INTO inbox (id, date, kind, from_id, subject, body, priority, read, linked) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const i of o.inbox) insertInbox(ib, i);
  const sn = stmt(db, 'INSERT INTO financial_snapshots (id, kind, period, date, data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, date=excluded.date');
  for (const s of o.snapshots) sn.run(s.id, s.kind, s.period, s.date, JSON.stringify(s.data));
  const fc = stmt(db, 'INSERT INTO forecasts (id, created_date, trigger, data) VALUES (?,?,?,?)');
  for (const f of o.forecasts) fc.run(f.id, f.createdDate, f.trigger, JSON.stringify(f.data));
  const au = stmt(db, 'UPDATE actions SET status = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?');
  for (const a of o.actionUpdates) au.run(a.status, a.result || a.note ? JSON.stringify({ ...(a.result ?? {}), note: a.note ?? null }) : null, new Date().toISOString(), a.actionId);
  w.out = emptyOutput();
}

function insertJournal(je: Stmt, jl: Stmt, e: JournalEntry) {
  je.run(e.id, e.date, e.description, e.sourceType, e.sourceId, e.cfCategory, e.cfLine);
  e.lines.forEach((l, i) => jl.run(e.id, i + 1, l.account, l.amountCents, l.memo ?? null));
}

function insertEvent(ev: Stmt, ee: Stmt, e: GameEvent) {
  ev.run(e.id, e.date, e.type, e.category, e.severity, e.title, e.description, e.causeKind, JSON.stringify(e.cause), JSON.stringify(e.entities), JSON.stringify(e.consequences), JSON.stringify(e.followUps), e.source, e.actionId);
  const seen = new Set<string>();
  for (const r of [...e.entities, ...e.cause.refs]) {
    const k = `${r.type}:${r.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ee.run(e.id, r.type, r.id);
  }
}

function insertMemory(s: Stmt, m: CharacterMemory) {
  s.run(m.id, m.characterId, m.date, m.kind, m.summary, Math.round(m.importance), Math.round(m.sentiment), m.sourceType, m.sourceId, JSON.stringify(m.entityRefs));
}

function insertInbox(s: Stmt, i: InboxItem) {
  s.run(i.id, i.date, i.kind, i.fromId, i.subject, i.body, i.priority, i.read, JSON.stringify(i.linked));
}

/** Create a brand-new game in an empty (migrated) database. */
export function initGame(db: DB, w: World): void {
  db.transaction(() => {
    const acc = stmt(db, 'INSERT INTO accounts (code, name, type, statement_line) VALUES (?,?,?,?)');
    for (const a of ACCOUNTS) acc.run(a.code, a.name, a.type, a.statementLine);
    const sn = stmt(db, 'INSERT INTO financial_snapshots (id, kind, period, date, data) VALUES (?,?,?,?,?)');
    for (const s of w.snapshots) sn.run(s.id, s.kind, s.period, s.date, JSON.stringify(s.data));
    writeWorld(db, w);
  })();
}

// ---------------------------------------------------------------- read models

const parseJsonCols = <T>(row: Row, cols: string[]): T => {
  const o: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    o[ck] = cols.includes(k) && typeof v === 'string' ? JSON.parse(v) : v;
  }
  return o as T;
};

export function rowToEvent(r: Row): GameEvent {
  return parseJsonCols<GameEvent>(r, ['cause', 'entities', 'consequences', 'follow_ups']);
}
export function rowToInbox(r: Row): InboxItem {
  return parseJsonCols<InboxItem>(r, ['linked']);
}
export function rowToMemory(r: Row): CharacterMemory {
  return parseJsonCols<CharacterMemory>(r, ['entity_refs']);
}
export function rowToHistory(r: Row): ProjectHistory {
  return parseJsonCols<ProjectHistory>(r, []);
}
export function rowToAction(r: Row): ActionRecord {
  return parseJsonCols<ActionRecord>(r, ['payload', 'errors', 'warnings', 'consequences', 'approvals', 'result']);
}
export function rowToConversation(r: Row): Conversation {
  return parseJsonCols<Conversation>(r, []);
}
export function rowToMessage(r: Row): ConversationMessage {
  return parseJsonCols<ConversationMessage>(r, ['structured']);
}
export function rowToForecast(r: Row): Forecast {
  return parseJsonCols<Forecast>(r, ['data']);
}

export function loadJournal(db: DB, from?: string, to?: string): JournalEntry[] {
  const entries = stmt(db, `SELECT * FROM journal_entries WHERE date >= ? AND date <= ? ORDER BY seq`).all(from ?? '0000-00-00', to ?? '9999-12-31') as Row[];
  const lines = stmt(db, `SELECT l.* FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.date >= ? AND e.date <= ? ORDER BY e.seq, l.line_no`).all(from ?? '0000-00-00', to ?? '9999-12-31') as Row[];
  const byEntry = new Map<string, JournalEntry>();
  const out: JournalEntry[] = [];
  for (const e of entries) {
    const je: JournalEntry = { id: String(e.id), date: String(e.date), description: String(e.description), sourceType: String(e.source_type), sourceId: (e.source_id as string) ?? null, cfCategory: (e.cf_category as JournalEntry['cfCategory']) ?? null, cfLine: (e.cf_line as string) ?? null, lines: [] };
    byEntry.set(je.id, je);
    out.push(je);
  }
  for (const l of lines) byEntry.get(String(l.entry_id))?.lines.push({ account: String(l.account), amountCents: Number(l.amount_cents), memo: (l.memo as string) ?? undefined });
  return out;
}
