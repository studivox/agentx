import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseManager } from '../src/ledger/database.js';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';

describe('v0.1.0 to v0.1.1+ Ledger Upgrade & Migration Tests', () => {
  let tmpDir: string;
  let legacyDbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-upgrade-test-'));
    legacyDbPath = join(tmpDir, 'legacy-v010-ledger.db');

    // Create a raw v0.1.0 SQLite database (legacy schema without lease columns, with plaintext secrets in raw_arguments)
    const rawDb = new Database(legacyDbPath);
    rawDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE transactions (
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
    `);

    const insertStmt = rawDb.prepare(`
      INSERT INTO transactions VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    // Insert legacy v0.1.0 rows with plaintext secrets stored in raw_arguments
    insertStmt.run(
      'tx_legacy_001',
      'fp_legacy_001',
      'charge_card',
      'COMMITTED',
      'MUTATING_CRITICAL',
      '2026-08-24T12:00:00.000Z',
      '2026-08-24T12:00:01.000Z',
      '2026-08-31T12:00:00.000Z',
      JSON.stringify({ userId: 'user_1', password: 'PlaintextLegacyPassword123!', creditCard: '4111-2222-3333-4444', cvv: '999', apiKey: 'sk_live_legacy123' }),
      JSON.stringify({ userId: 'user_1', password: '[REDACTED]', creditCard: '[REDACTED]', cvv: '[REDACTED]', apiKey: '[REDACTED]' }),
      JSON.stringify({ status: 'OK' }),
      null,
      null,
      null
    );

    insertStmt.run(
      'tx_legacy_002',
      'fp_legacy_002',
      'book_appointment',
      'COMMITTED',
      'MUTATING_CRITICAL',
      '2026-08-24T13:00:00.000Z',
      '2026-08-24T13:00:01.000Z',
      '2026-08-31T13:00:00.000Z',
      JSON.stringify({ patientId: 'p_99', patientPhone: '+905551234567', medicalNote: 'Confidential Diagnosis' }),
      JSON.stringify({ patientId: 'p_99', patientPhone: '[REDACTED]', medicalNote: '[REDACTED]' }),
      JSON.stringify({ booked: true }),
      null,
      null,
      null
    );

    rawDb.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Automatically migrates v0.1.0 database schema by adding lease columns', () => {
    // Open legacy database using new DatabaseManager
    const dbManager = new DatabaseManager(legacyDbPath);
    const db = dbManager.getDatabase();

    const columns = db.prepare("PRAGMA table_info(transactions)").all() as Array<{ name: string }>;
    const colNames = columns.map(c => c.name);

    expect(colNames).toContain('lease_owner');
    expect(colNames).toContain('lease_expires_at');

    dbManager.close();
  });

  it('2. Automatically sanitizes legacy plaintext raw_arguments across all historical rows', () => {
    const dbManager = new DatabaseManager(legacyDbPath);
    const db = dbManager.getDatabase();

    const rows = db.prepare("SELECT * FROM transactions").all() as any[];
    expect(rows.length).toBe(2);

    for (const row of rows) {
      expect(row.raw_arguments).not.toContain('PlaintextLegacyPassword123!');
      expect(row.raw_arguments).not.toContain('4111-2222-3333-4444');
      expect(row.raw_arguments).not.toContain('sk_live_legacy123');
      expect(row.raw_arguments).not.toContain('+905551234567');
      expect(row.raw_arguments).not.toContain('Confidential Diagnosis');

      expect(row.raw_arguments).toContain('[REDACTED]');
    }

    dbManager.close();
  });

  it('3. Migration is idempotent and safe against repeated executions', () => {
    // Run migration twice
    const dbManager1 = new DatabaseManager(legacyDbPath);
    dbManager1.close();

    const dbManager2 = new DatabaseManager(legacyDbPath);
    const ledger = new TransactionLedger(dbManager2.getDatabase());
    const tx1 = ledger.getTransactionById('tx_legacy_001');

    expect(tx1).toBeDefined();
    expect(tx1?.state).toBe('COMMITTED');
    expect(tx1?.rawArguments).not.toContain('PlaintextLegacyPassword123!');

    dbManager2.close();
  });
});
