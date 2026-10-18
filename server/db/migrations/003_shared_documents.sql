-- 003_shared_documents.sql — documents and memos the CEO shares with people (append-only).
CREATE TABLE shared_documents (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  param TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  recipients TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_shared_documents_date ON shared_documents(date);
CREATE TRIGGER shared_documents_no_update BEFORE UPDATE ON shared_documents BEGIN SELECT RAISE(ABORT, 'shared_documents is append-only'); END;
CREATE TRIGGER shared_documents_no_delete BEFORE DELETE ON shared_documents BEGIN SELECT RAISE(ABORT, 'shared_documents is append-only'); END;
