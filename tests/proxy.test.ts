import { describe, it, expect, beforeEach } from 'vitest';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { ManifestLoader } from '../src/manifest/manifest-loader.js';
import { MCPInterceptor } from '../src/proxy/mcp-interceptor.js';
import { VerifierEngine } from '../src/verification/verifier-engine.js';
import { AgentXManifest } from '../src/types/manifest.js';

describe('Transactional MCP Interceptor & Proxy Engine', () => {
  let ledger: TransactionLedger;
  let manifestLoader: ManifestLoader;
  let interceptor: MCPInterceptor;

  const testManifest: AgentXManifest = {
    version: '1.0.0',
    ledgerPath: ':memory:',
    defaultPolicy: {
      timeoutMs: 3000,
      maxRetries: 2,
      ttlSeconds: 3600,
    },
    tools: {
      get_user: {
        toolName: 'get_user',
        riskLevel: 'READ_ONLY',
        timeoutMs: 2000,
        maxRetries: 2,
        ttlSeconds: 3600,
        sensitiveFields: [],
      },
      create_payment: {
        toolName: 'create_payment',
        riskLevel: 'MUTATING_CRITICAL',
        logicalKeys: ['orderId', 'amount'],
        timeoutMs: 3000,
        maxRetries: 1,
        sensitiveFields: ['cardNumber'],
        verifier: {
          toolName: 'get_payment_status',
          argumentMapping: { orderId: 'orderId' },
          matchKeyPath: 'status',
          expectedValue: 'PAID',
        },
      },
      critical_unverified_action: {
        toolName: 'critical_unverified_action',
        riskLevel: 'MUTATING_CRITICAL',
        timeoutMs: 1000,
        maxRetries: 1,
        sensitiveFields: [],
      },
    },
  };

  beforeEach(() => {
    ledger = new TransactionLedger(':memory:');
    manifestLoader = new ManifestLoader(testManifest);
    const verifierEngine = new VerifierEngine(ledger);
    interceptor = new MCPInterceptor(ledger, manifestLoader, verifierEngine);
  });

  it('should passthrough READ_ONLY tools without creating ledger entries', async () => {
    let called = false;
    const mockExecutor = async (name: string) => {
      called = true;
      return { content: [{ type: 'text', text: `user: ${name}` }] };
    };

    const res = await interceptor.handleToolCall(
      { toolName: 'get_user', arguments: { userId: 'u_1' } },
      mockExecutor
    );

    expect(called).toBe(true);
    expect(res.content[0].text).toContain('user: get_user');
    expect(res._agentxReceipt).toBeUndefined();

    // Verify ledger has 0 records
    const all = ledger.listTransactions();
    expect(all.length).toBe(0);
  });

  it('should execute mutating call, record COMMITTED state and return receipt', async () => {
    let callCount = 0;
    const mockExecutor = async (name: string, args: Record<string, unknown>) => {
      callCount++;
      return {
        content: [{ type: 'text', text: JSON.stringify({ paymentId: 'pay_99', orderId: args.orderId, status: 'PAID' }) }],
      };
    };

    const res = await interceptor.handleToolCall(
      {
        toolName: 'create_payment',
        arguments: { orderId: 'ord_100', amount: 50, cardNumber: '4111-2222-3333-4444' },
      },
      mockExecutor
    );

    expect(callCount).toBe(1);
    expect(res._agentxReceipt).toBeDefined();
    expect(res._agentxReceipt?.state).toBe('COMMITTED');
    expect(res._agentxReceipt?.idempotentReplay).toBe(false);

    // Check PII redaction in receipt
    expect(res._agentxReceipt?.sanitizedArguments.cardNumber).toBe('[REDACTED]');
  });

  it('should intercept duplicate call and return cached receipt with zero duplicate downstream execution', async () => {
    let callCount = 0;
    const mockExecutor = async (name: string, args: Record<string, unknown>) => {
      callCount++;
      return {
        content: [{ type: 'text', text: JSON.stringify({ paymentId: 'pay_100', orderId: args.orderId }) }],
      };
    };

    // First call
    const res1 = await interceptor.handleToolCall(
      { toolName: 'create_payment', arguments: { orderId: 'ord_duplicate', amount: 75 } },
      mockExecutor
    );

    expect(callCount).toBe(1);
    expect(res1._agentxReceipt?.idempotentReplay).toBe(false);

    // Duplicate call with same logical keys
    const res2 = await interceptor.handleToolCall(
      { toolName: 'create_payment', arguments: { amount: 75, orderId: 'ord_duplicate' } },
      mockExecutor
    );

    // ZERO additional calls to executor
    expect(callCount).toBe(1);
    expect(res2._agentxReceipt?.idempotentReplay).toBe(true);
    expect(res2._agentxReceipt?.transactionId).toBe(res1._agentxReceipt?.transactionId);
  });

  it('should recover from network timeout via active postcondition verification', async () => {
    let callCount = 0;
    const mockExecutor = async (name: string, args: Record<string, unknown>) => {
      callCount++;
      if (name === 'create_payment') {
        // Simulates timeout / network drop
        throw new Error('Connection drop ETIMEDOUT');
      }
      if (name === 'get_payment_status') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ orderId: args.orderId, status: 'PAID' }) }],
        };
      }
      return { isError: true, content: [{ type: 'text', text: 'Unknown' }] };
    };

    const res = await interceptor.handleToolCall(
      { toolName: 'create_payment', arguments: { orderId: 'ord_flaky_1', amount: 150 } },
      mockExecutor
    );

    expect(res.isError).toBeFalsy();
    expect(callCount).toBe(2);
    expect(res._agentxReceipt?.state).toBe('COMMITTED');
    expect(res._agentxReceipt?.verificationEvidence).toBeDefined();
  });

  it('should fail-closed with UNKNOWN_STATE on timeout of unverified critical mutating tool', async () => {
    const mockExecutor = async () => {
      throw new Error('Timeout');
    };

    const res = await interceptor.handleToolCall(
      { toolName: 'critical_unverified_action', arguments: { data: 123 } },
      mockExecutor
    );

    expect(res.isError).toBe(true);
    expect(res._agentxReceipt?.state).toBe('UNKNOWN_STATE');
    expect(res.content[0].text).toContain('Fail-Closed');
  });
});
