import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { VerifierEngine } from '../src/verification/verifier-engine.js';

describe('PHASE 8: Verifier Engine Adversarial Tests', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let ledger: TransactionLedger;
  let verifierEngine: VerifierEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-phase8-'));
    ledgerPath = join(tmpDir, 'test-ledger.db');
    ledger = new TransactionLedger(ledgerPath);
    verifierEngine = new VerifierEngine(ledger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Exact path match with expected value returns PROVEN_COMMITTED', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_v1',
      toolName: 'book_flight',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { bookingId: 'bk_123' },
    });

    const res = await verifierEngine.verifyTransaction(
      tx.id,
      {
        toolName: 'check_booking',
        argumentMapping: { bookingId: 'bookingId' },
        matchKeyPath: 'status',
        expectedValue: 'CONFIRMED',
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ bookingId: 'bk_123', status: 'CONFIRMED' }) }],
        isError: false,
      })
    );

    expect(res.outcome).toBe('PROVEN_COMMITTED');
  });

  it('2. Value mismatch on declared key path returns PROVEN_ABSENT', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_v2',
      toolName: 'book_flight',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { bookingId: 'bk_123' },
    });

    const res = await verifierEngine.verifyTransaction(
      tx.id,
      {
        toolName: 'check_booking',
        matchKeyPath: 'status',
        expectedValue: 'CONFIRMED',
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ bookingId: 'bk_123', status: 'CANCELLED' }) }],
        isError: false,
      })
    );

    expect(res.outcome).toBe('PROVEN_ABSENT');
  });

  it('3. Missing key path on declared matchKeyPath does not produce PROVEN_COMMITTED', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_v3',
      toolName: 'book_flight',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { bookingId: 'bk_123' },
    });

    const res = await verifierEngine.verifyTransaction(
      tx.id,
      {
        toolName: 'check_booking',
        matchKeyPath: 'booking.nestedStatus',
        expectedValue: 'CONFIRMED',
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ otherField: 123 }) }],
        isError: false,
      })
    );

    expect(res.outcome).not.toBe('PROVEN_COMMITTED');
  });

  it('4. Attacker text containing "CONFIRMED" without structured JSON match does not produce PROVEN_COMMITTED', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_v4',
      toolName: 'book_flight',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { bookingId: 'bk_123' },
    });

    const res = await verifierEngine.verifyTransaction(
      tx.id,
      {
        toolName: 'check_booking',
        matchKeyPath: 'status',
        expectedValue: 'CONFIRMED',
      },
      async () => ({
        content: [{ type: 'text', text: 'Error 500: Database could not CONFIRMED booking because connection failed.' }],
        isError: false,
      })
    );

    expect(res.outcome).not.toBe('PROVEN_COMMITTED');
  });

  it('5. Thrown exception in verifier returns INCONCLUSIVE (never PROVEN_COMMITTED)', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_v5',
      toolName: 'book_flight',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { bookingId: 'bk_123' },
    });

    const res = await verifierEngine.verifyTransaction(
      tx.id,
      {
        toolName: 'check_booking',
        matchKeyPath: 'status',
        expectedValue: 'CONFIRMED',
      },
      async () => {
        throw new Error('Socket hang up / network timeout during verifier');
      }
    );

    expect(res.outcome).toBe('INCONCLUSIVE');
  });

  it('6. Empty or malformed response returns INCONCLUSIVE', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_v6',
      toolName: 'book_flight',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { bookingId: 'bk_123' },
    });

    const res = await verifierEngine.verifyTransaction(
      tx.id,
      {
        toolName: 'check_booking',
        matchKeyPath: 'status',
        expectedValue: 'CONFIRMED',
      },
      async () => ({
        content: [{ type: 'text', text: '' }],
        isError: false,
      })
    );

    expect(res.outcome).toBe('INCONCLUSIVE');
  });
});
