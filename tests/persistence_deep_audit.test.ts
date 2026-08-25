import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { MCPInterceptor } from '../src/proxy/mcp-interceptor.js';
import { ManifestLoader } from '../src/manifest/manifest-loader.js';
import { DatabaseManager } from '../src/ledger/database.js';
import { SagaCoordinator } from '../src/compensation/saga-coordinator.js';
import { VerifierEngine } from '../src/verification/verifier-engine.js';

describe('Deep Persistence & I/O Redaction Audit', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let rawDb: DatabaseManager;
  let ledger: TransactionLedger;
  let manifestLoader: ManifestLoader;
  let interceptor: MCPInterceptor;
  let sagaCoordinator: SagaCoordinator;
  let verifierEngine: VerifierEngine;

  const TEST_SECRETS = [
    'SyntheticSecretPass_4091',
    'bearer_live_test_token_888999',
    'sk_live_synthetic_api_key_000',
    '4111-9999-8888-7777',
    'cvv_secret_333',
    'ssn_secret_999-00-1111',
    '+905559876543',
    'Sensitive Patient Health Diagnosis Text'
  ];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-deep-persistence-'));
    ledgerPath = join(tmpDir, 'deep-persistence.db');
    rawDb = new DatabaseManager(ledgerPath);
    ledger = new TransactionLedger(rawDb.getDatabase());
    manifestLoader = new ManifestLoader({
      version: '0.1.1',
      ledgerPath,
      tools: {
        all_in_one_tool: {
          toolName: 'all_in_one_tool',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['orderId'],
          timeoutMs: 5000,
          maxRetries: 1,
          sensitiveFields: ['patientPhone', 'medicalNote', 'password', 'token', 'apiKey', 'creditCard', 'cvv', 'ssn'],
          verifier: {
            toolName: 'verify_all_in_one',
            argumentMapping: { orderId: 'orderId' },
            matchKeyPath: 'status',
            expectedValue: 'VERIFIED'
          },
          compensator: {
            toolName: 'cancel_all_in_one',
            argumentMapping: { orderId: 'orderId' }
          }
        }
      }
    });
    verifierEngine = new VerifierEngine(ledger);
    interceptor = new MCPInterceptor(ledger, manifestLoader, verifierEngine);
    sagaCoordinator = new SagaCoordinator(ledger);
  });

  afterEach(() => {
    rawDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Exhaustive inspection of all SQLite tables, columns, receipts, and attempts ensures zero plaintext leakage', async () => {
    const inputArgs = {
      orderId: 'ord_deep_001',
      password: TEST_SECRETS[0],
      token: TEST_SECRETS[1],
      apiKey: TEST_SECRETS[2],
      creditCard: TEST_SECRETS[3],
      cvv: TEST_SECRETS[4],
      ssn: TEST_SECRETS[5],
      patientPhone: TEST_SECRETS[6],
      medicalNote: TEST_SECRETS[7],
    };

    // 1. Execute mutation
    const execRes = await interceptor.handleToolCall(
      { toolName: 'all_in_one_tool', arguments: inputArgs },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ status: 'SUCCESS', details: inputArgs }) }],
        isError: false
      })
    );

    expect(execRes.isError).toBeFalsy();
    const txId = execRes._agentxReceipt!.transactionId;

    // 2. Execute verification
    await verifierEngine.verifyTransaction(
      txId,
      {
        toolName: 'verify_all_in_one',
        matchKeyPath: 'status',
        expectedValue: 'VERIFIED'
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ status: 'VERIFIED', evidenceDetails: inputArgs }) }],
        isError: false
      })
    );

    // 3. Execute compensation
    await sagaCoordinator.compensateTransaction(
      txId,
      { toolName: 'cancel_all_in_one' },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ cancelled: true, compDetails: inputArgs }) }],
        isError: false
      })
    );

    // 4. Directly query EVERY table in SQLite database and scan all columns for any secret
    const db = rawDb.getDatabase();
    const tableNames = ['transactions', 'attempts', 'verifications', 'compensations'];

    for (const tableName of tableNames) {
      const rows = db.prepare(`SELECT * FROM ${tableName}`).all() as any[];
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        for (const [colName, val] of Object.entries(row)) {
          if (typeof val === 'string') {
            for (const secret of TEST_SECRETS) {
              if (val.includes(secret)) {
                throw new Error(`CRITICAL LEAK: Secret "${secret}" found in ${tableName}.${colName}: ${val}`);
              }
            }
          }
        }
      }
    }

    // 5. Inspect generated receipt object
    const finalReceipt = ledger.generateReceipt(txId);
    const receiptString = JSON.stringify(finalReceipt);
    for (const secret of TEST_SECRETS) {
      expect(receiptString).not.toContain(secret);
    }
  });
});
