/**
 * AgentX Protocol & Interceptor Types
 */

import { Receipt, TransactionRecord } from './transaction.js';
import { ToolPolicy } from './manifest.js';

export interface InterceptedToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  meta?: {
    txId?: string;
    idempotencyKey?: string;
    skipLedger?: boolean;
    forceRefresh?: boolean;
  };
}

export interface InterceptedToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
  _agentxReceipt?: Receipt;
  _agenttxReceipt?: Receipt;
}

export interface ProxyContext {
  manifestPolicy?: ToolPolicy;
  transaction?: TransactionRecord;
  fingerprint?: string;
  isReplay?: boolean;
}
