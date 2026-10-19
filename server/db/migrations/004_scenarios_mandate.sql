-- 004_scenarios_mandate.sql — starting scenario, difficulty and the CEO's three-year mandate.
ALTER TABLE game_meta ADD COLUMN scenario_key TEXT NOT NULL DEFAULT 'turnaround';
ALTER TABLE game_meta ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE game_meta ADD COLUMN term_end_date TEXT NOT NULL DEFAULT '2029-12-31';
ALTER TABLE game_meta ADD COLUMN mandate TEXT;
