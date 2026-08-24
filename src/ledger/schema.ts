/**
 * AgentX SQLite DDL & Migration Scripts
 */

export const INITIAL_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  raw_arguments TEXT NOT NULL,
  sanitized_arguments TEXT NOT NULL,
  result_payload TEXT,
  error_payload TEXT,
  receipt_json TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_fingerprint ON transactions(fingerprint);
CREATE INDEX IF NOT EXISTS idx_transactions_state ON transactions(state);
CREATE INDEX IF NOT EXISTS idx_transactions_tool_name ON transactions(tool_name);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  error_message TEXT,
  response_snippet TEXT,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attempts_tx_id ON attempts(transaction_id);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  verifier_tool TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  notes TEXT,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_verifications_tx_id ON verifications(transaction_id);

CREATE TABLE IF NOT EXISTS compensations (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  compensator_tool TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_compensations_tx_id ON compensations(transaction_id);
`;
