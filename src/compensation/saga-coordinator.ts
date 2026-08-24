/**
 * AgentTX Saga Compensation Coordinator
 * Executes compensating actions to roll back partial side-effects and composite transactions.
 */

import { TransactionLedger } from '../ledger/transaction-ledger.js';
import { CompensatorConfig } from '../types/manifest.js';
import { CompensationRecord, TransactionRecord } from '../types/transaction.js';
import { ToolExecutor } from '../verification/verifier-engine.js';
import { logger } from '../utils/logger.js';

export interface CompensationResult {
  transactionId: string;
  compensatorTool: string;
  status: 'SUCCESS' | 'FAILURE';
  record: CompensationRecord;
  updatedTransaction: TransactionRecord;
}

export class SagaCoordinator {
  private ledger: TransactionLedger;

  constructor(ledger: TransactionLedger) {
    this.ledger = ledger;
  }

  /**
   * Constructs compensator arguments from mapping and transaction context.
   */
  public buildCompensatorArguments(
    compensatorConfig: CompensatorConfig,
    originalArgs: Record<string, unknown>,
    resultPayload?: Record<string, unknown>
  ): Record<string, unknown> {
    const compArgs: Record<string, unknown> = {};

    if (!compensatorConfig.argumentMapping || Object.keys(compensatorConfig.argumentMapping).length === 0) {
      return { ...originalArgs };
    }

    for (const [targetKey, sourcePath] of Object.entries(compensatorConfig.argumentMapping)) {
      if (sourcePath.startsWith('result.') && resultPayload) {
        const key = sourcePath.replace('result.', '');
        if (key in resultPayload) {
          compArgs[targetKey] = resultPayload[key];
        }
      } else if (sourcePath in originalArgs) {
        compArgs[targetKey] = originalArgs[sourcePath];
      }
    }

    return compArgs;
  }

  /**
   * Executes compensation for a single transaction.
   */
  public async compensateTransaction(
    transactionId: string,
    compensatorConfig: CompensatorConfig,
    executor: ToolExecutor
  ): Promise<CompensationResult> {
    const tx = this.ledger.getTransactionById(transactionId);
    if (!tx) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    this.ledger.updateTransactionState(transactionId, 'COMPENSATING');
    logger.info(`Executing compensation for transaction ${tx.id} using tool ${compensatorConfig.toolName}`);

    const originalArgs = JSON.parse(tx.rawArguments) as Record<string, unknown>;
    const resultPayload = tx.resultPayload ? (JSON.parse(tx.resultPayload) as Record<string, unknown>) : undefined;
    const compArgs = this.buildCompensatorArguments(compensatorConfig, originalArgs, resultPayload);
    const now = new Date().toISOString();

    let status: 'SUCCESS' | 'FAILURE' = 'FAILURE';
    let result: Record<string, unknown> | undefined;
    let errorMessage: string | undefined;

    try {
      const response = await executor(compensatorConfig.toolName, compArgs);
      if (response.isError) {
        status = 'FAILURE';
        errorMessage = 'Compensator tool returned error';
        result = { response };
      } else {
        status = 'SUCCESS';
        result = { response };
      }
    } catch (err: unknown) {
      status = 'FAILURE';
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const record = this.ledger.recordCompensation({
      transactionId: tx.id,
      compensatorTool: compensatorConfig.toolName,
      attemptedAt: now,
      status,
      result,
      errorMessage,
    });

    if (status === 'SUCCESS') {
      this.ledger.updateTransactionState(tx.id, 'COMPENSATED');
    } else {
      this.ledger.updateTransactionState(tx.id, 'UNKNOWN_STATE', {
        errorPayload: { reason: 'Compensation failed', error: errorMessage },
      });
    }

    const updatedTransaction = this.ledger.getTransactionById(tx.id)!;
    logger.info(`Compensation finished for ${tx.id}: status=${status}, finalState=${updatedTransaction.state}`);

    return {
      transactionId: tx.id,
      compensatorTool: compensatorConfig.toolName,
      status,
      record,
      updatedTransaction,
    };
  }

  /**
   * Executes reverse-order compensation for a composite multi-step transaction chain (Saga rollback).
   */
  public async rollbackSaga(
    transactions: Array<{ id: string; compensatorConfig: CompensatorConfig }>,
    executor: ToolExecutor
  ): Promise<CompensationResult[]> {
    logger.info(`Starting Saga rollback for ${transactions.length} step(s) in reverse (LIFO) order`);
    const results: CompensationResult[] = [];

    // Reverse order for LIFO compensation
    const reversed = [...transactions].reverse();

    for (const step of reversed) {
      const res = await this.compensateTransaction(step.id, step.compensatorConfig, executor);
      results.push(res);
      if (res.status === 'FAILURE') {
        logger.error(`Saga rollback failed at transaction ${step.id}. Aborting further automated rollback.`);
        break;
      }
    }

    return results;
  }
}
