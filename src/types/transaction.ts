/**
 * AgentTX Transaction Types & State Machine Definitions
 */

export type TransactionState =
  | 'PENDING'       // Intent registered in durable ledger
  | 'EXECUTING'     // Forwarded to downstream MCP server
  | 'COMMITTED'     // Successfully executed and receipt recorded
  | 'AMBIGUOUS'     // Timeout, connection drop, or crash during flight
  | 'VERIFYING'     // Postcondition inspection in progress
  | 'COMPENSATING'  // Saga compensation tool in execution
  | 'COMPENSATED'   // Successfully compensated / rolled back
  | 'FAILED'        // Definitive failure / rejected without side-effect
  | 'UNKNOWN_STATE'; // Fail-closed state when postcondition cannot be proven

export type ToolRiskLevel =
  | 'READ_ONLY'         // No side-effects, passthrough
  | 'IDEMPOTENT'        // Side-effects are natively idempotent
  | 'MUTATING_SAFE'     // Side-effects with known compensating actions
  | 'MUTATING_CRITICAL'; // Irreversible side-effects or sensitive financial mutations

export interface AttemptRecord {
  id: string;
  transactionId: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt?: string;
  status: 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'DISCONNECTED';
  durationMs?: number;
  errorMessage?: string;
  responseSnippet?: string;
}

export interface VerificationRecord {
  id: string;
  transactionId: string;
  verifierTool: string;
  verifiedAt: string;
  outcome: 'PROVEN_COMMITTED' | 'PROVEN_ABSENT' | 'INCONCLUSIVE';
  evidence: Record<string, unknown>;
  notes?: string;
}

export interface CompensationRecord {
  id: string;
  transactionId: string;
  compensatorTool: string;
  attemptedAt: string;
  status: 'SUCCESS' | 'FAILURE';
  result?: Record<string, unknown>;
  errorMessage?: string;
}

export interface Receipt {
  receiptId: string;
  transactionId: string;
  fingerprint: string;
  toolName: string;
  state: TransactionState;
  riskLevel: ToolRiskLevel;
  idempotentReplay: boolean;
  createdAt: string;
  committedAt?: string;
  sanitizedArguments: Record<string, unknown>;
  result?: Record<string, unknown>;
  attemptsCount: number;
  verificationEvidence?: Record<string, unknown>;
  compensationHistory?: CompensationRecord[];
}

export interface TransactionRecord {
  id: string;
  fingerprint: string;
  toolName: string;
  state: TransactionState;
  riskLevel: ToolRiskLevel;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  rawArguments: string; // JSON string
  sanitizedArguments: string; // JSON string with secrets redacted
  resultPayload?: string; // JSON string
  errorPayload?: string; // JSON string
  receiptJson?: string; // JSON string of full receipt
  metadataJson?: string; // JSON string of runtime metadata
}
