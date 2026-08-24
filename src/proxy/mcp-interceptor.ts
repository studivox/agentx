/**
 * AgentTX Transactional MCP Interceptor
 * Intercepts MCP tools/call requests, enforcing idempotency, ledgering, verification, and receipts.
 */

import { computeFingerprint } from '../fingerprint/canonicalizer.js';
import { TransactionLedger } from '../ledger/transaction-ledger.js';
import { ManifestLoader } from '../manifest/manifest-loader.js';
import { InterceptedToolCall, InterceptedToolResult } from '../types/protocol.js';
import { ToolExecutor, VerifierEngine } from '../verification/verifier-engine.js';
import { logger } from '../utils/logger.js';

export class MCPInterceptor {
  private ledger: TransactionLedger;
  private manifestLoader: ManifestLoader;
  private verifierEngine: VerifierEngine;

  constructor(
    ledger: TransactionLedger,
    manifestLoader: ManifestLoader,
    verifierEngine?: VerifierEngine
  ) {
    this.ledger = ledger;
    this.manifestLoader = manifestLoader;
    this.verifierEngine = verifierEngine || new VerifierEngine(ledger);
  }

  /**
   * Main transactional interception entry point for MCP tool invocations.
   */
  public async handleToolCall(
    call: InterceptedToolCall,
    executor: ToolExecutor
  ): Promise<InterceptedToolResult> {
    const policy = this.manifestLoader.getPolicyForTool(call.toolName);
    logger.debug(`Intercepting tool call: ${call.toolName} (Risk: ${policy.riskLevel})`);

    // Fast-path: Read-only tools bypass the transactional ledger unless explicitly overridden
    if (policy.riskLevel === 'READ_ONLY' && !call.meta?.idempotencyKey && !call.meta?.forceRefresh) {
      logger.debug(`Passthrough read-only tool: ${call.toolName}`);
      const rawRes = await executor(call.toolName, call.arguments);
      return {
        content: rawRes.content as InterceptedToolResult['content'],
        isError: rawRes.isError,
      };
    }

    // Step 1: Compute deterministic logical fingerprint
    const fingerprint = computeFingerprint(
      call.toolName,
      call.arguments,
      policy.logicalKeys,
      call.meta?.idempotencyKey
    );

    logger.debug(`Computed fingerprint for ${call.toolName}: ${fingerprint.hash}`);

    // Step 2: Check ledger for existing transaction (Idempotency deduplication)
    const existingTx = this.ledger.getTransactionByFingerprint(fingerprint.hash);

    if (existingTx && !call.meta?.forceRefresh) {
      if (existingTx.state === 'COMMITTED') {
        logger.info(`Idempotent hit for ${call.toolName} (Hash: ${fingerprint.hash}). Returning cached receipt.`);
        const receipt = this.ledger.generateReceipt(existingTx.id, true);

        return {
          content: [
            {
              type: 'text',
              text: existingTx.resultPayload
                ? JSON.stringify(JSON.parse(existingTx.resultPayload))
                : `[AgentTX] Action already committed previously. Receipt ID: ${receipt.receiptId}`,
            },
          ],
          _agenttxReceipt: receipt,
        };
      }

      if (existingTx.state === 'UNKNOWN_STATE') {
        logger.warn(`Blocked call for ${call.toolName}: previous transaction ${existingTx.id} is in UNKNOWN_STATE (fail-closed).`);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[AgentTX Fail-Closed] Previous invocation (${existingTx.id}) left external state in an UNKNOWN_STATE. Blind retries are blocked. Manual inspection or agenttx verify required.`,
            },
          ],
        };
      }
    }

    // Step 3: Register intent in PENDING state
    const tx = existingTx || this.ledger.createTransaction({
      fingerprint: fingerprint.hash,
      toolName: call.toolName,
      riskLevel: policy.riskLevel,
      rawArguments: call.arguments,
      sensitiveFields: policy.sensitiveFields,
      ttlSeconds: policy.ttlSeconds,
      metadata: {
        explicitKey: call.meta?.idempotencyKey,
        callerMeta: call.meta,
      },
    });

    this.ledger.updateTransactionState(tx.id, 'EXECUTING');

    // Step 4: Execution attempt loop with timeout and verification
    const maxRetries = Math.max(1, policy.maxRetries || 1);
    let attemptNumber = 0;
    let lastError: Error | null = null;

    while (attemptNumber < maxRetries) {
      attemptNumber++;
      const startTime = Date.now();
      const startedAt = new Date(startTime).toISOString();

      logger.info(`Executing ${call.toolName} (Attempt ${attemptNumber}/${maxRetries}) for transaction ${tx.id}`);

      try {
        // Execute with timeout promise race
        const responsePromise = executor(call.toolName, call.arguments);
        const timeoutPromise = new Promise<{ isError: true; content: Array<{ type: 'text'; text: string }> }>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${policy.timeoutMs}ms`)), policy.timeoutMs)
        );

        const response = await Promise.race([responsePromise, timeoutPromise]);
        const durationMs = Date.now() - startTime;
        const finishedAt = new Date().toISOString();

        if (response.isError) {
          this.ledger.recordAttempt({
            transactionId: tx.id,
            attemptNumber,
            startedAt,
            finishedAt,
            status: 'FAILURE',
            durationMs,
            errorMessage: 'Downstream returned isError=true',
            responseSnippet: JSON.stringify(response.content),
          });

          this.ledger.updateTransactionState(tx.id, 'FAILED', {
            errorPayload: { response },
          });

          const receipt = this.ledger.generateReceipt(tx.id);
          return {
            content: response.content as InterceptedToolResult['content'],
            isError: true,
            _agenttxReceipt: receipt,
          };
        }

        // Execution succeeded! Record COMMITTED state
        this.ledger.recordAttempt({
          transactionId: tx.id,
          attemptNumber,
          startedAt,
          finishedAt,
          status: 'SUCCESS',
          durationMs,
          responseSnippet: JSON.stringify(response.content),
        });

        this.ledger.updateTransactionState(tx.id, 'COMMITTED', {
          resultPayload: { response },
        });

        const receipt = this.ledger.generateReceipt(tx.id);
        logger.info(`Transaction ${tx.id} committed successfully.`);

        return {
          content: response.content as InterceptedToolResult['content'],
          _agenttxReceipt: receipt,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const durationMs = Date.now() - startTime;
        const finishedAt = new Date().toISOString();

        this.ledger.recordAttempt({
          transactionId: tx.id,
          attemptNumber,
          startedAt,
          finishedAt,
          status: 'TIMEOUT',
          durationMs,
          errorMessage: lastError.message,
        });

        logger.warn(`Attempt ${attemptNumber} for ${tx.id} failed with error: ${lastError.message}`);

        // If postcondition verifier is declared, inspect real external state before retrying!
        if (policy.verifier) {
          this.ledger.updateTransactionState(tx.id, 'AMBIGUOUS');
          const verifyResult = await this.verifierEngine.verifyTransaction(
            tx.id,
            policy.verifier,
            executor
          );

          if (verifyResult.outcome === 'PROVEN_COMMITTED') {
            logger.info(`Postcondition verification proved ${tx.id} was already COMMITTED!`);
            const receipt = this.ledger.generateReceipt(tx.id);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(verifyResult.verification.evidence),
                },
              ],
              _agenttxReceipt: receipt,
            };
          }

          if (verifyResult.outcome === 'PROVEN_ABSENT') {
            logger.info(`Postcondition verification confirmed side-effect was NOT executed. Safe to proceed.`);
            // Safe to proceed to next loop iteration if retries remaining
            continue;
          }

          // Inconclusive verification -> Fail-closed!
          logger.error(`Postcondition verification inconclusive for ${tx.id}. Failing closed.`);
          const receipt = this.ledger.generateReceipt(tx.id);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `[AgentTX Fail-Closed] Ambiguous outcome and inconclusive postcondition verification. Manual intervention required for transaction ${tx.id}.`,
              },
            ],
            _agenttxReceipt: receipt,
          };
        }

        // No verifier available:
        // For mutating critical tools, never blind retry on timeout/disconnect!
        if (policy.riskLevel === 'MUTATING_CRITICAL') {
          logger.error(`Mutating critical tool ${call.toolName} experienced ambiguous failure without a verifier. Failing closed to prevent duplicate side effects.`);
          this.ledger.updateTransactionState(tx.id, 'UNKNOWN_STATE', {
            errorPayload: { error: lastError.message },
          });
          const receipt = this.ledger.generateReceipt(tx.id);
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `[AgentTX Fail-Closed] Timeout on unverified critical mutating tool ${call.toolName}. Aborting retry to prevent duplicate side-effects. Transaction ID: ${tx.id}`,
              },
            ],
            _agenttxReceipt: receipt,
          };
        }
      }
    }

    // Retries exhausted
    this.ledger.updateTransactionState(tx.id, 'FAILED', {
      errorPayload: { error: lastError?.message || 'Retries exhausted' },
    });
    const receipt = this.ledger.generateReceipt(tx.id);

    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `[AgentTX] Execution failed after ${maxRetries} attempt(s): ${lastError?.message || 'Unknown error'}`,
        },
      ],
      _agenttxReceipt: receipt,
    };
  }
}
