-- Migration 0001: initial schema (additive only; this project never ships a destructive migration).
-- Conventions: ISO-8601 UTC text timestamps, JSON columns suffixed _json, idempotency via UNIQUE keys.

CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  question TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  tags_json TEXT NOT NULL DEFAULT '[]',
  end_date TEXT NOT NULL,
  yes_token_id TEXT NOT NULL,
  no_token_id TEXT NOT NULL,
  outcomes_json TEXT NOT NULL,
  fee_rate REAL NOT NULL DEFAULT 0,
  fee_exponent REAL NOT NULL DEFAULT 1,
  fee_source TEXT NOT NULL DEFAULT 'assumed_max',
  neg_risk INTEGER NOT NULL DEFAULT 0,
  event_id TEXT,
  event_market_count INTEGER,
  liquidity REAL NOT NULL DEFAULT 0,
  volume_24h REAL NOT NULL DEFAULT 0,
  min_order_size REAL NOT NULL DEFAULT 5,
  tick_size REAL NOT NULL DEFAULT 0.01,
  status TEXT NOT NULL DEFAULT 'tracked' CHECK (status IN ('tracked', 'closed', 'resolved', 'ignored')),
  ignore_reason TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_priced_at TEXT,
  last_ai_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_markets_status_end ON markets (status, end_date);
CREATE INDEX IF NOT EXISTS idx_markets_event ON markets (event_id);

CREATE TABLE IF NOT EXISTS price_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES markets (id),
  token_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  observed_at TEXT NOT NULL,
  best_bid REAL,
  best_ask REAL,
  mid REAL,
  spread REAL,
  bid_depth_usdc REAL NOT NULL DEFAULT 0,
  ask_depth_usdc REAL NOT NULL DEFAULT 0,
  book_ts INTEGER NOT NULL DEFAULT 0,
  book_hash TEXT NOT NULL DEFAULT '',
  age_seconds REAL,
  top_levels_json TEXT,
  UNIQUE (token_id, book_ts, book_hash)
);
CREATE INDEX IF NOT EXISTS idx_obs_market_time ON price_observations (market_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_time ON price_observations (observed_at);

CREATE TABLE IF NOT EXISTS ai_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES markets (id),
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'invalid', 'error', 'skipped_quota')),
  summary TEXT NOT NULL,
  probability_estimate REAL,
  confidence TEXT NOT NULL,
  supporting_json TEXT NOT NULL DEFAULT '[]',
  contradicting_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  resolution_risks_json TEXT NOT NULL DEFAULT '[]',
  data_freshness TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  adjustments_json TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  neurons_est REAL NOT NULL DEFAULT 0,
  error TEXT,
  raw_excerpt TEXT,
  UNIQUE (market_id, prompt_hash)
);
CREATE INDEX IF NOT EXISTS idx_ai_market ON ai_analyses (market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_time ON ai_analyses (created_at);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,
  market_id TEXT NOT NULL REFERENCES markets (id),
  created_at TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('VALUE', 'ARBITRAGE')),
  side TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'REJECTED')),
  estimate_p REAL,
  estimate_ci_low REAL,
  estimate_ci_high REAL,
  estimate_n INTEGER,
  estimate_source TEXT,
  exec_price REAL,
  fee_rate REAL NOT NULL DEFAULT 0,
  fee_cost_per_share REAL,
  spread REAL,
  slippage_per_share REAL,
  gross_edge REAL,
  net_edge REAL,
  safety_margin REAL NOT NULL DEFAULT 0,
  suggested_shares REAL NOT NULL DEFAULT 0,
  suggested_notional REAL NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  strategy_version TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_signals_time ON signals (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_market ON signals (market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS simulated_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals (id),
  market_id TEXT NOT NULL REFERENCES markets (id),
  created_at TEXT NOT NULL,
  side TEXT NOT NULL,
  outcome TEXT NOT NULL,
  token_id TEXT NOT NULL,
  requested_shares REAL NOT NULL,
  filled_shares REAL NOT NULL,
  vwap_price REAL,
  worst_price REAL,
  notional_usdc REAL NOT NULL,
  fee_paid_usdc REAL NOT NULL,
  slippage_usdc REAL NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SETTLED', 'CANCELLED')),
  settled_at TEXT,
  payout_usdc REAL,
  pnl_usdc REAL,
  -- Structural guarantee: a row of this table is a simulation. The CHECK makes anything else impossible.
  is_simulation INTEGER NOT NULL DEFAULT 1 CHECK (is_simulation = 1)
);
CREATE INDEX IF NOT EXISTS idx_sim_status ON simulated_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sim_market ON simulated_orders (market_id);

CREATE TABLE IF NOT EXISTS market_results (
  market_id TEXT PRIMARY KEY REFERENCES markets (id),
  resolved_at TEXT NOT NULL,
  winning_outcome TEXT NOT NULL,
  winning_side TEXT NOT NULL CHECK (winning_side IN ('YES', 'NO')),
  final_prices_json TEXT NOT NULL,
  uma_status TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calibration_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES markets (id),
  obs_day TEXT NOT NULL,
  price REAL NOT NULL,
  days_to_end REAL NOT NULL,
  outcome INTEGER NOT NULL CHECK (outcome IN (0, 1)),
  category TEXT NOT NULL DEFAULT 'other',
  created_at TEXT NOT NULL,
  UNIQUE (market_id, obs_day)
);
CREATE INDEX IF NOT EXISTS idx_calib_price ON calibration_samples (price, days_to_end);

CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual', 'test')),
  phase TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'skipped')),
  markets_scanned INTEGER NOT NULL DEFAULT 0,
  signals_created INTEGER NOT NULL DEFAULT 0,
  signals_accepted INTEGER NOT NULL DEFAULT 0,
  ai_calls INTEGER NOT NULL DEFAULT 0,
  subrequests INTEGER NOT NULL DEFAULT 0,
  d1_statements INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON run_logs (started_at DESC);

CREATE TABLE IF NOT EXISTS quota_usage (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, metric)
);

CREATE TABLE IF NOT EXISTS strategy_params (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
