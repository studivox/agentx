# AgentTX System Architecture & Design Specification

**Document Version:** 1.0.0  
**Status:** Approved  
**Date:** August 24, 2026  

---

## 1. Overview

AgentTX is a local-first, zero-cloud-dependency transactional reliability layer and proxy for the **Model Context Protocol (MCP)**. It transparently interposes on MCP communication channels (over `stdio` and HTTP transports) to ensure that agent-driven side effects are executed reliably, idempotently, and safely.

```
+------------------+         JSON-RPC 2.0 (stdio)         +----------------------+
|                  | -----------------------------------> |                      |
|  Agent Runtime / |                                      |  AgentTX Proxy       |
|  MCP Host        | <----------------------------------- |  (Reliability Layer) |
|                  |             Evidence Receipt         |                      |
+------------------+                                      +----------+-----------+
                                                                     |
                                      +------------------------------+------------------------------+
                                      |                              |                              |
                                      v                              v                              v
                           +--------------------+         +--------------------+         +--------------------+
                           |  Durable SQLite    |         |  Postcondition     |         |  Saga Compensation|
                           |  Ledger (WAL Mode) |         |  Verifier Engine   |         |  Coordinator       |
                           +--------------------+         +--------------------+         +--------------------+
                                                                     |
                                                          JSON-RPC 2.0 (stdio)
                                                                     |
                                                                     v
                                                          +--------------------+
                                                          |  Downstream MCP    |
                                                          |  Tool Server       |
                                                          +--------------------+
```

---

## 2. Core Subsystems

### 2.1. Deterministic Logical Fingerprinting Engine
- **Objective:** Compute a canonical hash representing the true intent of a tool call, independent of cosmetic argument key order, whitespace, or ephemeral metadata.
- **Canonicalization:**
  1. Recursively sorts dictionary keys in lexicographical order.
  2. Preserves array element ordering.
  3. Formats floating-point numbers consistently.
  4. Filters declared `logicalKeys` (e.g. `['patientId', 'doctorId', 'date', 'slot']`) while ignoring cosmetic or runtime nonces.
- **Hashing:** `SHA-256("tx:" + toolName + ":" + canonicalJSON)`.

### 2.2. Durable SQLite Ledger
- **Engine:** SQLite running in `WAL` (Write-Ahead Logging) mode with `PRAGMA synchronous = NORMAL`.
- **Tables:**
  - `transactions`: Primary ledger recording intent, state, payloads, and receipts.
  - `attempts`: Individual execution attempts, timings, status codes, and error traces.
  - `verifications`: Evidence gathered by active postcondition inspections.
  - `compensations`: History and results of saga rollback actions.
- **Performance:** Transaction insert/update overhead is `< 1.5ms` on local NVMe/SSD storage.

### 2.3. Transaction State Machine

```
                  ┌─────────────┐
                  │   PENDING   │ (Intent registered in SQLite)
                  └──────┬──────┘
                         │
                         ▼
                  ┌─────────────┐
                  │  EXECUTING  │ (Forwarded to MCP tool)
                  └──┬───┬───┬──┘
         (success)   │   │   │ (timeout / network disconnect)
      ┌──────────────┘   │   └──────────────┐
      ▼                  │                  ▼
┌───────────┐            │           ┌─────────────┐
│ COMMITTED │            │           │  AMBIGUOUS  │
└───────────┘            │           └──────┬──────┘
                         │                  │ (triggers Verifier Engine)
                         │                  ▼
                         │           ┌─────────────┐
                         │           │  VERIFYING  │
                         │           └──┬───┬───┬──┘
                         │  (proven com)│   │   │(inconclusive)
                         │ ┌────────────┘   │   └──────────┐
                         │ │  (proven abs)  ▼              ▼
                         │ │         ┌────────────┐ ┌───────────────┐
                         ▼ ▼         │   FAILED   │ │ UNKNOWN_STATE │
                  ┌─────────────┐    └────────────┘ └───────────────┘
                  │ COMPENSATING│                    (Fail-Closed)
                  └──────┬──────┘
                         │
                         ▼
                  ┌─────────────┐
                  │ COMPENSATED │
                  └─────────────┘
```

### 2.4. Active Postcondition Verification Engine
- When an execution attempt terminates ambiguously (e.g. `ETIMEDOUT`, process pipe dropped, host crash):
  1. AgentTX halts blind retries.
  2. Resolves the configured `verifier` tool in the manifest.
  3. Constructs verifier arguments via declarative mapping (`argumentMapping`).
  4. Executes the verifier query against the downstream server.
  5. Reconciles state:
     - `PROVEN_COMMITTED`: State mutated successfully; transaction promoted to `COMMITTED` and cached receipt returned.
     - `PROVEN_ABSENT`: Side-effect did not take place; safe to retry or terminate in `FAILED`.
     - `INCONCLUSIVE`: External state cannot be proven; transaction transitions to `UNKNOWN_STATE` (fail-closed).

### 2.5. Saga Compensation Coordinator
- Implements the Saga pattern for undoing side-effects or rolling back composite multi-tool workflows.
- For individual transactions: executes the declared `compensator` tool with parameters mapped from original inputs and execution results.
- For multi-step sagas: executes compensations in reverse (LIFO) order.

### 2.6. Transparent Stdio & HTTP Transport Proxy
- Implements MCP `Server` and `Client` transports simultaneously.
- Standard Output (`stdout`) is strictly reserved for JSON-RPC messages.
- All diagnostic logs and error traces are routed to `stderr`.
