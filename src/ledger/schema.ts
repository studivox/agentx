/**
 * AgentX SQLite DDL & Migration Scripts
 */

import { Database as DatabaseType } from 'better-sqlite3';
import { redactSensitiveData } from '../utils/redaction.js';
import { logger } from '../utils/logger.js';

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
  metadata_json TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT
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

/**
 * Executes idempotent migrations for v0.1.0 to v0.1.1+ upgrades.
 * Adds lease columns if missing, ensures indices, and sanitizes any legacy unredacted raw_arguments.
 */
export function migrateDatabase(db: DatabaseType): void {
  // Check if transactions table exists
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'").get();
  if (!tableCheck) {
    db.exec(INITIAL_SCHEMA);
    return;
  }

  // 1. Column migrations
  const columns = db.prepare("PRAGMA table_info(transactions)").all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));

  if (!colNames.has('lease_owner')) {
    db.exec("ALTER TABLE transactions ADD COLUMN lease_owner TEXT;");
  }
  if (!colNames.has('lease_expires_at')) {
    db.exec("ALTER TABLE transactions ADD COLUMN lease_expires_at TEXT;");
  }

  // 2. Index creation
  db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_lease ON transactions(lease_expires_at);");

  // 3. Data Migration: Sanitize any legacy v0.1.0 records where raw_arguments contained plaintext secrets
  const migrationTx = db.transaction(() => {
    const rows = db.prepare("SELECT id, raw_arguments, sanitized_arguments FROM transactions").all() as Array<{
      id: string;
      raw_arguments: string;
      sanitized_arguments: string;
    }>;

    const updateStmt = db.prepare(
      "UPDATE transactions SET raw_arguments = ?, sanitized_arguments = ? WHERE id = ?"
    );

    for (const row of rows) {
      try {
        const rawParsed = JSON.parse(row.raw_arguments);
        const redactedRaw = redactSensitiveData(rawParsed);
        const newRawJson = JSON.stringify(redactedRaw);

        const sanParsed = JSON.parse(row.sanitized_arguments);
        const redactedSan = redactSensitiveData(sanParsed);
        const newSanJson = JSON.stringify(redactedSan);

        if (newRawJson !== row.raw_arguments || newSanJson !== row.sanitized_arguments) {
          updateStmt.run(newRawJson, newSanJson, row.id);
        }
      } catch {
        // Skip unparseable legacy records safely
      }
    }
  });

  try {
    migrationTx();
  } catch (err) {
    logger.warn('Non-fatal error during legacy database migration:', err);
  }
}
