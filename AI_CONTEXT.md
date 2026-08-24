# AgentX Context

## 1. Overview & Architecture
- **System**: AgentX is a local-first transactional reliability layer and proxy for Model Context Protocol (MCP) tool executions. It provides deterministic logical idempotency fingerprinting, a durable SQLite ledger, active postcondition verification, and saga-style compensation without modifying underlying MCP tools.
- **Stack**: TypeScript (ESM / NodeNext), SQLite (`better-sqlite3`), MCP TypeScript SDK (`@modelcontextprotocol/sdk`), Zod, Commander, Vitest.
- **Primary Package Manager**: npm.

## 2. Directory Layout
- `src/types/`: Type definitions and Zod schemas for manifests, transactions, receipts, and JSON-RPC protocols.
- `src/fingerprint/`: Canonical JSON hashing and deterministic logical key extraction.
- `src/ledger/`: SQLite WAL-mode transactional state store, migrations, and attempt history.
- `src/verification/`: Active postcondition inspection engine and state reconciler.
- `src/compensation/`: Saga rollback coordinator for compensating transactions.
- `src/proxy/`: MCP tool call interceptor and stdio transport proxy.
- `src/manifest/`: Tool policy manifest loader, validator, and default safety rules.
- `src/utils/`: Stderr logger (protecting stdout JSON-RPC pipe) and sensitive parameter redaction.
- `examples/`: Realistic mock flaky servers, sample configurations (`agentx.config.json`), and interactive demonstration client.
- `tests/`: Comprehensive unit, integration, recovery, and CLI tests.
- `docs/`: In-depth research, architecture specifications, and protocol details.

## 3. Key Entry Points & Boundaries
- **Library Root**: `src/index.ts`
- **CLI Entry Point**: `src/cli.ts` (`agentx`)
- **MCP Proxy Core**: `src/proxy/mcp-interceptor.ts` & `src/proxy/stdio-proxy.ts`
- **Ledger Engine**: `src/ledger/transaction-ledger.ts`
- **Stdio Protocol Invariant**: `stdout` is exclusively reserved for JSON-RPC messages; all diagnostics MUST go to `stderr`.

## 4. Essential Commands
- **Dev / CLI**: `npm run dev -- [args]`
- **Build**: `npm run build` (`tsc`)
- **Targeted Test**: `npx vitest run tests/<file>.test.ts`
- **Full Test Suite**: `npm test` (`vitest run`)
- **Typecheck**: `npm run typecheck` (`tsc --noEmit`)
- **Lint**: `npm run lint` (`eslint src/ tests/`)
- **Demo**: `npm run demo` (`tsx examples/demo-client.ts`)

## 5. Security & Invariant Rules
- **Zero Raw Secret Storage**: Passwords, API tokens, credit cards, and private keys in arguments are automatically redacted in receipts and ledger records.
- **Fail-Closed Safety**: Ambiguous states that cannot be proven via postcondition verification terminate in `UNKNOWN_STATE` rather than risking duplicate side-effects.
- **Local-First**: All state lives in local SQLite database (`.agentx/agentx.db` or `AGENTX_DB_PATH`); zero external cloud dependencies.
- **Deterministic Fingerprinting**: Logical keys are extracted and hashed (`SHA-256`) after canonical sorting to eliminate argument order nonces.

## 6. Current Task & In-Flight State
- **Active Goal**: Complete AgentX identity conversion, category-leading README, CI/community surface, quality gates, git main branch preparation, and GitHub publication.
- **Status**: Codebase converted to AgentX. Tests passing. Quality gates active.
