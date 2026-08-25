# Changelog

All notable changes to **AgentX** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-25

### Security & Concurrency Patch Release

#### Fixed & Hardened
- **Durable Cross-Process Execution Leases:** Added SQLite-backed atomic lease claiming (`claimExecutionLease`) with bounded expiry and polling, guaranteeing exactly one downstream execution across concurrent independent Node.js processes sharing a ledger.
- **Zero Plaintext Secret Storage (Security Patch):** Ensured all arguments, error payloads, attempt snippets, and metadata are scrubbed and sanitized before being written to SQLite (`transactions.raw_arguments`, `attempts.response_snippet`).
- **Deep JSON String Redaction:** Enhanced the redaction engine to recursively parse, scrub, and re-serialize stringified JSON payloads found in tool responses, error messages, and logs.
- **Adversarial Verifier Protection:** Hardened `VerifierEngine` to require strict structured JSON path matching and reject unstructured error text containing matching keywords (preventing false `PROVEN_COMMITTED` states).
- **Idempotent Database Migrations:** Implemented automatic on-startup schema migration (`migrateDatabase`) that adds lease columns and scrubs legacy plaintext records safely without corruption.
- **Saga Payload Resolution:** Enhanced `SagaCoordinator` argument extraction to support nested MCP JSON response structures.
- **CLI & Proxy Version Alignment:** Synchronized CLI version reporting with package release metadata.

#### Upgrade & Migration Guidance for v0.1.0 Users
- **Automatic Migration:** Upgrading to `v0.1.1` automatically migrates existing SQLite ledger files (`.agentx/agentx.db`) by adding concurrency lease columns and scrubbing standard sensitive patterns (passwords, tokens, API keys, cards, CVVs, SSNs, phone numbers).
- **Custom Sensitive Fields Notice:** Custom/proprietary sensitive field names configured via custom manifests cannot be automatically inferred for historical v0.1.0 records. If you logged proprietary secrets under custom field names in `v0.1.0`, we recommend deleting the legacy ledger file or performing manual review and credential rotation.

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
