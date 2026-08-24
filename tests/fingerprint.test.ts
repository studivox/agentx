import { describe, it, expect } from 'vitest';
import {
  canonicalizeValue,
  toCanonicalJSON,
  extractLogicalPayload,
  computeFingerprint,
} from '../src/fingerprint/canonicalizer.js';

describe('Deterministic Canonicalization & Fingerprinting', () => {
  it('should canonicalize object keys in alphabetical order', () => {
    const objA = { z: 1, a: 2, m: { y: 'nested', b: 10 } };
    const objB = { a: 2, m: { b: 10, y: 'nested' }, z: 1 };

    const canonA = toCanonicalJSON(objA);
    const canonB = toCanonicalJSON(objB);

    expect(canonA).toEqual(canonB);
    expect(canonA).toBe('{"a":2,"m":{"b":10,"y":"nested"},"z":1}');
  });

  it('should handle primitives, null, and arrays consistently', () => {
    expect(toCanonicalJSON(null)).toBe('null');
    expect(toCanonicalJSON(undefined)).toBe('null');
    expect(toCanonicalJSON(42)).toBe('42');
    expect(toCanonicalJSON('hello')).toBe('"hello"');
    expect(toCanonicalJSON([3, 1, 2])).toBe('[3,1,2]'); // Array order preserved
  });

  it('should extract declared logical keys only', () => {
    const args = {
      patientId: 'p123',
      doctorId: 'd456',
      date: '2026-09-01',
      slot: '10:00',
      clientNonce: 'random-12345',
      userNote: 'Feeling unwell',
    };

    const logicalKeys = ['patientId', 'doctorId', 'date', 'slot'];
    const extracted = extractLogicalPayload(args, logicalKeys);

    expect(extracted).toEqual({
      patientId: 'p123',
      doctorId: 'd456',
      date: '2026-09-01',
      slot: '10:00',
    });
    expect(extracted).not.toHaveProperty('clientNonce');
    expect(extracted).not.toHaveProperty('userNote');
  });

  it('should extract nested dot-notation keys', () => {
    const args = {
      user: { id: 'usr_99', profile: { name: 'Alice' } },
      orderId: 'ord_123',
    };

    const extracted = extractLogicalPayload(args, ['user.id', 'orderId']);
    expect(extracted).toEqual({
      'user.id': 'usr_99',
      orderId: 'ord_123',
    });
  });

  it('should compute identical hash for differently ordered equivalent arguments', () => {
    const call1 = {
      toolName: 'book_appointment',
      args: { patientId: 'p1', date: '2026-09-01', slot: '14:00', doctorId: 'd1' },
      logicalKeys: ['patientId', 'doctorId', 'date', 'slot'],
    };

    const call2 = {
      toolName: 'book_appointment',
      args: { slot: '14:00', doctorId: 'd1', patientId: 'p1', date: '2026-09-01' },
      logicalKeys: ['patientId', 'doctorId', 'date', 'slot'],
    };

    const fp1 = computeFingerprint(call1.toolName, call1.args, call1.logicalKeys);
    const fp2 = computeFingerprint(call2.toolName, call2.args, call2.logicalKeys);

    expect(fp1.hash).toBe(fp2.hash);
    expect(fp1.canonicalPayload).toBe(fp2.canonicalPayload);
  });

  it('should include explicit idempotency key in hash calculation', () => {
    const toolName = 'process_payment';
    const args = { customerId: 'c1', amount: 100 };

    const fpAuto = computeFingerprint(toolName, args);
    const fpCustom1 = computeFingerprint(toolName, args, undefined, 'idemp-key-1');
    const fpCustom2 = computeFingerprint(toolName, args, undefined, 'idemp-key-2');

    expect(fpAuto.hash).not.toBe(fpCustom1.hash);
    expect(fpCustom1.hash).not.toBe(fpCustom2.hash);
  });
});
