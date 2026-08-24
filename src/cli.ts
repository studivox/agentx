#!/usr/bin/env node
/**
 * AgentX Command Line Interface (CLI)
 */

import { Command } from 'commander';
import { TransactionLedger } from './ledger/transaction-ledger.js';
import { StdioProxy } from './proxy/stdio-proxy.js';
import { ManifestLoader } from './manifest/manifest-loader.js';
import { setLogLevelFromName } from './utils/logger.js';
import { TransactionState } from './types/transaction.js';

const program = new Command();

const DEFAULT_DB_PATH = process.env.AGENTX_DB_PATH || '.agentx/agentx.db';

program
  .name('agentx')
  .description('Local-first transactional reliability layer and proxy for MCP tools')
  .version('1.0.0');

// 1. PROXY / WRAP COMMAND
program
  .command('proxy')
  .alias('wrap')
  .description('Start the AgentX transparent transactional proxy wrapping an MCP server command')
  .requiredOption('-s, --server <command...>', 'Downstream MCP server command and arguments')
  .option('-m, --manifest <path>', 'Path to custom AgentX manifest (agentx.config.json)', process.env.AGENTX_CONFIG)
  .option('-d, --db <path>', 'Path to SQLite ledger database', DEFAULT_DB_PATH)
  .option('-l, --log-level <level>', 'Diagnostic log level (DEBUG, INFO, WARN, ERROR, SILENT)', process.env.AGENTX_LOG_LEVEL || 'INFO')
  .action(async (opts) => {
    setLogLevelFromName(opts.logLevel);

    const [cmd, ...args] = opts.server;
    const proxy = new StdioProxy({
      command: cmd,
      args,
      manifestPath: opts.manifest,
      ledgerPath: opts.db,
    });

    await proxy.start();
  });

// 2. LIST TRANSACTIONS COMMAND
program
  .command('list')
  .description('List recent transactions in the durable ledger')
  .option('-s, --state <state>', 'Filter by state (PENDING, EXECUTING, COMMITTED, AMBIGUOUS, UNKNOWN_STATE, FAILED)')
  .option('-t, --tool <name>', 'Filter by tool name')
  .option('-n, --limit <number>', 'Number of records to display', '20')
  .option('-d, --db <path>', 'Path to SQLite ledger database', DEFAULT_DB_PATH)
  .option('--json', 'Output results as JSON')
  .action((opts) => {
    const ledger = new TransactionLedger(opts.db);
    const filter = {
      state: opts.state as TransactionState | undefined,
      toolName: opts.tool,
      limit: parseInt(opts.limit, 10),
    };

    const transactions = ledger.listTransactions(filter);

    if (opts.json) {
      process.stdout.write(JSON.stringify(transactions, null, 2) + '\n');
      return;
    }

    if (transactions.length === 0) {
      process.stdout.write('No transactions found matching filter criteria.\n');
      return;
    }

    process.stdout.write('\n=== AgentX Transaction Ledger ===\n\n');
    process.stdout.write(
      `${'ID'.padEnd(26)} | ${'TOOL'.padEnd(20)} | ${'STATE'.padEnd(14)} | ${'RISK'.padEnd(16)} | ${'CREATED AT'}\n`
    );
    process.stdout.write('-'.repeat(95) + '\n');

    for (const tx of transactions) {
      process.stdout.write(
        `${tx.id.padEnd(26)} | ${tx.toolName.padEnd(20)} | ${tx.state.padEnd(14)} | ${tx.riskLevel.padEnd(16)} | ${tx.createdAt}\n`
      );
    }
    process.stdout.write('\n');
  });

// 3. STATUS / INSPECT COMMAND
program
  .command('status <txId>')
  .alias('inspect')
  .description('Display detailed state, attempt history, and receipts for a transaction')
  .option('-d, --db <path>', 'Path to SQLite ledger database', DEFAULT_DB_PATH)
  .option('--json', 'Output full details as JSON')
  .action((txId, opts) => {
    const ledger = new TransactionLedger(opts.db);
    const tx = ledger.getTransactionById(txId);

    if (!tx) {
      process.stderr.write(`[-] ERROR: Transaction ${txId} not found.\n`);
      process.exit(1);
    }

    const attempts = ledger.getAttemptsForTransaction(txId);
    const verifications = ledger.getVerificationsForTransaction(txId);
    const compensations = ledger.getCompensationsForTransaction(txId);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            transaction: tx,
            attempts,
            verifications,
            compensations,
          },
          null,
          2
        ) + '\n'
      );
      return;
    }

    process.stdout.write(`\n=== Transaction Details: ${tx.id} ===\n`);
    process.stdout.write(`Tool:        ${tx.toolName}\n`);
    process.stdout.write(`State:       ${tx.state}\n`);
    process.stdout.write(`Risk Level:  ${tx.riskLevel}\n`);
    process.stdout.write(`Fingerprint: ${tx.fingerprint}\n`);
    process.stdout.write(`Created At:  ${tx.createdAt}\n`);
    process.stdout.write(`Updated At:  ${tx.updatedAt}\n\n`);

    process.stdout.write(`Sanitized Arguments:\n${JSON.stringify(JSON.parse(tx.sanitizedArguments), null, 2)}\n\n`);

    if (tx.resultPayload) {
      process.stdout.write(`Result Payload:\n${JSON.stringify(JSON.parse(tx.resultPayload), null, 2)}\n\n`);
    }

    if (attempts.length > 0) {
      process.stdout.write(`Execution Attempts (${attempts.length}):\n`);
      for (const a of attempts) {
        process.stdout.write(`  - Attempt #${a.attemptNumber}: Status=${a.status}, Duration=${a.durationMs || 0}ms ${a.errorMessage ? `Error=${a.errorMessage}` : ''}\n`);
      }
      process.stdout.write('\n');
    }

    if (verifications.length > 0) {
      process.stdout.write(`Verification History (${verifications.length}):\n`);
      for (const v of verifications) {
        process.stdout.write(`  - Verifier=${v.verifierTool} Outcome=${v.outcome} Notes=${v.notes || ''}\n`);
      }
      process.stdout.write('\n');
    }

    if (compensations.length > 0) {
      process.stdout.write(`Compensation History (${compensations.length}):\n`);
      for (const c of compensations) {
        process.stdout.write(`  - Compensator=${c.compensatorTool} Status=${c.status} ${c.errorMessage ? `Error=${c.errorMessage}` : ''}\n`);
      }
      process.stdout.write('\n');
    }
  });

// 4. RECEIPT COMMAND
program
  .command('receipt <txId>')
  .description('Print the verifiable JSON receipt for a transaction')
  .option('-d, --db <path>', 'Path to SQLite ledger database', DEFAULT_DB_PATH)
  .action((txId, opts) => {
    const ledger = new TransactionLedger(opts.db);
    try {
      const receipt = ledger.generateReceipt(txId);
      process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    } catch (err) {
      process.stderr.write(`[-] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// 5. DOCTOR / HEALTH COMMAND
program
  .command('doctor')
  .description('Validate ledger integrity, configuration validity, and stale transactions')
  .option('-d, --db <path>', 'Path to SQLite ledger database', DEFAULT_DB_PATH)
  .option('-m, --manifest <path>', 'Path to custom AgentX manifest')
  .action((opts) => {
    process.stdout.write('=== AgentX System Doctor ===\n');

    // 1. Check manifest
    try {
      const loader = ManifestLoader.loadFromFile(opts.manifest);
      process.stdout.write('[✓] Policy Manifest: Valid\n');
      process.stdout.write(`    Configured tools: ${Object.keys(loader.getManifest().tools || {}).length}\n`);
    } catch (err) {
      process.stdout.write(`[-] Policy Manifest Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // 2. Check database ledger
    try {
      const ledger = new TransactionLedger(opts.db);
      const allTx = ledger.listTransactions({ limit: 1000 });
      process.stdout.write(`[✓] SQLite Ledger: Online (${opts.db})\n`);
      process.stdout.write(`    Total transactions recorded: ${allTx.length}\n`);

      const unknownTx = allTx.filter(t => t.state === 'UNKNOWN_STATE');
      if (unknownTx.length > 0) {
        process.stdout.write(`    [!] WARN: Found ${unknownTx.length} transaction(s) in UNKNOWN_STATE requiring attention.\n`);
      } else {
        process.stdout.write('    [✓] No transactions in UNKNOWN_STATE.\n');
      }
    } catch (err) {
      process.stdout.write(`[-] SQLite Ledger Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    process.stdout.write('\nDoctor check complete.\n');
  });

program.parse(process.argv);
