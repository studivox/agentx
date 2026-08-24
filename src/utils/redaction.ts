/**
 * AgentTX Parameter & Credential Redaction Engine
 * Prevents secrets, tokens, passwords, and PII from being logged or stored in receipts.
 */

const DEFAULT_SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /bearer/i,
  /credit[_-]?card/i,
  /cvv/i,
  /private[_-]?key/i,
  /ssn/i,
];

export function redactSensitiveData<T>(
  data: T,
  customSensitiveFields: string[] = []
): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => redactSensitiveData(item, customSensitiveFields)) as unknown as T;
  }

  const customSet = new Set(customSensitiveFields.map(f => f.toLowerCase()));
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    const isCustomMatch = customSet.has(lowerKey);
    const isPatternMatch = DEFAULT_SENSITIVE_KEY_PATTERNS.some(p => p.test(key));

    if (value !== null && typeof value === 'object') {
      // Recurse into child objects/arrays
      result[key] = redactSensitiveData(value, customSensitiveFields);
    } else if (isCustomMatch || isPatternMatch) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
