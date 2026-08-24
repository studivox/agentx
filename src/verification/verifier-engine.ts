/**
 * AgentX Active Postcondition Verification Engine
 * Reconciles ambiguous states by querying external state via verifier tools.
 */

import { TransactionLedger } from '../ledger/transaction-ledger.js';
import { VerifierConfig } from '../types/manifest.js';
import { TransactionRecord, VerificationRecord } from '../types/transaction.js';
import { logger } from '../utils/logger.js';

export type ToolExecutor = (toolName: string, args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
}>;

export class VerifierEngine {
  private ledger: TransactionLedger;

  constructor(ledger: TransactionLedger) {
    this.ledger = ledger;
  }

  /**
   * Constructs verifier arguments based on policy argument mapping and original transaction args.
   */
  public buildVerifierArguments(
    verifierConfig: VerifierConfig,
    originalArgs: Record<string, unknown>,
    resultPayload?: Record<string, unknown>
  ): Record<string, unknown> {
    const verifierArgs: Record<string, unknown> = {};

    if (!verifierConfig.argumentMapping || Object.keys(verifierConfig.argumentMapping).length === 0) {
      return { ...originalArgs };
    }

    for (const [targetKey, sourcePath] of Object.entries(verifierConfig.argumentMapping)) {
      // Check if sourcePath is from result payload (e.g. "result.appointmentId")
      if (sourcePath.startsWith('result.') && resultPayload) {
        const key = sourcePath.replace('result.', '');
        if (key in resultPayload) {
          verifierArgs[targetKey] = resultPayload[key];
        }
      } else if (sourcePath in originalArgs) {
        verifierArgs[targetKey] = originalArgs[sourcePath];
      }
    }

    return verifierArgs;
  }

  /**
   * Reconciles an ambiguous transaction by executing its declared verifier tool.
   */
  public async verifyTransaction(
    transactionId: string,
    verifierConfig: VerifierConfig,
    executor: ToolExecutor
  ): Promise<{
    outcome: 'PROVEN_COMMITTED' | 'PROVEN_ABSENT' | 'INCONCLUSIVE';
    verification: VerificationRecord;
    updatedTransaction: TransactionRecord;
  }> {
    const tx = this.ledger.getTransactionById(transactionId);
    if (!tx) {
      throw new Error(`Transaction ${transactionId} not found in ledger`);
    }

    this.ledger.updateTransactionState(transactionId, 'VERIFYING');
    logger.info(`Starting postcondition verification for ${tx.id} using verifier ${verifierConfig.toolName}`);

    const originalArgs = JSON.parse(tx.rawArguments) as Record<string, unknown>;
    const resultPayload = tx.resultPayload ? (JSON.parse(tx.resultPayload) as Record<string, unknown>) : undefined;

    const verifierArgs = this.buildVerifierArguments(verifierConfig, originalArgs, resultPayload);
    const now = new Date().toISOString();

    let outcome: 'PROVEN_COMMITTED' | 'PROVEN_ABSENT' | 'INCONCLUSIVE' = 'INCONCLUSIVE';
    let evidence: Record<string, unknown> = {};
    let notes = '';

    try {
      const response = await executor(verifierConfig.toolName, verifierArgs);

      if (response.isError) {
        outcome = 'INCONCLUSIVE';
        notes = 'Verifier tool execution returned error';
        evidence = { response };
      } else {
        const textContent = response.content
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text)
          .join('\n');

        let parsedData: unknown = textContent;
        try {
          parsedData = JSON.parse(textContent);
        } catch {
          // Keep as string if not JSON
        }

        evidence = { verifierArgs, response: parsedData };

        if (verifierConfig.matchKeyPath && parsedData && typeof parsedData === 'object') {
          const actualValue = (parsedData as Record<string, unknown>)[verifierConfig.matchKeyPath];
          if (verifierConfig.expectedValue !== undefined) {
            if (actualValue === verifierConfig.expectedValue) {
              outcome = 'PROVEN_COMMITTED';
              notes = `Matched expected value for ${verifierConfig.matchKeyPath}`;
            } else {
              outcome = 'PROVEN_ABSENT';
              notes = `Value mismatch on ${verifierConfig.matchKeyPath}: expected ${verifierConfig.expectedValue}, found ${actualValue}`;
            }
          } else if (actualValue !== undefined && actualValue !== null) {
            outcome = 'PROVEN_COMMITTED';
            notes = `Key ${verifierConfig.matchKeyPath} found in external state`;
          } else {
            outcome = 'PROVEN_ABSENT';
            notes = `Key ${verifierConfig.matchKeyPath} absent in external state`;
          }
        } else if (textContent.toLowerCase().includes('not found') || textContent.toLowerCase().includes('does not exist')) {
          outcome = 'PROVEN_ABSENT';
          notes = 'Verifier output indicates entity does not exist';
        } else if (textContent.trim().length > 0) {
          outcome = 'PROVEN_COMMITTED';
          notes = 'Verifier returned positive entity representation';
        } else {
          outcome = 'INCONCLUSIVE';
          notes = 'Verifier output was empty';
        }
      }
    } catch (err: unknown) {
      outcome = 'INCONCLUSIVE';
      notes = `Verifier invocation threw exception: ${err instanceof Error ? err.message : String(err)}`;
      evidence = { error: notes };
    }

    const verification = this.ledger.recordVerification({
      transactionId: tx.id,
      verifierTool: verifierConfig.toolName,
      verifiedAt: now,
      outcome,
      evidence,
      notes,
    });

    let finalState = tx.state;
    if (outcome === 'PROVEN_COMMITTED') {
      finalState = 'COMMITTED';
      this.ledger.updateTransactionState(tx.id, 'COMMITTED', {
        resultPayload: evidence,
      });
      this.ledger.generateReceipt(tx.id);
    } else if (outcome === 'PROVEN_ABSENT') {
      finalState = 'FAILED';
      this.ledger.updateTransactionState(tx.id, 'FAILED', {
        errorPayload: { reason: 'State verified as absent / unexecuted', evidence },
      });
    } else {
      finalState = 'UNKNOWN_STATE';
      this.ledger.updateTransactionState(tx.id, 'UNKNOWN_STATE', {
        errorPayload: { reason: 'Postcondition verification inconclusive (fail-closed)', evidence },
      });
    }

    const updatedTransaction = this.ledger.getTransactionById(tx.id)!;
    logger.info(`Postcondition verification completed for ${tx.id}: outcome=${outcome}, state=${finalState}`);

    return {
      outcome,
      verification,
      updatedTransaction,
    };
  }
}
