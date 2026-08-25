import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';

describe('PHASE 12: CLI & Process Lifecycle Tests', () => {
  let tmpDir: string;
  let dbPath: string;
  let manifestPath: string;
  let ledger: TransactionLedger;
  const cliPath = join(process.cwd(), 'dist/cli.js');

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentx-phase12-'));
    dbPath = join(tmpDir, 'test-cli.db');
    manifestPath = join(tmpDir, 'test-manifest.json');
    ledger = new TransactionLedger(dbPath);

    const manifest = {
      version: '0.1.0',
      ledgerPath: dbPath,
      tools: {
        ping: {
          toolName: 'ping',
          riskLevel: 'READ_ONLY',
        },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. agentx --help displays command description and subcommands', () => {
    const out = execSync(`node ${cliPath} --help`, { encoding: 'utf-8' });
    expect(out).toContain('Usage: agentx');
    expect(out).toContain('wrap');
    expect(out).toContain('list');
    expect(out).toContain('status');
    expect(out).toContain('receipt');
    expect(out).toContain('doctor');
  });

  it('2. agentx doctor validates manifest and database health', () => {
    const out = execSync(`node ${cliPath} doctor --manifest ${manifestPath} --db ${dbPath}`, { encoding: 'utf-8' });
    expect(out).toContain('=== AgentX System Doctor ===');
    expect(out).toContain('[✓] Policy Manifest: Valid');
    expect(out).toContain('[✓] SQLite Ledger: Online');
  });

  it('3. agentx list and list --json output structured transaction tables or JSON arrays', () => {
    // Insert a test transaction into ledger
    const tx = ledger.createTransaction({
      fingerprint: 'fp_cli_test_1',
      toolName: 'ping',
      riskLevel: 'READ_ONLY',
      rawArguments: { target: '127.0.0.1' },
    });
    ledger.updateTransactionState(tx.id, 'COMMITTED');

    const textOut = execSync(`node ${cliPath} list --db ${dbPath}`, { encoding: 'utf-8' });
    expect(textOut).toContain('=== AgentX Transaction Ledger ===');
    expect(textOut).toContain(tx.id);

    const jsonOut = execSync(`node ${cliPath} list --json --db ${dbPath}`, { encoding: 'utf-8' });
    const parsed = JSON.parse(jsonOut);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].id).toBe(tx.id);
  });
});
