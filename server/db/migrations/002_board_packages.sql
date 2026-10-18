-- 002_board_packages.sql — a board proposal can carry several concrete decisions.
ALTER TABLE board_proposals ADD COLUMN action_ids TEXT NOT NULL DEFAULT '[]';
UPDATE board_proposals SET action_ids = CASE WHEN action_id IS NULL THEN '[]' ELSE json_array(action_id) END;
