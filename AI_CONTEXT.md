# AgentTX Context

## 1. Overview & Architecture
- **System**: AgentTX is a local-first transactional reliability layer and proxy for Model Context Protocol (MCP) tool executions. It provides deterministic logical idempotency fingerprinting, a durable SQLite ledger, active postcondition verification, and saga-style compensation without modifying underlying MCP tools.
- **Stack**: TypeScript (NodeNext), SQLite (`better-sqlite3`), MCP TypeScript SDK (`@modelcontextprotocol/sdk`), Zod, Commander, Vitest.
- **Package Manager**: npm.

## 2. Directory Layout
- `src/types/`: Type definitions and Zod schemas for manifests, transactions, receipts, and JSON-RPC protocols.
- `src/fingerprint/`: Canonical JSON hashing and deterministic logical key extraction.
- `src/ledger/`: SQLite WAL-mode transactional state store, migrations, and attempt history.
- `src/verification/`: Active postcondition inspection engine and state reconciler.
- `src/compensation/`: Saga rollback coordinator for compensating transactions.
- `src/proxy/`: MCP tool call interceptor and stdio/HTTP transport proxy.
- `src/manifest/`: Tool policy manifest loader, validator, and default safety rules.
- `src/utils/`: Stderr logger (protecting stdout JSON-RPC pipe) and sensitive parameter redaction.
- `examples/`: Realistic mock flaky servers, sample configurations, and interactive demonstration client.
- `tests/`: Comprehensive unit, integration, recovery, and CLI tests.
- `docs/`: In-depth research, architecture specifications, and protocol details.

## 3. Key Entry Points & Boundaries
- **Library Root**: `src/index.ts`
- **CLI Entry Point**: `src/cli.ts` (`agenttx`)
- **MCP Proxy Core**: `src/proxy/mcp-interceptor.ts` & `src/proxy/stdio-proxy.ts`
- **Ledger Engine**: `src/ledger/transaction-ledger.ts`
- **Stdio Protocol Invariant**: `stdout` is exclusively reserved for JSON-RPC messages; all diagnostics MUST go to `stderr`.

## 4. Essential Commands
- **Dev / CLI**: `npm run dev -- [args]`
- **Build**: `npm run build` (`tsc`)
- **Test**: `npm test` (`vitest run`)
- **Typecheck**: `npm run typecheck` (`tsc --noEmit`)
- **Demo**: `npm run demo`

## 5. Security & Invariant Rules
- **Zero Raw Secret Storage**: Passwords, API tokens, and private keys in arguments are automatically redacted in receipts and ledger records.
- **Fail-Closed Safety**: Ambiguous states that cannot be proven via postcondition verification terminate in `UNKNOWN_STATE` rather than risking duplicate side-effects.
- **Local-First**: All state lives in local SQLite database (`.agenttx/agenttx.db`); zero external cloud dependencies.

## 6. Current Task & In-Flight State
- **Active Goal**: Complete core implementation (fingerprint, ledger, verifier, saga, proxy, manifest, CLI, tests, documentation).
- **Status**: Full TypeScript implementation underway.
