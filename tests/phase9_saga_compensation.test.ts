import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { SagaCoordinator } from '../src/compensation/saga-coordinator.js';

describe('PHASE 9: Saga & Compensation Tests', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let ledger: TransactionLedger;
  let sagaCoordinator: SagaCoordinator;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-phase9-'));
    ledgerPath = join(tmpDir, 'test-ledger.db');
    ledger = new TransactionLedger(ledgerPath);
    sagaCoordinator = new SagaCoordinator(ledger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Single compensation succeeds and updates state to COMPENSATED', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_saga_1',
      toolName: 'book_hotel',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { hotelId: 'h_101', nights: 2 },
    });
    ledger.updateTransactionState(tx.id, 'COMMITTED', {
      resultPayload: { response: { content: [{ type: 'text', text: JSON.stringify({ reservationId: 'res_99' }) }] } },
    });

    const res = await sagaCoordinator.compensateTransaction(
      tx.id,
      { toolName: 'cancel_hotel', argumentMapping: { reservationId: 'result.reservationId' } },
      async (tool, args) => {
        expect(tool).toBe('cancel_hotel');
        expect(args.reservationId).toBe('res_99');
        return { content: [{ type: 'text', text: JSON.stringify({ cancelled: true }) }], isError: false };
      }
    );

    expect(res.status).toBe('SUCCESS');
    expect(res.updatedTransaction.state).toBe('COMPENSATED');
  });

  it('2. Multi-step Saga rollback executes in strict reverse LIFO order', async () => {
    const tx1 = ledger.createTransaction({ fingerprint: 'fp_s1', toolName: 'step1', riskLevel: 'MUTATING_CRITICAL', rawArguments: { step: 1 } });
    ledger.updateTransactionState(tx1.id, 'COMMITTED');

    const tx2 = ledger.createTransaction({ fingerprint: 'fp_s2', toolName: 'step2', riskLevel: 'MUTATING_CRITICAL', rawArguments: { step: 2 } });
    ledger.updateTransactionState(tx2.id, 'COMMITTED');

    const tx3 = ledger.createTransaction({ fingerprint: 'fp_s3', toolName: 'step3', riskLevel: 'MUTATING_CRITICAL', rawArguments: { step: 3 } });
    ledger.updateTransactionState(tx3.id, 'COMMITTED');

    const executionOrder: string[] = [];
    const steps = [
      { id: tx1.id, compensatorConfig: { toolName: 'undo_step1' } },
      { id: tx2.id, compensatorConfig: { toolName: 'undo_step2' } },
      { id: tx3.id, compensatorConfig: { toolName: 'undo_step3' } },
    ];

    await sagaCoordinator.rollbackSaga(steps, async (tool) => {
      executionOrder.push(tool);
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });

    expect(executionOrder).toEqual(['undo_step3', 'undo_step2', 'undo_step1']);
  });

  it('3. Multi-step Saga aborts subsequent rollbacks when intermediate compensation fails', async () => {
    const tx1 = ledger.createTransaction({ fingerprint: 'fp_sa1', toolName: 's1', riskLevel: 'MUTATING_CRITICAL', rawArguments: {} });
    ledger.updateTransactionState(tx1.id, 'COMMITTED');

    const tx2 = ledger.createTransaction({ fingerprint: 'fp_sa2', toolName: 's2', riskLevel: 'MUTATING_CRITICAL', rawArguments: {} });
    ledger.updateTransactionState(tx2.id, 'COMMITTED');

    const executionOrder: string[] = [];
    const steps = [
      { id: tx1.id, compensatorConfig: { toolName: 'undo_s1' } },
      { id: tx2.id, compensatorConfig: { toolName: 'undo_s2' } },
    ];

    const results = await sagaCoordinator.rollbackSaga(steps, async (tool) => {
      executionOrder.push(tool);
      if (tool === 'undo_s2') {
        return { isError: true, content: [{ type: 'text', text: 'Undo failed' }] };
      }
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });

    expect(executionOrder).toEqual(['undo_s2']);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe('FAILURE');
  });
});
