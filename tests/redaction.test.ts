import { describe, it, expect } from 'vitest';
import { redactSensitiveData } from '../src/utils/redaction.js';

describe('Credential & Parameter Redaction', () => {
  it('should redact default sensitive keys (password, token, apiKey, secret)', () => {
    const input = {
      username: 'johndoe',
      password: 'supersecretpassword123',
      apiKey: 'ak_live_847291048',
      bearerToken: 'eyJhbGciOi...',
      clientSecret: 'shhh_secret',
      age: 30,
    };

    const redacted = redactSensitiveData(input);

    expect(redacted.username).toBe('johndoe');
    expect(redacted.age).toBe(30);
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.bearerToken).toBe('[REDACTED]');
    expect(redacted.clientSecret).toBe('[REDACTED]');
  });

  it('should recursively redact sensitive fields in nested objects and arrays', () => {
    const nested = {
      user: {
        id: 'u1',
        auth: {
          token: 'secret-token-value',
        },
      },
      transactions: [
        { id: 't1', creditCardNumber: '4111-2222-3333-4444' },
        { id: 't2', amount: 100 },
      ],
    };

    const redacted = redactSensitiveData(nested);

    expect(redacted.user.auth.token).toBe('[REDACTED]');
    expect(redacted.transactions[0].creditCardNumber).toBe('[REDACTED]');
    expect(redacted.transactions[1].amount).toBe(100);
  });

  it('should redact custom specified sensitive fields', () => {
    const input = {
      medicalHistory: 'confidential medical notes',
      phoneNumber: '+905551234567',
      status: 'ACTIVE',
    };

    const redacted = redactSensitiveData(input, ['medicalHistory', 'phoneNumber']);

    expect(redacted.medicalHistory).toBe('[REDACTED]');
    expect(redacted.phoneNumber).toBe('[REDACTED]');
    expect(redacted.status).toBe('ACTIVE');
  });
});
