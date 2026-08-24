/**
 * AgentX Default Policy Rules & Dynamic Tool Classification
 */

import { ToolPolicy } from '../types/manifest.js';
import { ToolRiskLevel } from '../types/transaction.js';

const READ_ONLY_PREFIXES = ['get_', 'list_', 'read_', 'search_', 'fetch_', 'find_', 'check_', 'inspect_', 'describe_', 'query_'];
const IDEMPOTENT_PREFIXES = ['set_', 'put_', 'ensure_', 'upsert_', 'sync_'];
const MUTATING_SAFE_PREFIXES = ['delete_', 'remove_', 'cancel_', 'archive_'];

/**
 * Infers risk level for an unconfigured tool based on conventional naming semantics.
 */
export function inferRiskLevel(toolName: string): ToolRiskLevel {
  const lower = toolName.toLowerCase();

  if (READ_ONLY_PREFIXES.some(p => lower.startsWith(p))) {
    return 'READ_ONLY';
  }

  if (IDEMPOTENT_PREFIXES.some(p => lower.startsWith(p))) {
    return 'IDEMPOTENT';
  }

  if (MUTATING_SAFE_PREFIXES.some(p => lower.startsWith(p))) {
    return 'MUTATING_SAFE';
  }

  // Default for unknown or mutating operations is critical to prevent unintended duplicate side-effects
  return 'MUTATING_CRITICAL';
}

/**
 * Generates a default policy for a tool name.
 */
export function createDefaultPolicy(toolName: string, overrides?: Partial<ToolPolicy>): ToolPolicy {
  const riskLevel = inferRiskLevel(toolName);

  return {
    toolName,
    riskLevel,
    timeoutMs: 15000,
    maxRetries: riskLevel === 'READ_ONLY' ? 3 : 1,
    ttlSeconds: 86400 * 7,
    sensitiveFields: [],
    ...overrides,
  };
}
