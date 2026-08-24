/**
 * AgentX Policy Manifest Loader & Validator
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentXManifest, AgentXManifestSchema, ToolPolicy } from '../types/manifest.js';
import { createDefaultPolicy } from './default-policies.js';
import { logger } from '../utils/logger.js';

export class ManifestLoader {
  private manifest: AgentXManifest;

  constructor(customManifest?: AgentXManifest) {
    this.manifest = customManifest || {
      version: '1.0.0',
      ledgerPath: process.env.AGENTX_DB_PATH || '.agentx/agentx.db',
      defaultPolicy: {
        timeoutMs: 15000,
        maxRetries: 2,
        ttlSeconds: 86400 * 7,
      },
      tools: {},
    };
  }

  /**
   * Loads a manifest file from disk or looks for standard config filenames.
   */
  public static loadFromFile(configPath?: string): ManifestLoader {
    let resolvedPath = configPath || process.env.AGENTX_CONFIG;

    if (!resolvedPath) {
      const candidates = [
        'agentx.config.json',
        'agentx.json',
        '.agentx/config.json',
        'agenttx.config.json',
        'agenttx.json',
        '.agenttx/config.json',
      ];
      for (const cand of candidates) {
        const full = resolve(process.cwd(), cand);
        if (existsSync(full)) {
          resolvedPath = full;
          break;
        }
      }
    }

    if (!resolvedPath || !existsSync(resolvedPath)) {
      logger.info('No custom AgentX manifest found; using dynamic safety defaults.');
      return new ManifestLoader();
    }

    try {
      const raw = readFileSync(resolvedPath, 'utf8');
      const json = JSON.parse(raw);
      const parsed = AgentXManifestSchema.parse(json);
      logger.info(`Loaded AgentX manifest from ${resolvedPath}`);
      return new ManifestLoader(parsed);
    } catch (err) {
      logger.error(`Error loading manifest from ${resolvedPath}:`, err);
      throw new Error(`Invalid AgentX manifest at ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public getManifest(): AgentXManifest {
    return this.manifest;
  }

  public getLedgerPath(): string {
    return this.manifest.ledgerPath || process.env.AGENTX_DB_PATH || '.agentx/agentx.db';
  }

  public getPolicyForTool(toolName: string): ToolPolicy {
    if (this.manifest.tools && this.manifest.tools[toolName]) {
      return this.manifest.tools[toolName];
    }

    return createDefaultPolicy(toolName, {
      timeoutMs: this.manifest.defaultPolicy?.timeoutMs || 15000,
      maxRetries: this.manifest.defaultPolicy?.maxRetries ?? 2,
      ttlSeconds: this.manifest.defaultPolicy?.ttlSeconds || 86400 * 7,
    });
  }
}
