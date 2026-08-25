import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { MCPInterceptor } from '../src/proxy/mcp-interceptor.js';
import { ManifestLoader } from '../src/manifest/manifest-loader.js';
import { VerifierEngine } from '../src/verification/verifier-engine.js';

describe('PHASE 5: Ambiguous Outcome & Crash Consistency', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let ledger: TransactionLedger;
  let manifestLoader: ManifestLoader;
  let verifierEngine: VerifierEngine;
  let interceptor: MCPInterceptor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-phase5-'));
    ledgerPath = join(tmpDir, 'test-ledger.db');
    ledger = new TransactionLedger(ledgerPath);
    manifestLoader = new ManifestLoader({
      version: '0.1.0',
      ledgerPath,
      tools: {
        critical_mutation: {
          toolName: 'critical_mutation',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['orderId'],
          timeoutMs: 100,
          maxRetries: 1,
          verifier: {
            toolName: 'verify_order',
            argumentMapping: { orderId: 'orderId' },
            matchKeyPath: 'status',
            expectedValue: 'PLACED',
          },
        },
        unverified_critical_mutation: {
          toolName: 'unverified_critical_mutation',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['orderId'],
          timeoutMs: 100,
          maxRetries: 1,
        },
      },
    });
    verifierEngine = new VerifierEngine(ledger);
    interceptor = new MCPInterceptor(ledger, manifestLoader, verifierEngine);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Reconciles ambiguous timeout to COMMITTED when verifier returns PROVEN_COMMITTED', async () => {
    let verifierCalled = false;
    const mockExecutor = async (name: string, _args: Record<string, unknown>) => {
      if (name === 'critical_mutation') {
        // Exceed 100ms timeout
        await new Promise(r => setTimeout(r, 200));
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      }
      if (name === 'verify_order') {
        verifierCalled = true;
        return {
          content: [{ type: 'text', text: JSON.stringify({ orderId: 'ord_1', status: 'PLACED' }) }],
          isError: false,
        };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown' }] };
    };

    const res = await interceptor.handleToolCall(
      { toolName: 'critical_mutation', arguments: { orderId: 'ord_1', amount: 50 } },
      mockExecutor
    );

    expect(verifierCalled).toBe(true);
    expect(res.isError).toBeFalsy();
    expect(res._agentxReceipt?.state).toBe('COMMITTED');

    // Verify ledger state
    const tx = ledger.getTransactionByFingerprint(res._agentxReceipt!.fingerprint);
    expect(tx?.state).toBe('COMMITTED');
  });

  it('2. Fails closed to UNKNOWN_STATE on timeout when no verifier is declared', async () => {
    const mockExecutor = async (_name: string, _args: Record<string, unknown>) => {
      await new Promise(r => setTimeout(r, 250));
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    };

    const res = await interceptor.handleToolCall(
      { toolName: 'unverified_critical_mutation', arguments: { orderId: 'ord_unverified' } },
      mockExecutor
    );

    expect(res.isError).toBe(true);
    expect(res._agentxReceipt?.state).toBe('UNKNOWN_STATE');

    // On subsequent retry attempt, fail-closed guard blocks execution
    let secondAttemptDownstreamCalled = false;
    const res2 = await interceptor.handleToolCall(
      { toolName: 'unverified_critical_mutation', arguments: { orderId: 'ord_unverified' } },
      async () => {
        secondAttemptDownstreamCalled = true;
        return { content: [{ type: 'text', text: 'should not reach' }], isError: false };
      }
    );

    expect(secondAttemptDownstreamCalled).toBe(false);
    expect(res2.isError).toBe(true);
    expect(res2.content[0].text).toContain('[AgentX Fail-Closed]');
  });

  it('3. Durable recovery: transaction states survive database reconnection and process restart', () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_recovery_test',
      toolName: 'critical_mutation',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { orderId: 'ord_rec_1' },
    });
    ledger.updateTransactionState(tx.id, 'COMMITTED', {
      resultPayload: { response: { content: [{ type: 'text', text: 'success' }] } },
    });

    // Reconnect new ledger instance to same file
    const restartedLedger = new TransactionLedger(ledgerPath);
    const recoveredTx = restartedLedger.getTransactionById(tx.id);
    expect(recoveredTx).toBeDefined();
    expect(recoveredTx?.state).toBe('COMMITTED');
    expect(recoveredTx?.fingerprint).toBe('fp_recovery_test');
  });
});
