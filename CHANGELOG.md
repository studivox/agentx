# Changelog

All notable changes to **AgentX** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-25

### Initial Public Preview Release

- **Deterministic Logical Fingerprinting:** Canonical JSON ordering and declared logical key filtering for deduplicating MCP tool calls (`SHA-256`).
- **Durable SQLite Ledger:** WAL-mode SQLite repository tracking intents (`PENDING`), executions (`EXECUTING`), commitments (`COMMITTED`), ambiguous outcomes (`AMBIGUOUS`), verifications (`VERIFYING`), and compensations (`COMPENSATING`/`COMPENSATED`).
- **Active Postcondition Verification:** Automatic interrogation of external state upon timeouts or network drops before initiating retries.
- **Fail-Closed Safety:** Guard against duplicate side-effects when outcomes cannot be proven (`UNKNOWN_STATE`).
- **Saga Compensation Coordinator:** Declarative rollback mechanisms for individual and composite multi-tool actions.
- **Sensitive Parameter Redaction:** Automated zero-secret storage masking passwords, tokens, API keys, and credit cards in receipts and ledgers.
- **Transparent Stdio MCP Proxy:** Zero-modification wrapping of existing MCP tools over standard input/output streams.
- **Developer CLI (`agentx`):** Subcommands for `wrap`/`proxy`, `list`, `status`/`inspect`, `receipt`, and `doctor`.
- **Policy Manifest (`agentx.config.json`):** Declarative per-tool safety configuration, risk levels, and verifier/compensator mappings.
- **Comprehensive Test Suite:** 35 passing tests across 8 test suites verifying all core invariants.
- **Interactive Demonstration:** Flagship end-to-end demo validating replay protection, postcondition verification, and saga compensation.
