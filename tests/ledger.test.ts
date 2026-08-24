import { describe, it, expect, beforeEach } from 'vitest';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';

describe('Durable Transaction Ledger (SQLite)', () => {
  let ledger: TransactionLedger;

  beforeEach(() => {
    ledger = new TransactionLedger(':memory:');
  });

  it('should create initial transaction in PENDING state with redacted arguments', () => {
    const tx = ledger.createTransaction({
      fingerprint: 'hash_abc123',
      toolName: 'book_appointment',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: {
        patientId: 'p1',
        password: 'secret_patient_password',
        note: 'routine visit',
      },
      sensitiveFields: ['password'],
    });

    expect(tx.id).toMatch(/^tx_/);
    expect(tx.state).toBe('PENDING');
    expect(tx.fingerprint).toBe('hash_abc123');
    expect(tx.toolName).toBe('book_appointment');

    const sanitized = JSON.parse(tx.sanitizedArguments);
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.patientId).toBe('p1');
  });

  it('should find transactions by primary ID and by fingerprint', () => {
    const created = ledger.createTransaction({
      fingerprint: 'unique_fp_999',
      toolName: 'pay_invoice',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { invoiceId: 'inv_1' },
    });

    const byId = ledger.getTransactionById(created.id);
    expect(byId).not.toBeNull();
    expect(byId?.id).toBe(created.id);

    const byFp = ledger.getTransactionByFingerprint('unique_fp_999');
    expect(byFp).not.toBeNull();
    expect(byFp?.id).toBe(created.id);
  });

  it('should update transaction state and record payloads', () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_state_test',
      toolName: 'update_user',
      riskLevel: 'MUTATING_SAFE',
      rawArguments: { userId: 'u1' },
    });

    ledger.updateTransactionState(tx.id, 'EXECUTING');
    let current = ledger.getTransactionById(tx.id);
    expect(current?.state).toBe('EXECUTING');

    ledger.updateTransactionState(tx.id, 'COMMITTED', {
      resultPayload: { success: true, updatedFields: ['email'] },
    });
    current = ledger.getTransactionById(tx.id);
    expect(current?.state).toBe('COMMITTED');
    expect(current?.resultPayload).toContain('updatedFields');
  });

  it('should record execution attempts with timings and errors', () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_attempt_test',
      toolName: 'send_email',
      riskLevel: 'MUTATING_SAFE',
      rawArguments: { to: 'user@example.com' },
    });

    ledger.recordAttempt({
      transactionId: tx.id,
      attemptNumber: 1,
      startedAt: new Date(Date.now() - 200).toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'TIMEOUT',
      durationMs: 200,
      errorMessage: 'ETIMEDOUT',
    });

    ledger.recordAttempt({
      transactionId: tx.id,
      attemptNumber: 2,
      startedAt: new Date(Date.now() - 50).toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'SUCCESS',
      durationMs: 50,
      responseSnippet: '{"delivered": true}',
    });

    const attempts = ledger.getAttemptsForTransaction(tx.id);
    expect(attempts.length).toBe(2);
    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].status).toBe('TIMEOUT');
    expect(attempts[1].attemptNumber).toBe(2);
    expect(attempts[1].status).toBe('SUCCESS');
  });

  it('should record postcondition verification history', () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_ver_test',
      toolName: 'create_slot',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { slotId: 's1' },
    });

    ledger.recordVerification({
      transactionId: tx.id,
      verifierTool: 'get_slot',
      verifiedAt: new Date().toISOString(),
      outcome: 'PROVEN_COMMITTED',
      evidence: { slotId: 's1', status: 'ACTIVE' },
      notes: 'Verified via external lookup',
    });

    const verifications = ledger.getVerificationsForTransaction(tx.id);
    expect(verifications.length).toBe(1);
    expect(verifications[0].verifierTool).toBe('get_slot');
    expect(verifications[0].outcome).toBe('PROVEN_COMMITTED');
    expect(verifications[0].evidence.status).toBe('ACTIVE');
  });

  it('should generate verifiable receipts with replay flag support', () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_receipt_test',
      toolName: 'charge_card',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { amount: 500 },
    });

    ledger.updateTransactionState(tx.id, 'COMMITTED', {
      resultPayload: { chargeId: 'ch_123' },
    });

    const receiptInitial = ledger.generateReceipt(tx.id, false);
    expect(receiptInitial.receiptId).toMatch(/^rcpt_/);
    expect(receiptInitial.transactionId).toBe(tx.id);
    expect(receiptInitial.idempotentReplay).toBe(false);

    const receiptReplay = ledger.generateReceipt(tx.id, true);
    expect(receiptReplay.idempotentReplay).toBe(true);
  });

  it('should list transactions with filters', () => {
    ledger.createTransaction({ fingerprint: 'fp_1', toolName: 't1', riskLevel: 'READ_ONLY', rawArguments: {} });
    const tx2 = ledger.createTransaction({ fingerprint: 'fp_2', toolName: 't2', riskLevel: 'MUTATING_SAFE', rawArguments: {} });
    ledger.updateTransactionState(tx2.id, 'COMMITTED');

    const all = ledger.listTransactions();
    expect(all.length).toBe(2);

    const committed = ledger.listTransactions({ state: 'COMMITTED' });
    expect(committed.length).toBe(1);
    expect(committed[0].fingerprint).toBe('fp_2');

    const t1Only = ledger.listTransactions({ toolName: 't1' });
    expect(t1Only.length).toBe(1);
    expect(t1Only[0].fingerprint).toBe('fp_1');
  });
});
