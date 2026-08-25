import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { ManifestLoader } from '../src/manifest/manifest-loader.js';
import { MCPInterceptor } from '../src/proxy/mcp-interceptor.js';

describe('PHASE 7: Receipt Integrity & Honest Claims', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let ledger: TransactionLedger;
  let manifestLoader: ManifestLoader;
  let interceptor: MCPInterceptor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-phase7-'));
    ledgerPath = join(tmpDir, 'test-ledger.db');
    ledger = new TransactionLedger(ledgerPath);
    manifestLoader = new ManifestLoader({
      version: '0.1.0',
      ledgerPath,
      tools: {
        payment_tool: {
          toolName: 'payment_tool',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['orderId'],
          sensitiveFields: ['cardNumber', 'cvv'],
        },
      },
    });
    interceptor = new MCPInterceptor(ledger, manifestLoader);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Generates unique receipt IDs linked to deterministic fingerprint and transaction ID', async () => {
    const res = await interceptor.handleToolCall(
      { toolName: 'payment_tool', arguments: { orderId: 'ord_701', amount: 100, cardNumber: '4111-2222', cvv: '123' } },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ charged: true }) }],
        isError: false,
      })
    );

    const receipt = res._agentxReceipt!;
    expect(receipt).toBeDefined();
    expect(receipt.receiptId).toMatch(/^rcpt_[a-f0-9]{32}$/);
    expect(receipt.transactionId).toMatch(/^tx_[a-f0-9]{32}$/);
    expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.state).toBe('COMMITTED');
    expect(receipt.riskLevel).toBe('MUTATING_CRITICAL');
    expect(receipt.idempotentReplay).toBe(false);
    expect(receipt.sanitizedArguments).toEqual({ orderId: 'ord_701', amount: 100, cardNumber: '[REDACTED]', cvv: '[REDACTED]' });
  });

  it('2. Receipts do not claim cryptographic signatures or tamper-proof guarantees', async () => {
    const res = await interceptor.handleToolCall(
      { toolName: 'payment_tool', arguments: { orderId: 'ord_702', amount: 200 } },
      async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })
    );

    const receipt = res._agentxReceipt as any;
    expect(receipt.signature).toBeUndefined();
    expect(receipt.jwt).toBeUndefined();
    expect(receipt.publicKey).toBeUndefined();
  });
});
