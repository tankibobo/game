/**
 * Generates server/db/migrations/001_init.sql from the table specs.
 * Run once when creating the initial migration; later schema changes must be
 * added as new numbered migration files (never edit an applied migration).
 */
import { writeFileSync } from 'node:fs';
import { WORLD_TABLES, createTableSql } from '../server/db/tables';

const parts: string[] = [
  '-- 001_init.sql — initial schema for Automanager (generated from server/db/tables.ts)',
  '',
  '-- ===================== authoritative world state =====================',
];
for (const spec of WORLD_TABLES) parts.push(createTableSql(spec), '');
parts.push(`CREATE INDEX idx_payables_status ON payables(status, due_date);
CREATE INDEX idx_receivables_status ON receivables(status, due_date);
CREATE INDEX idx_milestones_project ON milestones(project_id, seq);

-- ===================== accounting ledger =====================
CREATE TABLE accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  statement_line TEXT NOT NULL
);

CREATE TABLE journal_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  cf_category TEXT,
  cf_line TEXT
);
CREATE INDEX idx_je_date ON journal_entries(date);

CREATE TABLE journal_lines (
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  line_no INTEGER NOT NULL,
  account TEXT NOT NULL REFERENCES accounts(code),
  amount_cents INTEGER NOT NULL,
  memo TEXT,
  PRIMARY KEY (entry_id, line_no)
);
CREATE INDEX idx_jl_account ON journal_lines(account);

CREATE TRIGGER journal_entries_no_update BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_entries_no_delete BEFORE DELETE ON journal_entries BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;

CREATE TABLE financial_snapshots (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  date TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE forecasts (
  id TEXT PRIMARY KEY,
  created_date TEXT NOT NULL,
  trigger TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===================== event ledger & memory =====================
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  cause_kind TEXT NOT NULL,
  cause TEXT NOT NULL,
  entities TEXT NOT NULL,
  consequences TEXT NOT NULL,
  follow_ups TEXT NOT NULL,
  source TEXT NOT NULL,
  action_id TEXT
);
CREATE INDEX idx_events_date ON events(date);
CREATE INDEX idx_events_type ON events(type);

CREATE TABLE event_entities (
  event_id TEXT NOT NULL REFERENCES events(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL
);
CREATE INDEX idx_event_entities ON event_entities(entity_type, entity_id);

CREATE VIRTUAL TABLE events_fts USING fts5(title, description, content='events', content_rowid='seq');
CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, title, description) VALUES (new.seq, new.title, new.description);
END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'event ledger is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'event ledger is append-only'); END;

CREATE TABLE project_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  date TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  action_id TEXT
);
CREATE INDEX idx_project_history ON project_history(project_id, date);
CREATE TRIGGER project_history_no_update BEFORE UPDATE ON project_history BEGIN SELECT RAISE(ABORT, 'project history is append-only'); END;
CREATE TRIGGER project_history_no_delete BEFORE DELETE ON project_history BEGIN SELECT RAISE(ABORT, 'project history is append-only'); END;

CREATE TABLE character_memories (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  character_id TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance INTEGER NOT NULL,
  sentiment INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  entity_refs TEXT NOT NULL
);
CREATE INDEX idx_memories_character ON character_memories(character_id, date);
CREATE VIRTUAL TABLE memories_fts USING fts5(summary, content='character_memories', content_rowid='seq');
CREATE TRIGGER memories_ai AFTER INSERT ON character_memories BEGIN
  INSERT INTO memories_fts(rowid, summary) VALUES (new.seq, new.summary);
END;
CREATE TRIGGER memories_no_update BEFORE UPDATE ON character_memories BEGIN SELECT RAISE(ABORT, 'memories are append-only'); END;
CREATE TRIGGER memories_no_delete BEFORE DELETE ON character_memories BEGIN SELECT RAISE(ABORT, 'memories are append-only'); END;

CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_id TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  linked TEXT NOT NULL
);
CREATE INDEX idx_inbox_date ON inbox(date);

-- ===================== actions, conversations, LLM audit =====================
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  sim_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  errors TEXT NOT NULL,
  warnings TEXT NOT NULL,
  consequences TEXT NOT NULL,
  approvals TEXT NOT NULL,
  result TEXT,
  conversation_id TEXT,
  rationale TEXT,
  superseded_by TEXT
);
CREATE INDEX idx_actions_status ON actions(status);
CREATE INDEX idx_actions_conversation ON actions(conversation_id);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  title TEXT NOT NULL,
  started_date TEXT NOT NULL,
  last_date TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  negotiation_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sim_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  structured TEXT
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, seq);

CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  conversation_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  error TEXT,
  context_tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER
);
`);
writeFileSync('server/db/migrations/001_init.sql', parts.join('\n'));
console.log('wrote server/db/migrations/001_init.sql');
