import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseManager } from '../src/ledger/database.js';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';

describe('PHASE 11: SQLite Durability & Failure Tests', () => {
  let tmpDir: string;
  let dbPath: string;
  let dbManager: DatabaseManager;
  let ledger: TransactionLedger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-phase11-'));
    dbPath = join(tmpDir, 'test-durability.db');
    dbManager = new DatabaseManager(dbPath);
    ledger = new TransactionLedger(dbManager.getDatabase());
  });

  afterEach(() => {
    dbManager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Verifies SQLite WAL journal mode is active', () => {
    const db = dbManager.getDatabase();
    const row = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe('wal');
  });

  it('2. Verifies pagination and filtering in TransactionLedger', () => {
    for (let i = 0; i < 15; i++) {
      const tx = ledger.createTransaction({
        fingerprint: `fp_durability_${i}`,
        toolName: i % 2 === 0 ? 'tool_a' : 'tool_b',
        riskLevel: 'MUTATING_CRITICAL',
        rawArguments: { count: i },
      });
      if (i < 5) {
        ledger.updateTransactionState(tx.id, 'COMMITTED');
      } else if (i < 10) {
        ledger.updateTransactionState(tx.id, 'FAILED');
      }
    }

    const committed = ledger.listTransactions({ state: 'COMMITTED' });
    expect(committed.length).toBe(5);

    const toolARecords = ledger.listTransactions({ toolName: 'tool_a' });
    expect(toolARecords.length).toBe(8);

    const page1 = ledger.listTransactions({ limit: 5, offset: 0 });
    expect(page1.length).toBe(5);
  });

  it('3. Durability across independent database instances on same file', () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_durable_restart',
      toolName: 'book_appointment',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { id: 42 },
    });
    ledger.updateTransactionState(tx.id, 'COMMITTED', {
      resultPayload: { response: { content: [{ type: 'text', text: 'Confirmed' }] } },
    });

    const secondManager = new DatabaseManager(dbPath);
    const secondLedger = new TransactionLedger(secondManager.getDatabase());
    const recovered = secondLedger.getTransactionById(tx.id);

    expect(recovered).toBeDefined();
    expect(recovered?.state).toBe('COMMITTED');
    secondManager.close();
  });
});
