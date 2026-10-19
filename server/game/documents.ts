/**
 * Documents: reports (from the report catalogue) and memos circulated between
 * people — the CEO and the characters.
 *
 * A document is a dated snapshot built from authoritative state at the moment
 * it is sent; it can bundle several reports and a written memo. It is recorded
 * once (append-only), becomes part of each recipient's context and memory, and
 * colleagues learn that it was circulated. Sending information never changes
 * the company itself.
 */
import { randomUUID } from 'node:crypto';
import type { Report, ReportInfo } from '../../shared/report';
import { addDays, diffDays } from '../../shared/dates';
import type { DB } from '../db/connection';
import { loadWorld, writeWorld } from '../db/repo';
import { byId, emit, remember, type World } from '../engine/world';
import { REPORT_BY_KEY, ReportError, buildReport, reportInfo, reportToText } from '../reports/catalog';
import { GameError } from './game';

export interface DocumentType extends ReportInfo {}

/** Everything that can be sent: the report catalogue plus a free memo. */
export const DOCUMENT_TYPES: (ReportInfo | { key: 'memo'; title: string; description: string; area: 'board'; ownerIds: string[] })[] = [...reportInfo(), { key: 'memo', title: 'Memo', description: 'A written message in your own words.', area: 'board', ownerIds: [] }];

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
  senderId: string;
  reports: Report[];
}

export function rowToSharedDocument(r: Record<string, unknown>): SharedDocument {
  let reports: Report[] = [];
  try {
    reports = r.data ? (JSON.parse(String(r.data)) as Report[]) : [];
  } catch {
    reports = [];
  }
  return { id: String(r.id), date: String(r.date), docKey: String(r.doc_key), param: (r.param as string | null) ?? null, title: String(r.title), body: String(r.body), recipients: JSON.parse(String(r.recipients)), note: String(r.note ?? ''), conversationId: (r.conversation_id as string | null) ?? null, createdAt: String(r.created_at), senderId: String(r.sender_id ?? 'ceo'), reports };
}

/** Documents a person received (most recent first). */
export function documentsFor(db: DB, characterId: string, sinceDate: string, limit = 5): SharedDocument[] {
  return (db.prepare("SELECT d.* FROM shared_documents d WHERE d.date >= ? AND EXISTS (SELECT 1 FROM json_each(d.recipients) j WHERE j.value = ?) ORDER BY d.rowid DESC LIMIT ?").all(sinceDate, characterId, limit) as Record<string, unknown>[]).map(rowToSharedDocument);
}

export function recentDocuments(db: DB, sinceDate: string, limit = 30): SharedDocument[] {
  return (db.prepare('SELECT * FROM shared_documents WHERE date >= ? ORDER BY rowid DESC LIMIT ?').all(sinceDate, limit) as Record<string, unknown>[]).map(rowToSharedDocument);
}

export function getDocument(db: DB, id: string): SharedDocument {
  const r = db.prepare('SELECT * FROM shared_documents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) throw new GameError('Document not found.', 404);
  return rowToSharedDocument(r);
}

export interface ReportRef {
  key: string;
  param?: string | null;
}

export interface ShareInput {
  reports: ReportRef[];
  memo?: string;
  recipientIds: string[];
  /** 'ceo' or a character id. */
  senderId?: string;
  conversationId?: string | null;
  /** Do not log an event (e.g. a report attached to a reply in a meeting). */
  quiet?: boolean;
}

const nameOf = (w: World, id: string) => (id === 'ceo' ? 'the CEO' : byId(w.characters, id)?.name ?? id);

/**
 * Build and record a document on a loaded world (no transaction of its own):
 * used by the CEO's sharing, by characters circulating reports in meetings and
 * by the characters' own monthly reporting. Returns the stored document.
 */
export function recordDocument(db: DB, w: World, input: ShareInput): SharedDocument {
  const sender = input.senderId ?? 'ceo';
  if (sender !== 'ceo' && !byId(w.characters, sender)) throw new GameError(`Unknown sender ${sender}.`);
  const recipients = [...new Set(input.recipientIds)].filter((id) => id !== sender);
  if (!recipients.length) throw new GameError('Choose at least one recipient.');
  if (recipients.length > 20) throw new GameError('At most 20 recipients at once.');
  for (const id of recipients) {
    if (id === 'ceo') continue;
    const c = byId(w.characters, id);
    if (!c || !c.active) throw new GameError(`Unknown or departed recipient ${id}.`);
  }
  const memo = (input.memo ?? '').trim().slice(0, 3000);
  const refs = input.reports.slice(0, 6);
  if (!refs.length && memo.length < 5) throw new GameError('Choose at least one report, or write a memo.');
  const reports: Report[] = [];
  for (const ref of refs) {
    if (!REPORT_BY_KEY.has(ref.key)) throw new GameError(`Unknown report "${ref.key}".`);
    try {
      reports.push(buildReport(db, w, ref.key, ref.param ?? null, sender));
    } catch (e) {
      throw new GameError(e instanceof ReportError ? e.message : String(e));
    }
  }
  const title = reports.length === 0 ? `Memo from ${nameOf(w, sender)}` : reports.length === 1 ? reports[0].title : `Dossier: ${reports.map((r) => r.title).join(' · ')}`;
  const body = [memo ? `${sender === 'ceo' ? 'CEO' : nameOf(w, sender)}'s memo: ${memo}` : '', ...reports.map((r) => reportToText(r, 2200))].filter(Boolean).join('\n\n');
  const doc: SharedDocument = {
    id: `DOC-${randomUUID().slice(0, 8)}`,
    date: w.meta.currentDate,
    docKey: reports.length === 0 ? 'memo' : reports.length === 1 ? reports[0].key : 'dossier',
    param: reports.length === 1 ? refs[0].param ?? null : null,
    title,
    body,
    recipients,
    note: memo,
    conversationId: input.conversationId ?? null,
    createdAt: new Date().toISOString(),
    senderId: sender,
    reports,
  };
  db.prepare('INSERT INTO shared_documents (id, date, doc_key, param, title, body, recipients, note, conversation_id, created_at, sender_id, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(doc.id, doc.date, doc.docKey, doc.param, doc.title, doc.body, JSON.stringify(doc.recipients), doc.note, doc.conversationId, doc.createdAt, doc.senderId, JSON.stringify(doc.reports));
  const names = recipients.map((id) => nameOf(w, id));
  for (const id of recipients) {
    if (id === 'ceo') continue;
    const others = names.filter((n) => n !== nameOf(w, id));
    remember(w, { characterId: id, kind: 'observation', summary: `${sender === 'ceo' ? 'The CEO' : nameOf(w, sender)} sent me "${title}"${others.length ? ` (also to ${others.join(', ')})` : ''}.${memo ? ` Memo: ${memo.slice(0, 220)}` : ''}`, importance: 3, sentiment: 0, sourceType: 'document', sourceId: doc.id, entityRefs: [] });
  }
  if (sender !== 'ceo') remember(w, { characterId: sender, kind: 'observation', summary: `I sent "${title}" to ${names.join(', ')}.`, importance: 2, sentiment: 0, sourceType: 'document', sourceId: doc.id, entityRefs: [] });
  if (!input.quiet) emit(w, { type: 'document_shared', category: 'people', severity: 'info', title: `${reports.length ? `“${title}”` : 'Memo'} sent by ${sender === 'ceo' ? 'the CEO' : nameOf(w, sender)} to ${names.join(', ')}`, description: memo ? memo.slice(0, 220) : reports.map((r) => r.summary).join(' ').slice(0, 300), causeKind: sender === 'ceo' ? 'player_action' : 'causal', source: sender === 'ceo' ? 'action' : 'engine', entities: recipients.filter((id) => id !== 'ceo').map((id) => ({ type: 'character' as const, id })) });
  return doc;
}

/** The CEO shares reports and/or a memo with people. Changes what they know, nothing else. */
export function shareDocument(db: DB, input: ShareInput): SharedDocument {
  const w = loadWorld(db);
  if (w.meta.status !== 'active') throw new GameError(`The game is over: ${w.meta.terminalReason}`);
  let doc!: SharedDocument;
  db.transaction(() => {
    doc = recordDocument(db, w, { ...input, senderId: 'ceo' });
    writeWorld(db, w);
    if (doc.conversationId) {
      const names = doc.recipients.map((id) => nameOf(w, id));
      db.prepare('INSERT INTO messages (id, conversation_id, role, content, sim_date, created_at, structured) VALUES (?,?,?,?,?,?,?)').run(`MSGC-${randomUUID().slice(0, 8)}`, doc.conversationId, 'system', `You shared “${doc.title}”${doc.recipients.length > 1 ? ` with ${names.join(', ')}` : ''}.`, doc.date, doc.createdAt, JSON.stringify({ documentId: doc.id, attachments: [doc.id] }));
    }
  })();
  return doc;
}

/** Context lines: documents this character received or sent, plus (for colleagues) what was circulated internally. */
export function documentContext(db: DB, w: World, characterId: string): { mine: string[]; circulated: string[] } {
  const since = addDays(w.meta.currentDate, -150);
  const mine = documentsFor(db, characterId, since, 4).map((doc) => {
    const age = diffDays(w.meta.currentDate, doc.date);
    const others = doc.recipients.filter((r) => r !== characterId).map((r) => nameOf(w, r));
    return `[FACT] ${doc.date}${age > 0 ? ` (${age} days ago)` : ''}: ${doc.senderId === 'ceo' ? 'the CEO' : nameOf(w, doc.senderId)} sent you "${doc.title}"${others.length ? ` (also sent to ${others.join(', ')})` : ''}. Contents as of that date:\n${doc.body.slice(0, 2400)}`;
  });
  const c = byId(w.characters, characterId);
  const circulated: string[] = [];
  if (c && (c.org === 'asterion' || c.org === 'board')) {
    for (const doc of recentDocuments(db, addDays(w.meta.currentDate, -60), 14)) {
      if (doc.recipients.includes(characterId) || doc.senderId === characterId) continue;
      const internal = doc.recipients.filter((r) => {
        const x = byId(w.characters, r);
        return x && (c.org === 'board' ? x.org === 'board' : x.org === 'asterion' || x.org === 'board');
      });
      if (!internal.length) continue;
      circulated.push(`[FACT] ${doc.date}: ${doc.senderId === 'ceo' ? 'the CEO' : nameOf(w, doc.senderId)} sent "${doc.title}" to ${internal.map((r) => nameOf(w, r)).join(', ')} (you did not receive it; ask for it if you need it).`);
    }
  }
  return { mine, circulated };
}
