/**
 * AgentX Transactional Ledger Repository
 * Manages atomic transaction records, state transitions, attempts, verifications, and receipts.
 */

import { randomUUID } from 'node:crypto';
import { Database as DatabaseType } from 'better-sqlite3';
import { DatabaseManager } from './database.js';
import {
  AttemptRecord,
  CompensationRecord,
  Receipt,
  ToolRiskLevel,
  TransactionRecord,
  TransactionState,
  VerificationRecord,
} from '../types/transaction.js';
import { redactSensitiveData } from '../utils/redaction.js';

export interface CreateTransactionParams {
  fingerprint: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
  rawArguments: Record<string, unknown>;
  sensitiveFields?: string[];
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface ListTransactionsFilter {
  state?: TransactionState;
  toolName?: string;
  limit?: number;
  offset?: number;
}

export class TransactionLedger {
  private db: DatabaseType;

  constructor(dbOrManager: DatabaseType | DatabaseManager | string) {
    if (typeof dbOrManager === 'string') {
      const manager = new DatabaseManager(dbOrManager);
      this.db = manager.getDatabase();
    } else if ('getDatabase' in dbOrManager) {
      this.db = dbOrManager.getDatabase();
    } else {
      this.db = dbOrManager;
    }
  }

  /**
   * Registers an initial intent transaction in PENDING state.
   */
  public createTransaction(params: CreateTransactionParams): TransactionRecord {
    const now = new Date().toISOString();
    const id = `tx_${randomUUID().replace(/-/g, '')}`;
    const sanitized = redactSensitiveData(params.rawArguments, params.sensitiveFields);

    const ttl = params.ttlSeconds || 86400 * 7;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO transactions (
        id, fingerprint, tool_name, state, risk_level, created_at, updated_at, expires_at,
        raw_arguments, sanitized_arguments, metadata_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const sanitizedMeta = params.metadata ? redactSensitiveData(params.metadata, params.sensitiveFields) : null;

    try {
      stmt.run(
        id,
        params.fingerprint,
        params.toolName,
        'PENDING',
        params.riskLevel,
        now,
        now,
        expiresAt,
        JSON.stringify(sanitized),
        JSON.stringify(sanitized),
        sanitizedMeta ? JSON.stringify(sanitizedMeta) : null
      );

      return this.getTransactionById(id)!;
    } catch (err: any) {
      if (err && typeof err.message === 'string' && err.message.includes('UNIQUE constraint failed')) {
        const existing = this.getTransactionByFingerprint(params.fingerprint);
        if (existing) {
          return existing;
        }
      }
      throw err;
    }
  }

  /**
   * Retrieves a transaction by its primary key ID.
   */
  public getTransactionById(id: string): TransactionRecord | null {
    const stmt = this.db.prepare(`
      SELECT 
        id, fingerprint, tool_name as toolName, state, risk_level as riskLevel,
        created_at as createdAt, updated_at as updatedAt, expires_at as expiresAt,
        raw_arguments as rawArguments, sanitized_arguments as sanitizedArguments,
        result_payload as resultPayload, error_payload as errorPayload,
        receipt_json as receiptJson, metadata_json as metadataJson
      FROM transactions
      WHERE id = ?
    `);

    const row = stmt.get(id) as TransactionRecord | undefined;
    return row || null;
  }

  /**
   * Retrieves a transaction by its deterministic fingerprint.
   */
  public getTransactionByFingerprint(fingerprint: string): TransactionRecord | null {
    const stmt = this.db.prepare(`
      SELECT 
        id, fingerprint, tool_name as toolName, state, risk_level as riskLevel,
        created_at as createdAt, updated_at as updatedAt, expires_at as expiresAt,
        raw_arguments as rawArguments, sanitized_arguments as sanitizedArguments,
        result_payload as resultPayload, error_payload as errorPayload,
        receipt_json as receiptJson, metadata_json as metadataJson
      FROM transactions
      WHERE fingerprint = ?
    `);

    const row = stmt.get(fingerprint) as TransactionRecord | undefined;
    return row || null;
  }

  /**
   * Updates state and result/error payloads.
   */
  public updateTransactionState(
    id: string,
    state: TransactionState,
    extra?: {
      resultPayload?: Record<string, unknown>;
      errorPayload?: Record<string, unknown>;
      receipt?: Receipt;
    }
  ): TransactionRecord {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE transactions
      SET state = ?,
          updated_at = ?,
          result_payload = COALESCE(?, result_payload),
          error_payload = COALESCE(?, error_payload),
          receipt_json = COALESCE(?, receipt_json)
      WHERE id = ?
    `);

    const sanitizedResult = extra?.resultPayload ? redactSensitiveData(extra.resultPayload) : null;
    const sanitizedError = extra?.errorPayload ? redactSensitiveData(extra.errorPayload) : null;
    const sanitizedReceipt = extra?.receipt ? redactSensitiveData(extra.receipt) : null;

    stmt.run(
      state,
      now,
      sanitizedResult ? JSON.stringify(sanitizedResult) : null,
      sanitizedError ? JSON.stringify(sanitizedError) : null,
      sanitizedReceipt ? JSON.stringify(sanitizedReceipt) : null,
      id
    );

    return this.getTransactionById(id)!;
  }

  /**
   * Records a single execution attempt.
   */
  public recordAttempt(attempt: Omit<AttemptRecord, 'id'>): AttemptRecord {
    const id = `att_${randomUUID().replace(/-/g, '')}`;
    const stmt = this.db.prepare(`
      INSERT INTO attempts (
        id, transaction_id, attempt_number, started_at, finished_at,
        status, duration_ms, error_message, response_snippet
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    let sanitizedSnippet = attempt.responseSnippet;
    if (sanitizedSnippet) {
      try {
        sanitizedSnippet = JSON.stringify(redactSensitiveData(JSON.parse(sanitizedSnippet)));
      } catch {
        sanitizedSnippet = redactSensitiveData({ snippet: sanitizedSnippet }).snippet as string;
      }
    }

    stmt.run(
      id,
      attempt.transactionId,
      attempt.attemptNumber,
      attempt.startedAt,
      attempt.finishedAt || null,
      attempt.status,
      attempt.durationMs || null,
      attempt.errorMessage || null,
      sanitizedSnippet || null
    );

    return {
      id,
      ...attempt,
    };
  }

  /**
   * Fetches attempt history for a transaction.
   */
  public getAttemptsForTransaction(transactionId: string): AttemptRecord[] {
    const stmt = this.db.prepare(`
      SELECT 
        id, transaction_id as transactionId, attempt_number as attemptNumber,
        started_at as startedAt, finished_at as finishedAt, status,
        duration_ms as durationMs, error_message as errorMessage,
        response_snippet as responseSnippet
      FROM attempts
      WHERE transaction_id = ?
      ORDER BY attempt_number ASC
    `);

    return stmt.all(transactionId) as AttemptRecord[];
  }

  /**
   * Records a postcondition verification attempt.
   */
  public recordVerification(verification: Omit<VerificationRecord, 'id'>): VerificationRecord {
    const id = `ver_${randomUUID().replace(/-/g, '')}`;
    const stmt = this.db.prepare(`
      INSERT INTO verifications (
        id, transaction_id, verifier_tool, verified_at, outcome, evidence_json, notes
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const sanitizedEvidence = redactSensitiveData(verification.evidence);

    stmt.run(
      id,
      verification.transactionId,
      verification.verifierTool,
      verification.verifiedAt,
      verification.outcome,
      JSON.stringify(sanitizedEvidence),
      verification.notes || null
    );

    return {
      id,
      ...verification,
    };
  }

  /**
   * Retrieves verification records for a transaction.
   */
  public getVerificationsForTransaction(transactionId: string): VerificationRecord[] {
    const stmt = this.db.prepare(`
      SELECT 
        id, transaction_id as transactionId, verifier_tool as verifierTool,
        verified_at as verifiedAt, outcome, evidence_json as evidenceJson, notes
      FROM verifications
      WHERE transaction_id = ?
      ORDER BY verified_at ASC
    `);

    const rows = stmt.all(transactionId) as Array<{
      id: string;
      transactionId: string;
      verifierTool: string;
      verifiedAt: string;
      outcome: 'PROVEN_COMMITTED' | 'PROVEN_ABSENT' | 'INCONCLUSIVE';
      evidenceJson: string;
      notes?: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      transactionId: r.transactionId,
      verifierTool: r.verifierTool,
      verifiedAt: r.verifiedAt,
      outcome: r.outcome,
      evidence: JSON.parse(r.evidenceJson),
      notes: r.notes,
    }));
  }

  /**
   * Records a compensation execution.
   */
  public recordCompensation(compensation: Omit<CompensationRecord, 'id'>): CompensationRecord {
    const id = `comp_${randomUUID().replace(/-/g, '')}`;
    const stmt = this.db.prepare(`
      INSERT INTO compensations (
        id, transaction_id, compensator_tool, attempted_at, status, result_json, error_message
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const sanitizedResult = compensation.result ? redactSensitiveData(compensation.result) : null;

    stmt.run(
      id,
      compensation.transactionId,
      compensation.compensatorTool,
      compensation.attemptedAt,
      compensation.status,
      sanitizedResult ? JSON.stringify(sanitizedResult) : null,
      compensation.errorMessage || null
    );

    return {
      id,
      ...compensation,
    };
  }

  /**
   * Retrieves compensation records for a transaction.
   */
  public getCompensationsForTransaction(transactionId: string): CompensationRecord[] {
    const stmt = this.db.prepare(`
      SELECT 
        id, transaction_id as transactionId, compensator_tool as compensatorTool,
        attempted_at as attemptedAt, status, result_json as resultJson,
        error_message as errorMessage
      FROM compensations
      WHERE transaction_id = ?
      ORDER BY attempted_at ASC
    `);

    const rows = stmt.all(transactionId) as Array<{
      id: string;
      transactionId: string;
      compensatorTool: string;
      attemptedAt: string;
      status: 'SUCCESS' | 'FAILURE';
      resultJson?: string;
      errorMessage?: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      transactionId: r.transactionId,
      compensatorTool: r.compensatorTool,
      attemptedAt: r.attemptedAt,
      status: r.status,
      result: r.resultJson ? JSON.parse(r.resultJson) : undefined,
      errorMessage: r.errorMessage,
    }));
  }

  /**
   * Generates an evidence-backed JSON receipt for a transaction.
   */
  public generateReceipt(transactionId: string, isReplay = false): Receipt {
    const tx = this.getTransactionById(transactionId);
    if (!tx) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    const attempts = this.getAttemptsForTransaction(transactionId);
    const verifications = this.getVerificationsForTransaction(transactionId);
    const compensations = this.getCompensationsForTransaction(transactionId);

    const latestVerification = verifications.length > 0 ? verifications[verifications.length - 1] : undefined;
    const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;

    const receipt: Receipt = {
      receiptId: `rcpt_${randomUUID().replace(/-/g, '')}`,
      transactionId: tx.id,
      fingerprint: tx.fingerprint,
      toolName: tx.toolName,
      state: tx.state,
      riskLevel: tx.riskLevel,
      idempotentReplay: isReplay,
      createdAt: tx.createdAt,
      committedAt: tx.state === 'COMMITTED' ? (tx.updatedAt || tx.createdAt) : undefined,
      sanitizedArguments: JSON.parse(tx.sanitizedArguments),
      result: tx.resultPayload ? JSON.parse(tx.resultPayload) : undefined,
      attemptsCount: attempts.length,
      verificationEvidence: latestVerification?.evidence,
      compensationHistory: compensations.length > 0 ? compensations : undefined,
    };

    return receipt;
  }

  /**
   * Lists transactions with optional state and tool filters.
   */
  public listTransactions(filter: ListTransactionsFilter = {}): TransactionRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.state) {
      conditions.push('state = ?');
      params.push(filter.state);
    }

    if (filter.toolName) {
      conditions.push('tool_name = ?');
      params.push(filter.toolName);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = `LIMIT ${filter.limit || 50} OFFSET ${filter.offset || 0}`;

    const stmt = this.db.prepare(`
      SELECT 
        id, fingerprint, tool_name as toolName, state, risk_level as riskLevel,
        created_at as createdAt, updated_at as updatedAt, expires_at as expiresAt,
        raw_arguments as rawArguments, sanitized_arguments as sanitizedArguments,
        result_payload as resultPayload, error_payload as errorPayload,
        receipt_json as receiptJson, metadata_json as metadataJson
      FROM transactions
      ${whereClause}
      ORDER BY created_at DESC
      ${limitClause}
    `);

    return stmt.all(...params) as TransactionRecord[];
  }
}
