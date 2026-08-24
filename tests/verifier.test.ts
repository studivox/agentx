import { describe, it, expect, beforeEach } from 'vitest';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { VerifierEngine } from '../src/verification/verifier-engine.js';
import { VerifierConfig } from '../src/types/manifest.js';

describe('Active Postcondition Verification Engine', () => {
  let ledger: TransactionLedger;
  let verifierEngine: VerifierEngine;

  beforeEach(() => {
    ledger = new TransactionLedger(':memory:');
    verifierEngine = new VerifierEngine(ledger);
  });

  it('should map arguments correctly based on verifier config', () => {
    const config: VerifierConfig = {
      toolName: 'get_booking',
      argumentMapping: {
        bookingId: 'result.bookingId',
        customerId: 'customerId',
      },
    };

    const originalArgs = { customerId: 'c_99', date: '2026-09-01' };
    const resultPayload = { bookingId: 'bk_123', status: 'CONFIRMED' };

    const mapped = verifierEngine.buildVerifierArguments(config, originalArgs, resultPayload);
    expect(mapped).toEqual({
      bookingId: 'bk_123',
      customerId: 'c_99',
    });
  });

  it('should prove COMMITTED when verifier returns expected match value', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_verify_committed',
      toolName: 'create_order',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { orderId: 'ord_123', total: 50 },
    });

    const verifierConfig: VerifierConfig = {
      toolName: 'get_order',
      argumentMapping: { orderId: 'orderId' },
      matchKeyPath: 'status',
      expectedValue: 'PAID',
    };

    const mockExecutor = async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('get_order');
      expect(args.orderId).toBe('ord_123');
      return {
        content: [{ type: 'text', text: JSON.stringify({ orderId: 'ord_123', status: 'PAID' }) }],
      };
    };

    const result = await verifierEngine.verifyTransaction(tx.id, verifierConfig, mockExecutor);

    expect(result.outcome).toBe('PROVEN_COMMITTED');
    expect(result.updatedTransaction.state).toBe('COMMITTED');

    const verifications = ledger.getVerificationsForTransaction(tx.id);
    expect(verifications.length).toBe(1);
    expect(verifications[0].outcome).toBe('PROVEN_COMMITTED');
  });

  it('should prove ABSENT when verifier returns not found response', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_verify_absent',
      toolName: 'create_order',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { orderId: 'ord_missing', total: 50 },
    });

    const verifierConfig: VerifierConfig = {
      toolName: 'get_order',
      argumentMapping: { orderId: 'orderId' },
    };

    const mockExecutor = async () => {
      return {
        content: [{ type: 'text', text: 'Error: Order not found' }],
      };
    };

    const result = await verifierEngine.verifyTransaction(tx.id, verifierConfig, mockExecutor);

    expect(result.outcome).toBe('PROVEN_ABSENT');
    expect(result.updatedTransaction.state).toBe('FAILED');
  });

  it('should fail-closed with UNKNOWN_STATE when verifier execution errors or is inconclusive', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_verify_inconclusive',
      toolName: 'transfer_funds',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { accountId: 'acc_1', amount: 1000 },
    });

    const verifierConfig: VerifierConfig = {
      toolName: 'get_transfer_status',
      argumentMapping: { accountId: 'accountId' },
    };

    const mockExecutor = async () => {
      throw new Error('Verifier server unreachable / connection refused');
    };

    const result = await verifierEngine.verifyTransaction(tx.id, verifierConfig, mockExecutor);

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.updatedTransaction.state).toBe('UNKNOWN_STATE');
  });
});
