import { describe, it, expect } from 'vitest';
import { AgentXManifestSchema } from '../src/types/manifest.js';
import { inferRiskLevel, createDefaultPolicy } from '../src/manifest/default-policies.js';

describe('PHASE 10: Manifest & Policy Fail-Closed Tests', () => {
  it('1. Rejects invalid risk level schema', () => {
    expect(() => {
      AgentXManifestSchema.parse({
        tools: {
          bad_tool: {
            toolName: 'bad_tool',
            riskLevel: 'SUPER_DANGEROUS_ALLOW_ALL',
          },
        },
      });
    }).toThrow();
  });

  it('2. Rejects negative or zero timeout', () => {
    expect(() => {
      AgentXManifestSchema.parse({
        tools: {
          tool_zero_timeout: {
            toolName: 'tool_zero_timeout',
            riskLevel: 'MUTATING_CRITICAL',
            timeoutMs: 0,
          },
        },
      });
    }).toThrow();

    expect(() => {
      AgentXManifestSchema.parse({
        tools: {
          tool_neg_timeout: {
            toolName: 'tool_neg_timeout',
            riskLevel: 'MUTATING_CRITICAL',
            timeoutMs: -500,
          },
        },
      });
    }).toThrow();
  });

  it('3. Rejects negative maxRetries', () => {
    expect(() => {
      AgentXManifestSchema.parse({
        tools: {
          tool_neg_retry: {
            toolName: 'tool_neg_retry',
            riskLevel: 'MUTATING_CRITICAL',
            maxRetries: -1,
          },
        },
      });
    }).toThrow();
  });

  it('4. Unconfigured tools default to MUTATING_CRITICAL (safe fail-closed posture)', () => {
    expect(inferRiskLevel('unknown_arbitrary_operation')).toBe('MUTATING_CRITICAL');
    expect(inferRiskLevel('charge_card')).toBe('MUTATING_CRITICAL');
    expect(inferRiskLevel('update_database')).toBe('MUTATING_CRITICAL');

    const defaultPolicy = createDefaultPolicy('execute_remote_command');
    expect(defaultPolicy.riskLevel).toBe('MUTATING_CRITICAL');
    expect(defaultPolicy.maxRetries).toBe(1); // Never multi-retry unverified mutating commands by default
  });

  it('5. Safe conventions are classified appropriately', () => {
    expect(inferRiskLevel('get_user_info')).toBe('READ_ONLY');
    expect(inferRiskLevel('list_items')).toBe('READ_ONLY');
    expect(inferRiskLevel('set_config')).toBe('IDEMPOTENT');
    expect(inferRiskLevel('delete_temp_file')).toBe('MUTATING_SAFE');
  });
});
