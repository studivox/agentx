import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeFingerprint } from '../src/fingerprint/canonicalizer.js';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { MCPInterceptor } from '../src/proxy/mcp-interceptor.js';
import { ManifestLoader } from '../src/manifest/manifest-loader.js';

describe('PHASE 4: Execute-Once & Concurrency Attacks', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let ledger: TransactionLedger;
  let manifestLoader: ManifestLoader;
  let interceptor: MCPInterceptor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-phase4-'));
    ledgerPath = join(tmpDir, 'test-ledger.db');
    ledger = new TransactionLedger(ledgerPath);
    manifestLoader = new ManifestLoader({
      version: '0.1.0',
      ledgerPath,
      tools: {
        transfer_funds: {
          toolName: 'transfer_funds',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['from', 'to', 'amount'],
          timeoutMs: 5000,
          maxRetries: 1,
        },
        create_user: {
          toolName: 'create_user',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['profile.username', 'profile.email'],
          timeoutMs: 5000,
          maxRetries: 1,
        },
        tag_resource: {
          toolName: 'tag_resource',
          riskLevel: 'MUTATING_SAFE',
          logicalKeys: ['resourceId', 'tags'],
          timeoutMs: 5000,
          maxRetries: 1,
        },
      },
    });
    interceptor = new MCPInterceptor(ledger, manifestLoader);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Reordered JSON keys produce identical deterministic fingerprint', () => {
    const fp1 = computeFingerprint('transfer_funds', { from: 'acc_1', to: 'acc_2', amount: 500 }, ['from', 'to', 'amount']);
    const fp2 = computeFingerprint('transfer_funds', { amount: 500, to: 'acc_2', from: 'acc_1' }, ['from', 'to', 'amount']);
    expect(fp1.hash).toBe(fp2.hash);
  });

  it('2. Nested reordered object keys produce identical deterministic fingerprint', () => {
    const fp1 = computeFingerprint('create_user', { profile: { username: 'wocu', email: 'wocu@example.com' } }, ['profile.username', 'profile.email']);
    const fp2 = computeFingerprint('create_user', { profile: { email: 'wocu@example.com', username: 'wocu' } }, ['profile.username', 'profile.email']);
    expect(fp1.hash).toBe(fp2.hash);
  });

  it('3. Array elements maintain significant ordering (different orders = different fingerprints)', () => {
    const fp1 = computeFingerprint('tag_resource', { resourceId: 'res_1', tags: ['admin', 'billing'] }, ['resourceId', 'tags']);
    const fp2 = computeFingerprint('tag_resource', { resourceId: 'res_1', tags: ['billing', 'admin'] }, ['resourceId', 'tags']);
    expect(fp1.hash).not.toBe(fp2.hash);
  });

  it('4. Explicit null vs omitted optional fields produce distinct canonical representations', () => {
    const fp1 = computeFingerprint('tag_resource', { resourceId: 'res_1', tags: ['a'], note: null });
    const fp2 = computeFingerprint('tag_resource', { resourceId: 'res_1', tags: ['a'] });
    expect(fp1.hash).not.toBe(fp2.hash);
  });

  it('5. Numeric vs string types produce distinct fingerprints', () => {
    const fp1 = computeFingerprint('transfer_funds', { from: 'a', to: 'b', amount: 100 }, ['from', 'to', 'amount']);
    const fp2 = computeFingerprint('transfer_funds', { from: 'a', to: 'b', amount: '100' }, ['from', 'to', 'amount']);
    expect(fp1.hash).not.toBe(fp2.hash);
  });

  it('6. Unicode characters and emojis are preserved and hashed deterministically', () => {
    const fp1 = computeFingerprint('transfer_funds', { from: 'mehmet_ışık', to: 'ayşe_gül', amount: 50, note: '🚀 transfer' });
    const fp2 = computeFingerprint('transfer_funds', { note: '🚀 transfer', amount: 50, to: 'ayşe_gül', from: 'mehmet_ışık' });
    expect(fp1.hash).toBe(fp2.hash);
  });

  it('7. Whitespace differences produce distinct fingerprints', () => {
    const fp1 = computeFingerprint('transfer_funds', { from: 'acc_1', to: 'acc_2', amount: 100 }, ['from', 'to', 'amount']);
    const fp2 = computeFingerprint('transfer_funds', { from: 'acc_1 ', to: 'acc_2', amount: 100 }, ['from', 'to', 'amount']);
    expect(fp1.hash).not.toBe(fp2.hash);
  });

  it('8. Explicit idempotencyKey overrides argument fingerprinting', () => {
    const fp1 = computeFingerprint('transfer_funds', { from: 'acc_1', to: 'acc_2', amount: 100 }, ['from', 'to', 'amount'], 'custom_key_999');
    const fp2 = computeFingerprint('transfer_funds', { from: 'acc_99', to: 'acc_88', amount: 999 }, ['from', 'to', 'amount'], 'custom_key_999');
    expect(fp1.hash).toBe(fp2.hash);
  });

  it('9. Different tool names with identical arguments produce distinct fingerprints', () => {
    const fp1 = computeFingerprint('transfer_funds', { id: 100 });
    const fp2 = computeFingerprint('delete_funds', { id: 100 });
    expect(fp1.hash).not.toBe(fp2.hash);
  });

  it('10. Concurrent 2 simultaneous calls execute downstream exactly once', async () => {
    let downstreamCalls = 0;
    const mockExecutor = async (_name: string, _args: Record<string, unknown>) => {
      downstreamCalls++;
      // Simulate real I/O delay
      await new Promise(r => setTimeout(r, 50));
      return {
        content: [{ type: 'text', text: JSON.stringify({ transferId: 'tx_exec_1', status: 'SUCCESS' }) }],
        isError: false,
      };
    };

    const callParams = {
      toolName: 'transfer_funds',
      arguments: { from: 'acc_alice', to: 'acc_bob', amount: 1000 },
    };

    // Execute 2 concurrent calls simultaneously
    const [res1, res2] = await Promise.all([
      interceptor.handleToolCall(callParams, mockExecutor),
      interceptor.handleToolCall(callParams, mockExecutor),
    ]);

    expect(res1.isError).toBeFalsy();
    expect(res2.isError).toBeFalsy();
    expect(downstreamCalls).toBe(1);
  });

  it('11. Concurrent 10 simultaneous calls execute downstream exactly once', async () => {
    let downstreamCalls = 0;
    const mockExecutor = async (_name: string, _args: Record<string, unknown>) => {
      downstreamCalls++;
      await new Promise(r => setTimeout(r, 60));
      return {
        content: [{ type: 'text', text: JSON.stringify({ transferId: 'tx_exec_10', status: 'SUCCESS' }) }],
        isError: false,
      };
    };

    const callParams = {
      toolName: 'transfer_funds',
      arguments: { from: 'acc_alice_10', to: 'acc_bob_10', amount: 2500 },
    };

    const promises = Array.from({ length: 10 }, () =>
      interceptor.handleToolCall(callParams, mockExecutor)
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.isError).toBeFalsy();
    }
    expect(downstreamCalls).toBe(1);
  });

  it('12. Concurrent 25 simultaneous calls execute downstream exactly once', async () => {
    let downstreamCalls = 0;
    const mockExecutor = async (_name: string, _args: Record<string, unknown>) => {
      downstreamCalls++;
      await new Promise(r => setTimeout(r, 80));
      return {
        content: [{ type: 'text', text: JSON.stringify({ transferId: 'tx_exec_25', status: 'SUCCESS' }) }],
        isError: false,
      };
    };

    const callParams = {
      toolName: 'transfer_funds',
      arguments: { from: 'acc_alice_25', to: 'acc_bob_25', amount: 9999 },
    };

    const promises = Array.from({ length: 25 }, () =>
      interceptor.handleToolCall(callParams, mockExecutor)
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.isError).toBeFalsy();
    }
    expect(downstreamCalls).toBe(1);
  });
});
