/**
 * AgentX Parameter & Credential Redaction Engine
 * Prevents secrets, tokens, passwords, and PII from being logged or stored in receipts or ledgers.
 */

const DEFAULT_SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /bearer/i,
  /credit[_-]?card/i,
  /card[_-]?number/i,
  /cvv/i,
  /cvc/i,
  /private[_-]?key/i,
  /ssn/i,
  /pin/i,
  /patient[_-]?phone/i,
  /medical[_-]?note/i,
];

export function redactSensitiveData<T>(
  data: T,
  customSensitiveFields: string[] = []
): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    const trimmed = data.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return JSON.stringify(redactSensitiveData(parsed, customSensitiveFields)) as unknown as T;
        }
      } catch {
        // Return original string if not valid JSON
      }
    }
    return data as T;
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
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') {
            result[key] = JSON.stringify(redactSensitiveData(parsed, customSensitiveFields));
            continue;
          }
        } catch {
          // Keep raw string
        }
      }
      result[key] = value;
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
