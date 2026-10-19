-- 005_living_company.sql — reports & attachments, measurable project impact, car features,
-- marketing campaigns, own projects and the date an agreement was reached.
ALTER TABLE contracts ADD COLUMN agreed_date TEXT;
ALTER TABLE projects ADD COLUMN impact TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN custom TEXT;
ALTER TABLE vehicle_models ADD COLUMN features TEXT NOT NULL DEFAULT '[]';
ALTER TABLE game_meta ADD COLUMN campaigns TEXT NOT NULL DEFAULT '[]';
ALTER TABLE game_meta ADD COLUMN marketing_efficiency REAL NOT NULL DEFAULT 1;
ALTER TABLE shared_documents ADD COLUMN sender_id TEXT NOT NULL DEFAULT 'ceo';
ALTER TABLE shared_documents ADD COLUMN data TEXT;
ALTER TABLE inbox ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE game_meta ADD COLUMN initiative_log TEXT NOT NULL DEFAULT '{}';
