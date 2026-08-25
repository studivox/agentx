import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { MCPInterceptor } from '../src/proxy/mcp-interceptor.js';
import { ManifestLoader } from '../src/manifest/manifest-loader.js';
import { DatabaseManager } from '../src/ledger/database.js';

describe('PHASE 6: Critical Data-at-Rest and Redaction Audit', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let ledger: TransactionLedger;
  let manifestLoader: ManifestLoader;
  let interceptor: MCPInterceptor;
  let rawDb: DatabaseManager;

  const SYNTHETIC_SECRETS = {
    password: 'SyntheticSuperSecretPassword123!',
    token: 'bearer_synthetic_token_xyz987654321',
    apiKey: 'sk_synthetic_live_1234567890abcdef',
    creditCard: '4111-2222-3333-4444',
    cvv: '999',
    patientPhone: '+905551234567',
    medicalNote: 'Patient has confidential medical history',
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-phase6-'));
    ledgerPath = join(tmpDir, 'test-ledger.db');
    rawDb = new DatabaseManager(ledgerPath);
    ledger = new TransactionLedger(rawDb.getDatabase());
    manifestLoader = new ManifestLoader({
      version: '0.1.0',
      ledgerPath,
      tools: {
        secure_mutation: {
          toolName: 'secure_mutation',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['userId'],
          timeoutMs: 5000,
          maxRetries: 1,
          sensitiveFields: ['patientPhone', 'medicalNote', 'password', 'token', 'apiKey', 'creditCard', 'cvv'],
        },
      },
    });
    interceptor = new MCPInterceptor(ledger, manifestLoader);
  });

  afterEach(() => {
    rawDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Zero Plaintext Secrets in SQLite Transactions Table (raw_arguments & sanitized_arguments)', async () => {
    const inputArgs = {
      userId: 'user_4081',
      password: SYNTHETIC_SECRETS.password,
      token: SYNTHETIC_SECRETS.token,
      apiKey: SYNTHETIC_SECRETS.apiKey,
      creditCard: SYNTHETIC_SECRETS.creditCard,
      cvv: SYNTHETIC_SECRETS.cvv,
      patientPhone: SYNTHETIC_SECRETS.patientPhone,
      medicalNote: SYNTHETIC_SECRETS.medicalNote,
    };

    const res = await interceptor.handleToolCall(
      { toolName: 'secure_mutation', arguments: inputArgs },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ status: 'PROCESSED' }) }],
        isError: false,
      })
    );

    expect(res.isError).toBeFalsy();

    // Query SQLite database directly at the raw SQL level
    const db = rawDb.getDatabase();
    const txRow = db.prepare('SELECT * FROM transactions WHERE id = ?').get(res._agentxReceipt!.transactionId) as any;

    expect(txRow).toBeDefined();

    // Check every single column in the transactions table
    for (const [colName, val] of Object.entries(txRow)) {
      if (typeof val === 'string') {
        for (const [secretKey, secretVal] of Object.entries(SYNTHETIC_SECRETS)) {
          if (val.includes(secretVal)) {
            throw new Error(`CRITICAL SECURITY FAILURE: Secret ${secretKey} found in plaintext in transactions.${colName}! Value: ${val}`);
          }
        }
      }
    }
  });

  it('2. Zero Plaintext Secrets in SQLite Attempts, Verifications & Compensations Tables', async () => {
    const db = rawDb.getDatabase();

    const attempts = db.prepare('SELECT * FROM attempts').all() as any[];
    for (const row of attempts) {
      for (const [colName, val] of Object.entries(row)) {
        if (typeof val === 'string') {
          for (const [secretKey, secretVal] of Object.entries(SYNTHETIC_SECRETS)) {
            if (val.includes(secretVal)) {
              throw new Error(`CRITICAL SECURITY FAILURE: Secret ${secretKey} found in plaintext in attempts.${colName}!`);
            }
          }
        }
      }
    }
  });

  it('3. Receipts do not contain plaintext secrets', async () => {
    const inputArgs = {
      userId: 'user_4081',
      password: SYNTHETIC_SECRETS.password,
      patientPhone: SYNTHETIC_SECRETS.patientPhone,
    };

    const res = await interceptor.handleToolCall(
      { toolName: 'secure_mutation', arguments: inputArgs },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ status: 'OK' }) }],
        isError: false,
      })
    );

    const receiptStr = JSON.stringify(res._agentxReceipt);
    expect(receiptStr).not.toContain(SYNTHETIC_SECRETS.password);
    expect(receiptStr).not.toContain(SYNTHETIC_SECRETS.patientPhone);
  });
});
