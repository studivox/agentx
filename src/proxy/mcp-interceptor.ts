/**
 * AgentX Transactional MCP Interceptor
 * Intercepts MCP tools/call requests, enforcing cross-process idempotency, ledgering, verification, and receipts.
 */

import { randomUUID } from 'node:crypto';
import { computeFingerprint } from '../fingerprint/canonicalizer.js';
import { TransactionLedger } from '../ledger/transaction-ledger.js';
import { ManifestLoader } from '../manifest/manifest-loader.js';
import { InterceptedToolCall, InterceptedToolResult } from '../types/protocol.js';
import { ToolExecutor, VerifierEngine } from '../verification/verifier-engine.js';
import { logger } from '../utils/logger.js';
import { TransactionRecord } from '../types/transaction.js';

export class MCPInterceptor {
  private ledger: TransactionLedger;
  private manifestLoader: ManifestLoader;
  private verifierEngine: VerifierEngine;
  private inFlight = new Map<string, Promise<InterceptedToolResult>>();
  private processId: string;

  constructor(
    ledger: TransactionLedger,
    manifestLoader: ManifestLoader,
    verifierEngine?: VerifierEngine
  ) {
    this.ledger = ledger;
    this.manifestLoader = manifestLoader;
    this.verifierEngine = verifierEngine || new VerifierEngine(ledger);
    this.processId = `pid_${process.pid}_${randomUUID().slice(0, 8)}`;
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

    // In-flight Deduplication Guard (intra-process):
    if (this.inFlight.has(fingerprint.hash)) {
      logger.info(`Deduplicating intra-process in-flight call for ${call.toolName} (Hash: ${fingerprint.hash})`);
      return await this.inFlight.get(fingerprint.hash)!;
    }

    const executionPromise = this.executeCoordinated(call, policy, fingerprint, executor);
    this.inFlight.set(fingerprint.hash, executionPromise);

    try {
      return await executionPromise;
    } finally {
      this.inFlight.delete(fingerprint.hash);
    }
  }

  private async executeCoordinated(
    call: InterceptedToolCall,
    policy: ReturnType<ManifestLoader['getPolicyForTool']>,
    fingerprint: ReturnType<typeof computeFingerprint>,
    executor: ToolExecutor
  ): Promise<InterceptedToolResult> {
    const timeoutMs = policy?.timeoutMs || 15000;
    const leaseDurationMs = Math.max(timeoutMs * 2, 6000);

    // Step 2: Atomically claim execution lease in durable SQLite ledger
    const claimResult = this.ledger.claimExecutionLease(
      {
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
      },
      this.processId,
      leaseDurationMs
    );

    const tx = claimResult.transaction;

    // Case A: Action was already COMMITTED previously (Idempotent hit)
    if (!claimResult.claimed && tx.state === 'COMMITTED' && !call.meta?.forceRefresh) {
      logger.info(`Idempotent hit for ${call.toolName} (Hash: ${fingerprint.hash}). Returning cached receipt.`);
      return this.buildCachedCommittedResult(tx);
    }

    // Case B: Action previously ended in UNKNOWN_STATE (Fail-closed)
    if (!claimResult.claimed && tx.state === 'UNKNOWN_STATE' && !call.meta?.forceRefresh) {
      logger.warn(`Blocked call for ${call.toolName}: previous transaction ${tx.id} is in UNKNOWN_STATE (fail-closed).`);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `[AgentX Fail-Closed] Previous invocation (${tx.id}) left external state in an UNKNOWN_STATE. Blind retries are blocked. Manual inspection or agentx status required.`,
          },
        ],
      };
    }

    // Case C: Another process or thread currently owns the active execution lease
    if (!claimResult.claimed && (tx.state === 'EXECUTING' || tx.state === 'PENDING' || tx.state === 'VERIFYING')) {
      logger.info(`Another process holds execution lease for transaction ${tx.id}. Awaiting cross-process resolution...`);
      return await this.awaitCrossProcessResolution(tx.id, policy, executor);
    }

    // Case D: This process successfully claimed the execution lease!
    return await this.executeClaimedTransaction(tx, call, policy, executor);
  }

  /**
   * Executes the transaction with timeout and retries under active lease ownership.
   */
  private async executeClaimedTransaction(
    tx: TransactionRecord,
    call: InterceptedToolCall,
    policy: ReturnType<ManifestLoader['getPolicyForTool']>,
    executor: ToolExecutor
  ): Promise<InterceptedToolResult> {
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
            _agentxReceipt: receipt,
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
          _agentxReceipt: receipt,
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
              _agentxReceipt: receipt,
              _agenttxReceipt: receipt,
            };
          }

          if (verifyResult.outcome === 'PROVEN_ABSENT') {
            logger.info(`Postcondition verification confirmed side-effect was NOT executed. Safe to proceed.`);
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
                text: `[AgentX Fail-Closed] Ambiguous outcome and inconclusive postcondition verification. Manual intervention required for transaction ${tx.id}.`,
              },
            ],
            _agentxReceipt: receipt,
            _agenttxReceipt: receipt,
          };
        }

        // No verifier available:
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
                text: `[AgentX Fail-Closed] Timeout on unverified critical mutating tool ${call.toolName}. Aborting retry to prevent duplicate side-effects. Transaction ID: ${tx.id}`,
              },
            ],
            _agentxReceipt: receipt,
            _agenttxReceipt: receipt,
          };
        }
      }
    }

    // Retries exhausted without resolution
    this.ledger.updateTransactionState(tx.id, 'UNKNOWN_STATE', {
      errorPayload: { error: lastError?.message || 'Retries exhausted' },
    });
    const receipt = this.ledger.generateReceipt(tx.id);

    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `[AgentX Fail-Closed] Retries exhausted for ${call.toolName}. State is UNKNOWN_STATE. Transaction ID: ${tx.id}`,
        },
      ],
      _agentxReceipt: receipt,
      _agenttxReceipt: receipt,
    };
  }

  /**
   * Polls SQLite ledger for transaction resolution when another process holds the lease.
   */
  private async awaitCrossProcessResolution(
    transactionId: string,
    policy: ReturnType<ManifestLoader['getPolicyForTool']>,
    executor: ToolExecutor
  ): Promise<InterceptedToolResult> {
    const maxWaitMs = policy.timeoutMs + 4000;
    const intervalMs = 25;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, intervalMs));
      const latestTx = this.ledger.getTransactionById(transactionId);
      if (!latestTx) break;

      if (latestTx.state === 'COMMITTED') {
        logger.info(`Cross-process resolution completed: transaction ${transactionId} COMMITTED.`);
        return this.buildCachedCommittedResult(latestTx);
      }

      if (latestTx.state === 'FAILED') {
        const receipt = this.ledger.generateReceipt(transactionId, true);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[AgentX] Transaction ${transactionId} failed downstream.`,
            },
          ],
          _agentxReceipt: receipt,
          _agenttxReceipt: receipt,
        };
      }

      if (latestTx.state === 'UNKNOWN_STATE') {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[AgentX Fail-Closed] Transaction ${transactionId} left in UNKNOWN_STATE by previous worker process.`,
            },
          ],
        };
      }

      // Check if previous worker's lease expired without resolution (crash condition)
      const now = Date.now();
      const leaseExpiry = latestTx.leaseExpiresAt ? new Date(latestTx.leaseExpiresAt).getTime() : 0;
      if (leaseExpiry > 0 && leaseExpiry < now) {
        logger.warn(`Execution lease for ${transactionId} expired. Worker process appears crashed.`);
        if (policy.verifier) {
          logger.info(`Executing verifier recovery for orphaned transaction ${transactionId}...`);
          const verifyResult = await this.verifierEngine.verifyTransaction(
            transactionId,
            policy.verifier,
            executor
          );
          if (verifyResult.outcome === 'PROVEN_COMMITTED') {
            return this.buildCachedCommittedResult(verifyResult.updatedTransaction);
          }
        }

        // Fail-closed if verifier absent or inconclusive
        this.ledger.updateTransactionState(transactionId, 'UNKNOWN_STATE', {
          errorPayload: { error: 'Worker lease expired without commitment' },
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[AgentX Fail-Closed] Worker process crashed or lease expired for transaction ${transactionId}.`,
            },
          ],
        };
      }
    }

    // Polling timeout exceeded
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `[AgentX Timeout] Awaiting cross-process transaction resolution exceeded ${maxWaitMs}ms for ${transactionId}.`,
        },
      ],
    };
  }

  private buildCachedCommittedResult(tx: TransactionRecord): InterceptedToolResult {
    const receipt = this.ledger.generateReceipt(tx.id, true);
    let parsedContent: InterceptedToolResult['content'] = [
      {
        type: 'text',
        text: `[AgentX] Action already committed previously. Receipt ID: ${receipt.receiptId}`,
      },
    ];

    if (tx.resultPayload) {
      try {
        const parsed = JSON.parse(tx.resultPayload);
        if (parsed && typeof parsed === 'object') {
          if (parsed.response && Array.isArray(parsed.response.content)) {
            parsedContent = parsed.response.content;
          } else if (Array.isArray(parsed.content)) {
            parsedContent = parsed.content;
          }
        }
      } catch {
        // Keep default fallback
      }
    }

    return {
      content: parsedContent,
      _agentxReceipt: receipt,
      _agenttxReceipt: receipt,
    };
  }
}
