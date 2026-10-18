-- 001_init.sql — initial schema for Automanager (generated from server/db/tables.ts)

-- ===================== authoritative world state =====================
CREATE TABLE "game_meta" (
  "id" TEXT PRIMARY KEY,
  "company_name" TEXT NOT NULL,
  "ceo_name" TEXT NOT NULL,
  "current_date" TEXT NOT NULL,
  "start_date" TEXT NOT NULL,
  "seed" INTEGER NOT NULL,
  "seq" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "terminal_reason" TEXT,
  "board_confidence" REAL NOT NULL,
  "low_confidence_meetings" INTEGER NOT NULL,
  "ceo_personal_liquid_cents" INTEGER NOT NULL,
  "ceo_personal_net_worth_cents" INTEGER NOT NULL,
  "shares_outstanding" INTEGER NOT NULL,
  "share_price_cents" INTEGER NOT NULL,
  "credit_rating" TEXT NOT NULL,
  "rating_outlook" TEXT NOT NULL,
  "marketing_monthly_cents" INTEGER NOT NULL,
  "ga_monthly_cents" INTEGER NOT NULL,
  "sustaining_capex_monthly_cents" INTEGER NOT NULL,
  "tax_loss_carryforward_cents" INTEGER NOT NULL,
  "tax_accrued_ytd_cents" INTEGER NOT NULL,
  "co2_provision_ytd_cents" INTEGER NOT NULL,
  "co2_units_ytd" INTEGER NOT NULL,
  "co2_grams_ytd" REAL NOT NULL,
  "aftersales_parc" INTEGER NOT NULL,
  "wage_index" REAL NOT NULL,
  "mtd_by_account" TEXT NOT NULL,
  "ytd_by_account" TEXT NOT NULL,
  "cf_mtd" TEXT NOT NULL,
  "board_plan" TEXT NOT NULL,
  "next_board_meeting" TEXT NOT NULL,
  "extraordinary_meeting" TEXT,
  "last_forecast_summary" TEXT,
  "liquidity_stress_days" INTEGER NOT NULL,
  "missed_payment_days" INTEGER NOT NULL,
  "legacy_dep_monthly_cents" INTEGER NOT NULL,
  "new_ppe_gross_cents" INTEGER NOT NULL,
  "amortizing_dev_cents" INTEGER NOT NULL,
  "forecast_stale" INTEGER NOT NULL,
  "distribution_utility" REAL NOT NULL,
  "lease_monthly_cents" INTEGER NOT NULL,
  "assets_sold" TEXT NOT NULL,
  "version" INTEGER NOT NULL
);

CREATE TABLE "macro_state" (
  "id" TEXT PRIMARY KEY,
  "gdp_growth_pct" REAL NOT NULL,
  "consumer_confidence" REAL NOT NULL,
  "ecb_rate_pct" REAL NOT NULL,
  "energy_index" REAL NOT NULL,
  "battery_cost_index" REAL NOT NULL,
  "credit_spread_bps" REAL NOT NULL,
  "shocks" TEXT NOT NULL
);

CREATE TABLE "segments" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "base_monthly_units" REAL NOT NULL,
  "ref_price_cents" INTEGER NOT NULL,
  "price_elasticity" REAL NOT NULL,
  "seasonality" TEXT NOT NULL,
  "growth_per_year" REAL NOT NULL,
  "powertrain_pref" TEXT NOT NULL,
  "pref_drift_per_year" TEXT NOT NULL,
  "other_utility" REAL NOT NULL,
  "description" TEXT NOT NULL
);

CREATE TABLE "vehicle_models" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "segment_id" TEXT NOT NULL,
  "powertrain" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "lifecycle" TEXT NOT NULL,
  "launch_date" TEXT,
  "net_price_cents" INTEGER NOT NULL,
  "list_price_cents" INTEGER NOT NULL,
  "base_appeal" REAL NOT NULL,
  "appeal_decay_per_year" REAL NOT NULL,
  "quality" REAL NOT NULL,
  "satisfaction" REAL NOT NULL,
  "co2_gkm" REAL NOT NULL,
  "other_material_cost_cents" INTEGER NOT NULL,
  "logistics_per_unit_cents" INTEGER NOT NULL,
  "warranty_per_unit_cents" INTEGER NOT NULL,
  "fg_units" INTEGER NOT NULL,
  "fg_value_cents" INTEGER NOT NULL,
  "dealer_stock" INTEGER NOT NULL,
  "backlog" INTEGER NOT NULL,
  "in_transit" INTEGER NOT NULL,
  "retail_mtd" INTEGER NOT NULL,
  "wholesale_mtd" INTEGER NOT NULL,
  "production_mtd" INTEGER NOT NULL,
  "retail_last_month" INTEGER NOT NULL,
  "wholesale_last_month" INTEGER NOT NULL,
  "production_last_month" INTEGER NOT NULL,
  "lost_sales_mtd" INTEGER NOT NULL,
  "cumulative_retail" INTEGER NOT NULL,
  "fg_unit_days_mtd" INTEGER NOT NULL,
  "euro7_compliant" INTEGER NOT NULL,
  "demand_modifier" REAL NOT NULL,
  "demand_modifier_until" TEXT,
  "project_id" TEXT,
  "description" TEXT NOT NULL
);

CREATE TABLE "competitors" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "strategy" TEXT NOT NULL,
  "financial_health" REAL NOT NULL,
  "ev_capability" REAL NOT NULL,
  "aggressiveness" REAL NOT NULL,
  "description" TEXT NOT NULL
);

CREATE TABLE "competitor_products" (
  "id" TEXT PRIMARY KEY,
  "competitor_id" TEXT NOT NULL,
  "segment_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "powertrain" TEXT NOT NULL,
  "price_cents" INTEGER NOT NULL,
  "appeal" REAL NOT NULL,
  "quality" REAL NOT NULL,
  "status" TEXT NOT NULL,
  "launch_date" TEXT,
  "dev_progress" REAL NOT NULL,
  "dev_rate_per_day" REAL NOT NULL,
  "last_price_change" TEXT
);

CREATE TABLE "factories" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "department_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "fixed_overhead_monthly_cents" INTEGER NOT NULL,
  "absenteeism_pct" REAL NOT NULL,
  "fixed_crew" REAL NOT NULL,
  "crew_per_daily_unit" REAL NOT NULL,
  "downtime" TEXT NOT NULL,
  "description" TEXT NOT NULL
);

CREATE TABLE "production_lines" (
  "id" TEXT PRIMARY KEY,
  "factory_id" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "max_daily_rate" INTEGER NOT NULL,
  "planned_daily_rate" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "ramp_start_date" TEXT,
  "ramp_days" INTEGER NOT NULL
);

CREATE TABLE "suppliers" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "reliability" REAL NOT NULL,
  "quality_score" REAL NOT NULL,
  "financial_health" REAL NOT NULL,
  "relationship" REAL NOT NULL,
  "payment_terms_days" INTEGER NOT NULL,
  "contact_id" TEXT,
  "description" TEXT NOT NULL
);

CREATE TABLE "component_supplies" (
  "id" TEXT PRIMARY KEY,
  "supplier_id" TEXT NOT NULL,
  "component" TEXT NOT NULL,
  "model_ids" TEXT NOT NULL,
  "unit_price_cents" INTEGER NOT NULL,
  "daily_capacity" INTEGER NOT NULL,
  "stock_units" INTEGER NOT NULL,
  "target_stock_days" REAL NOT NULL,
  "disruption_factor" REAL NOT NULL,
  "disruption_until" TEXT,
  "pending_capacity" TEXT NOT NULL,
  "contract_id" TEXT,
  "is_alternative" INTEGER NOT NULL
);

CREATE TABLE "departments" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "factory_id" TEXT,
  "head_id" TEXT,
  "headcount" INTEGER NOT NULL,
  "annual_cost_per_head_cents" INTEGER NOT NULL,
  "headcount_days" INTEGER NOT NULL,
  "morale" REAL NOT NULL,
  "attrition_pct_year" REAL NOT NULL,
  "hiring" TEXT NOT NULL,
  "leaving" TEXT NOT NULL,
  "expense_account" TEXT NOT NULL,
  "description" TEXT NOT NULL
);

CREATE TABLE "characters" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "org" TEXT NOT NULL,
  "org_name" TEXT NOT NULL,
  "department_id" TEXT,
  "reports_to" TEXT,
  "is_board_member" INTEGER NOT NULL,
  "skills" TEXT NOT NULL,
  "expertise" TEXT NOT NULL,
  "objectives" TEXT NOT NULL,
  "incentives" TEXT NOT NULL,
  "risk_tolerance" REAL NOT NULL,
  "personality" TEXT NOT NULL,
  "communication_style" TEXT NOT NULL,
  "trust_in_ceo" REAL NOT NULL,
  "stress" REAL NOT NULL,
  "authority" TEXT NOT NULL,
  "private_info" TEXT NOT NULL,
  "knowledge_scope" TEXT NOT NULL,
  "board_prefs" TEXT,
  "active" INTEGER NOT NULL,
  "bio" TEXT NOT NULL
);

CREATE TABLE "relationships" (
  "id" TEXT PRIMARY KEY,
  "from_id" TEXT NOT NULL,
  "to_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "strength" REAL NOT NULL,
  "note" TEXT NOT NULL
);

CREATE TABLE "projects" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "objective" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "sponsor_id" TEXT NOT NULL,
  "manager_id" TEXT NOT NULL,
  "department_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "start_date" TEXT NOT NULL,
  "original_target_date" TEXT NOT NULL,
  "target_date" TEXT NOT NULL,
  "forecast_date" TEXT,
  "forecast_p80_date" TEXT,
  "budget_cents" INTEGER NOT NULL,
  "original_budget_cents" INTEGER NOT NULL,
  "spent_cents" INTEGER NOT NULL,
  "external_spent_cents" INTEGER NOT NULL,
  "internal_cost_cents" INTEGER NOT NULL,
  "committed_cents" INTEGER NOT NULL,
  "staffing_fte" REAL NOT NULL,
  "base_fte" REAL NOT NULL,
  "productivity" REAL NOT NULL,
  "capitalize_external" INTEGER NOT NULL,
  "external_accrual_cents" INTEGER NOT NULL,
  "acceptance_criteria" TEXT NOT NULL,
  "dependencies" TEXT NOT NULL,
  "linked_model_id" TEXT,
  "template_key" TEXT,
  "completion_effects" TEXT NOT NULL,
  "risks" TEXT NOT NULL,
  "last_decision" TEXT,
  "completed_date" TEXT,
  "description" TEXT NOT NULL
);

CREATE TABLE "milestones" (
  "id" TEXT PRIMARY KEY,
  "project_id" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "work_total" REAL NOT NULL,
  "work_done" REAL NOT NULL,
  "status" TEXT NOT NULL,
  "planned_date" TEXT NOT NULL,
  "original_planned_date" TEXT NOT NULL,
  "completed_date" TEXT,
  "gates" TEXT NOT NULL,
  "external_cost_cents" INTEGER NOT NULL,
  "late_flagged" INTEGER NOT NULL
);

CREATE TABLE "issues" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "owner_id" TEXT,
  "discovered_date" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "next_action" TEXT NOT NULL,
  "deadline" TEXT,
  "linked" TEXT NOT NULL,
  "project_id" TEXT,
  "drag" REAL NOT NULL,
  "resolution_work_total" REAL NOT NULL,
  "resolution_work_done" REAL NOT NULL,
  "options" TEXT NOT NULL,
  "chosen_options" TEXT NOT NULL,
  "resolved_date" TEXT,
  "resolution_note" TEXT,
  "data" TEXT NOT NULL
);

CREATE TABLE "commitments" (
  "id" TEXT PRIMARY KEY,
  "promisor_id" TEXT NOT NULL,
  "promisee_id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "due_date" TEXT,
  "conditions" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_date" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "source_id" TEXT,
  "check" TEXT NOT NULL,
  "resolved_date" TEXT,
  "notified_upcoming" INTEGER NOT NULL,
  "importance" INTEGER NOT NULL
);

CREATE TABLE "debt_instruments" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "lender" TEXT NOT NULL,
  "lender_character_id" TEXT,
  "principal_cents" INTEGER NOT NULL,
  "limit_cents" INTEGER NOT NULL,
  "rate_bps" INTEGER NOT NULL,
  "commitment_fee_bps" INTEGER NOT NULL,
  "start_date" TEXT NOT NULL,
  "maturity_date" TEXT NOT NULL,
  "interest_months" TEXT NOT NULL,
  "payment_day" INTEGER NOT NULL,
  "amortization" TEXT NOT NULL,
  "principal_days" INTEGER NOT NULL,
  "undrawn_days" INTEGER NOT NULL,
  "interest_payable_cents" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "secured" INTEGER NOT NULL,
  "conditions" TEXT NOT NULL
);

CREATE TABLE "covenants" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "instrument_ids" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "comparator" TEXT NOT NULL,
  "threshold" REAL NOT NULL,
  "last_test_date" TEXT,
  "last_value" REAL,
  "status" TEXT NOT NULL,
  "waiver_until" TEXT,
  "description" TEXT NOT NULL
);

CREATE TABLE "receivables" (
  "id" TEXT PRIMARY KEY,
  "counterparty" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "issue_date" TEXT NOT NULL,
  "due_date" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "settled_date" TEXT,
  "source" TEXT NOT NULL
);

CREATE TABLE "payables" (
  "id" TEXT PRIMARY KEY,
  "counterparty_id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "issue_date" TEXT NOT NULL,
  "due_date" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "paid_date" TEXT,
  "source_id" TEXT,
  "liability_account" TEXT NOT NULL
);

CREATE TABLE "contracts" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "counterparty_id" TEXT,
  "counterparty_name" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "terms" TEXT NOT NULL,
  "start_date" TEXT,
  "end_date" TEXT,
  "signed_date" TEXT,
  "value_cents" INTEGER NOT NULL,
  "amendment_of" TEXT,
  "negotiation_id" TEXT,
  "template_key" TEXT,
  "obligations" TEXT NOT NULL,
  "summary" TEXT NOT NULL
);

CREATE TABLE "negotiations" (
  "id" TEXT PRIMARY KEY,
  "template_key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "counterparty_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "terms" TEXT NOT NULL,
  "reservation" TEXT NOT NULL,
  "ideal" TEXT NOT NULL,
  "weights" TEXT NOT NULL,
  "base_threshold" REAL NOT NULL,
  "concession_per_round" REAL NOT NULL,
  "max_rounds" INTEGER NOT NULL,
  "rounds" TEXT NOT NULL,
  "deadline" TEXT,
  "created_date" TEXT NOT NULL,
  "agreed_terms" TEXT,
  "contract_id" TEXT,
  "linked_issue_id" TEXT,
  "context" TEXT NOT NULL,
  "pending_decision" TEXT
);

CREATE TABLE "financing_requests" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "counterparty" TEXT NOT NULL,
  "counterparty_id" TEXT,
  "requested_cents" INTEGER NOT NULL,
  "tenor_years" REAL NOT NULL,
  "status" TEXT NOT NULL,
  "submitted_date" TEXT NOT NULL,
  "decision_date" TEXT,
  "offer" TEXT,
  "decision_reason" TEXT,
  "rationale" TEXT NOT NULL,
  "executed_date" TEXT,
  "instrument_id" TEXT,
  "action_id" TEXT,
  "analysis" TEXT NOT NULL
);

CREATE TABLE "board_proposals" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "action_id" TEXT,
  "summary" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "analysis" TEXT NOT NULL,
  "submitted_date" TEXT NOT NULL,
  "meeting_date" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "votes" TEXT NOT NULL,
  "decided_date" TEXT,
  "outcome_note" TEXT
);

CREATE TABLE "regulations" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "effective_date" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "params" TEXT NOT NULL
);

CREATE TABLE "event_states" (
  "key" TEXT PRIMARY KEY,
  "last_fired" TEXT,
  "count" INTEGER NOT NULL,
  "active_until" TEXT,
  "data" TEXT NOT NULL
);

CREATE INDEX idx_payables_status ON payables(status, due_date);
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
