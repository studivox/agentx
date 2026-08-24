/**
 * AgentX Deterministic JSON Canonicalization and Logical Idempotency Fingerprinter
 */

import { createHash } from 'node:crypto';

export interface FingerprintResult {
  hash: string;
  toolName: string;
  canonicalPayload: string;
  extractedKeys: Record<string, unknown>;
  explicitIdempotencyKey?: string;
}

/**
 * Recursively sorts object keys alphabetically to produce deterministic JSON.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }

  if (typeof value === 'object') {
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();

    for (const key of keys) {
      const val = (value as Record<string, unknown>)[key];
      if (val !== undefined) {
        sortedObj[key] = canonicalizeValue(val);
      }
    }
    return sortedObj;
  }

  return String(value);
}

/**
 * Serializes canonicalized value to a compact, deterministic string.
 */
export function toCanonicalJSON(value: unknown): string {
  const canonical = canonicalizeValue(value);
  return JSON.stringify(canonical);
}

/**
 * Extracts declared logical keys from arguments.
 * If logicalKeys is empty/undefined, returns all arguments.
 */
export function extractLogicalPayload(
  args: Record<string, unknown>,
  logicalKeys?: string[]
): Record<string, unknown> {
  if (!logicalKeys || logicalKeys.length === 0) {
    return { ...args };
  }

  const extracted: Record<string, unknown> = {};
  for (const key of logicalKeys) {
    // Support nested dot notation like "customer.id"
    if (key.includes('.')) {
      const parts = key.split('.');
      let current: unknown = args;
      for (const part of parts) {
        if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
          current = (current as Record<string, unknown>)[part];
        } else {
          current = undefined;
          break;
        }
      }
      if (current !== undefined) {
        extracted[key] = current;
      }
    } else if (key in args) {
      extracted[key] = args[key];
    }
  }

  return extracted;
}

/**
 * Computes a deterministic SHA-256 hash for a tool invocation.
 */
export function computeFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  logicalKeys?: string[],
  explicitIdempotencyKey?: string
): FingerprintResult {
  const extractedKeys = extractLogicalPayload(args, logicalKeys);
  const canonicalPayload = toCanonicalJSON(extractedKeys);

  const hashInput = explicitIdempotencyKey
    ? `tx:${toolName}:custom:${explicitIdempotencyKey}:${canonicalPayload}`
    : `tx:${toolName}:auto:${canonicalPayload}`;

  const hash = createHash('sha256').update(hashInput, 'utf8').digest('hex');

  return {
    hash,
    toolName,
    canonicalPayload,
    extractedKeys,
    explicitIdempotencyKey,
  };
}
