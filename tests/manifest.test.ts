import { describe, it, expect } from 'vitest';
import { inferRiskLevel, createDefaultPolicy } from '../src/manifest/default-policies.js';
import { AgentTXManifestSchema } from '../src/types/manifest.js';
import { ManifestLoader } from '../src/manifest/manifest-loader.js';

describe('Manifest Schema & Default Policies', () => {
  it('should infer risk level correctly from prefix semantics', () => {
    expect(inferRiskLevel('get_appointment')).toBe('READ_ONLY');
    expect(inferRiskLevel('list_users')).toBe('READ_ONLY');
    expect(inferRiskLevel('search_products')).toBe('READ_ONLY');

    expect(inferRiskLevel('set_status')).toBe('IDEMPOTENT');
    expect(inferRiskLevel('upsert_record')).toBe('IDEMPOTENT');

    expect(inferRiskLevel('delete_draft')).toBe('MUTATING_SAFE');
    expect(inferRiskLevel('cancel_order')).toBe('MUTATING_SAFE');

    expect(inferRiskLevel('book_ticket')).toBe('MUTATING_CRITICAL');
    expect(inferRiskLevel('process_payment')).toBe('MUTATING_CRITICAL');
    expect(inferRiskLevel('custom_operation')).toBe('MUTATING_CRITICAL');
  });

  it('should generate valid default policy for unconfigured tools', () => {
    const policy = createDefaultPolicy('get_order');
    expect(policy.toolName).toBe('get_order');
    expect(policy.riskLevel).toBe('READ_ONLY');
    expect(policy.timeoutMs).toBe(15000);
    expect(policy.maxRetries).toBe(3);
  });

  it('should validate full manifest schema with Zod', () => {
    const raw = {
      version: '1.0.0',
      serverName: 'test-server',
      defaultPolicy: {
        timeoutMs: 10000,
        maxRetries: 3,
        ttlSeconds: 86400,
      },
      tools: {
        pay: {
          toolName: 'pay',
          riskLevel: 'MUTATING_CRITICAL',
          logicalKeys: ['orderId'],
          timeoutMs: 5000,
          maxRetries: 1,
          sensitiveFields: ['cvv'],
          verifier: {
            toolName: 'check_pay',
            argumentMapping: { id: 'orderId' },
          },
        },
      },
    };

    const parsed = AgentTXManifestSchema.parse(raw);
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.tools.pay.riskLevel).toBe('MUTATING_CRITICAL');
    expect(parsed.tools.pay.verifier?.toolName).toBe('check_pay');
  });

  it('should fallback gracefully when no manifest file exists', () => {
    const loader = new ManifestLoader();
    const policy = loader.getPolicyForTool('unknown_tool');
    expect(policy.toolName).toBe('unknown_tool');
    expect(policy.riskLevel).toBe('MUTATING_CRITICAL');
  });
});
