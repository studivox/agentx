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

function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

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
      if (sourcePath.startsWith('result.') && resultPayload) {
        const key = sourcePath.replace('result.', '');
        if (key in resultPayload) {
          verifierArgs[targetKey] = resultPayload[key];
        } else if (resultPayload.response && typeof resultPayload.response === 'object' && key in (resultPayload.response as Record<string, unknown>)) {
          verifierArgs[targetKey] = (resultPayload.response as Record<string, unknown>)[key];
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

    const originalArgs = JSON.parse(tx.sanitizedArguments) as Record<string, unknown>;
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

        let parsedData: unknown = null;
        let isJson = false;
        try {
          parsedData = JSON.parse(textContent);
          isJson = true;
        } catch {
          parsedData = textContent;
        }

        evidence = { verifierArgs, response: parsedData };

        if (verifierConfig.matchKeyPath) {
          if (!isJson || typeof parsedData !== 'object' || parsedData === null) {
            outcome = 'INCONCLUSIVE';
            notes = `Declared matchKeyPath ${verifierConfig.matchKeyPath} requires structured JSON response`;
          } else {
            const actualValue = getNestedValue(parsedData, verifierConfig.matchKeyPath);
            if (verifierConfig.expectedValue !== undefined) {
              if (actualValue === verifierConfig.expectedValue) {
                outcome = 'PROVEN_COMMITTED';
                notes = `Matched expected value for ${verifierConfig.matchKeyPath}`;
              } else if (actualValue !== undefined) {
                outcome = 'PROVEN_ABSENT';
                notes = `Value mismatch on ${verifierConfig.matchKeyPath}: expected ${verifierConfig.expectedValue}, found ${actualValue}`;
              } else {
                outcome = 'PROVEN_ABSENT';
                notes = `Key path ${verifierConfig.matchKeyPath} absent in response`;
              }
            } else if (actualValue !== undefined && actualValue !== null) {
              outcome = 'PROVEN_COMMITTED';
              notes = `Key ${verifierConfig.matchKeyPath} found in external state`;
            } else {
              outcome = 'PROVEN_ABSENT';
              notes = `Key ${verifierConfig.matchKeyPath} absent in external state`;
            }
          }
        } else if (textContent.toLowerCase().includes('not found') || textContent.toLowerCase().includes('does not exist')) {
          outcome = 'PROVEN_ABSENT';
          notes = 'Verifier output indicates entity does not exist';
        } else if (isJson && parsedData && typeof parsedData === 'object') {
          outcome = 'PROVEN_COMMITTED';
          notes = 'Verifier returned valid structured entity representation';
        } else if (textContent.toLowerCase().includes('error') || textContent.toLowerCase().includes('fail') || textContent.trim().length === 0) {
          outcome = 'INCONCLUSIVE';
          notes = 'Verifier output was inconclusive or contained error text';
        } else {
          outcome = 'INCONCLUSIVE';
          notes = 'Verifier output was unstructured and inconclusive';
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
        resultPayload: { verified: true, evidence },
      });
    } else if (outcome === 'PROVEN_ABSENT') {
      finalState = 'FAILED';
      this.ledger.updateTransactionState(tx.id, 'FAILED', {
        errorPayload: { verifiedAbsent: true, notes },
      });
    } else {
      finalState = 'UNKNOWN_STATE';
      this.ledger.updateTransactionState(tx.id, 'UNKNOWN_STATE', {
        errorPayload: { inconclusive: true, notes },
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
