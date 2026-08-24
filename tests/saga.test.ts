import { describe, it, expect, beforeEach } from 'vitest';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { SagaCoordinator } from '../src/compensation/saga-coordinator.js';
import { CompensatorConfig } from '../src/types/manifest.js';

describe('Saga Compensation Coordinator', () => {
  let ledger: TransactionLedger;
  let sagaCoordinator: SagaCoordinator;

  beforeEach(() => {
    ledger = new TransactionLedger(':memory:');
    sagaCoordinator = new SagaCoordinator(ledger);
  });

  it('should compensate a single transaction successfully', async () => {
    const tx = ledger.createTransaction({
      fingerprint: 'fp_saga_single',
      toolName: 'book_hotel',
      riskLevel: 'MUTATING_SAFE',
      rawArguments: { hotelId: 'h1', roomType: 'deluxe' },
    });

    ledger.updateTransactionState(tx.id, 'COMMITTED', {
      resultPayload: { reservationId: 'res_777' },
    });

    const compConfig: CompensatorConfig = {
      toolName: 'cancel_hotel',
      argumentMapping: {
        reservationId: 'result.reservationId',
      },
    };

    let executedTool = '';
    let executedArgs: Record<string, unknown> = {};

    const mockExecutor = async (name: string, args: Record<string, unknown>) => {
      executedTool = name;
      executedArgs = args;
      return {
        content: [{ type: 'text', text: JSON.stringify({ cancelled: true, reservationId: args.reservationId }) }],
      };
    };

    const res = await sagaCoordinator.compensateTransaction(tx.id, compConfig, mockExecutor);

    expect(res.status).toBe('SUCCESS');
    expect(executedTool).toBe('cancel_hotel');
    expect(executedArgs).toEqual({ reservationId: 'res_777' });
    expect(res.updatedTransaction.state).toBe('COMPENSATED');

    const history = ledger.getCompensationsForTransaction(tx.id);
    expect(history.length).toBe(1);
    expect(history[0].status).toBe('SUCCESS');
  });

  it('should execute multi-step Saga rollback in LIFO reverse order', async () => {
    const tx1 = ledger.createTransaction({
      fingerprint: 'fp_step_1',
      toolName: 'reserve_flight',
      riskLevel: 'MUTATING_SAFE',
      rawArguments: { flightNo: 'TK1984' },
    });
    ledger.updateTransactionState(tx1.id, 'COMMITTED', { resultPayload: { ticketId: 't_1' } });

    const tx2 = ledger.createTransaction({
      fingerprint: 'fp_step_2',
      toolName: 'book_hotel',
      riskLevel: 'MUTATING_SAFE',
      rawArguments: { hotelId: 'h_1' },
    });
    ledger.updateTransactionState(tx2.id, 'COMMITTED', { resultPayload: { hotelBookingId: 'hb_2' } });

    const executionOrder: string[] = [];
    const mockExecutor = async (name: string) => {
      executionOrder.push(name);
      return { content: [{ type: 'text', text: 'OK' }] };
    };

    const steps = [
      {
        id: tx1.id,
        compensatorConfig: { toolName: 'cancel_flight', argumentMapping: { ticketId: 'result.ticketId' } },
      },
      {
        id: tx2.id,
        compensatorConfig: { toolName: 'cancel_hotel', argumentMapping: { hotelBookingId: 'result.hotelBookingId' } },
      },
    ];

    const results = await sagaCoordinator.rollbackSaga(steps, mockExecutor);

    expect(results.length).toBe(2);
    // Verified LIFO order: step 2 (hotel) compensated BEFORE step 1 (flight)
    expect(executionOrder).toEqual(['cancel_hotel', 'cancel_flight']);
  });
});
