/**
 * AgentTX Policy Manifest Types & Zod Schemas
 */

import { z } from 'zod';
import { ToolRiskLevel } from './transaction.js';

export const VerifierConfigSchema = z.object({
  toolName: z.string().min(1),
  argumentMapping: z.record(z.string(), z.string()).optional(),
  matchKeyPath: z.string().optional(),
  expectedValue: z.unknown().optional(),
});

export type VerifierConfig = z.infer<typeof VerifierConfigSchema>;

export const CompensatorConfigSchema = z.object({
  toolName: z.string().min(1),
  argumentMapping: z.record(z.string(), z.string()).optional(),
});

export type CompensatorConfig = z.infer<typeof CompensatorConfigSchema>;

export const ToolPolicySchema = z.object({
  toolName: z.string().min(1),
  riskLevel: z.enum(['READ_ONLY', 'IDEMPOTENT', 'MUTATING_SAFE', 'MUTATING_CRITICAL']),
  logicalKeys: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().default(15000),
  maxRetries: z.number().int().nonnegative().default(2),
  ttlSeconds: z.number().int().positive().default(86400 * 7), // 7 days retention
  sensitiveFields: z.array(z.string()).default([]),
  verifier: VerifierConfigSchema.optional(),
  compensator: CompensatorConfigSchema.optional(),
});

export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const AgentTXManifestSchema = z.object({
  version: z.string().default('1.0.0'),
  serverName: z.string().optional(),
  ledgerPath: z.string().default('.agenttx/agenttx.db'),
  defaultPolicy: z.object({
    timeoutMs: z.number().int().positive().default(15000),
    maxRetries: z.number().int().nonnegative().default(2),
    ttlSeconds: z.number().int().positive().default(86400 * 7),
  }).default({
    timeoutMs: 15000,
    maxRetries: 2,
    ttlSeconds: 86400 * 7,
  }),
  tools: z.record(z.string(), ToolPolicySchema).default({}),
});

export type AgentTXManifest = z.infer<typeof AgentTXManifestSchema>;
