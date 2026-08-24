import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TransactionLedger } from '../src/ledger/transaction-ledger.js';
import { execSync } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB = '.agentx/test_cli_agentx.db';

describe('AgentX CLI Suite', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) {
      try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    }
    const ledger = new TransactionLedger(TEST_DB);
    const tx1 = ledger.createTransaction({
      fingerprint: 'cli_test_fp_1',
      toolName: 'book_flight',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { flightNo: 'TK100', passenger: 'John Doe' },
    });
    ledger.updateTransactionState(tx1.id, 'COMMITTED', {
      resultPayload: { bookingRef: 'XYZ123' },
    });

    const tx2 = ledger.createTransaction({
      fingerprint: 'cli_test_fp_2',
      toolName: 'charge_card',
      riskLevel: 'MUTATING_CRITICAL',
      rawArguments: { amount: 250 },
    });
    ledger.updateTransactionState(tx2.id, 'UNKNOWN_STATE');
  });

  afterEach(() => {
    if (existsSync(TEST_DB)) {
      try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    }
  });

  it('should run doctor command successfully', () => {
    const output = execSync(`npx tsx src/cli.ts doctor --db ${TEST_DB}`).toString();
    expect(output).toContain('AgentX System Doctor');
    expect(output).toContain('SQLite Ledger: Online');
    expect(output).toContain('Total transactions recorded: 2');
    expect(output).toContain('Found 1 transaction(s) in UNKNOWN_STATE');
  });

  it('should list transactions in table and json formats', () => {
    const tableOutput = execSync(`npx tsx src/cli.ts list --db ${TEST_DB}`).toString();
    expect(tableOutput).toContain('book_flight');
    expect(tableOutput).toContain('charge_card');

    const jsonOutput = execSync(`npx tsx src/cli.ts list --db ${TEST_DB} --json`).toString();
    const parsed = JSON.parse(jsonOutput);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  it('should inspect transaction status', () => {
    const ledger = new TransactionLedger(TEST_DB);
    const tx = ledger.listTransactions({ toolName: 'book_flight' })[0];

    const output = execSync(`npx tsx src/cli.ts status ${tx.id} --db ${TEST_DB}`).toString();
    expect(output).toContain(tx.id);
    expect(output).toContain('COMMITTED');
    expect(output).toContain('XYZ123');
  });

  it('should print verifiable receipt via CLI', () => {
    const ledger = new TransactionLedger(TEST_DB);
    const tx = ledger.listTransactions({ toolName: 'book_flight' })[0];

    const output = execSync(`npx tsx src/cli.ts receipt ${tx.id} --db ${TEST_DB}`).toString();
    const receipt = JSON.parse(output);
    expect(receipt.transactionId).toBe(tx.id);
    expect(receipt.state).toBe('COMMITTED');
    expect(receipt.receiptId).toMatch(/^rcpt_/);
  });
});
