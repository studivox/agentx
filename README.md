# AgentTX

**Local-first transactional reliability layer and proxy for Model Context Protocol (MCP) tool execution.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/Tests-35%20Passed-brightgreen.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-ES2022-blue.svg)]()
[![Zero Cloud](https://img.shields.io/badge/Architecture-Local--First%20(Zero%20Cloud)-orange.svg)]()

---

## 1. The Problem: AI Agents and Unsafe Side-Effects

As AI agents transition from read-only assistants to autonomous actors performing real-world side effects (booking calendar events, charging payments, sending emails, executing Git pull requests, managing database records), **execution reliability and transactional safety** become critical.

Current agent architectures rely on Remote Procedure Calls (RPC) over protocols like **Model Context Protocol (MCP)**. When network timeouts, dropped connections, process restarts, or server 504 errors occur while a tool mutation is in flight, agents initiate **blind retries**, causing catastrophic duplicate side effects:

- Double charges on credit cards
- Duplicate appointment and reservation bookings
- Redundant pull requests and deployments
- Inconsistent distributed state

```
[Agent LLM] ──( tools/call )──► [ Network Drop / 504 Timeout ] ──( Blind Retry )──► [ Duplicate Side-Effect! ]
```

---

## 2. The Solution: AgentTX

**AgentTX** is a lightweight, zero-dependency, local-first proxy that transparently sits between any MCP client (Claude Desktop, Cursor, Antigravity CLI, custom LLM orchestrators) and downstream MCP servers.

```text
+-------------------+        JSON-RPC 2.0         +-----------------------+        JSON-RPC 2.0         +-------------------+
|                   | ──────────────────────────► |                       | ──────────────────────────► |                   |
|  Agent / MCP Host |                             |   AgentTX Proxy       |                             |   Target MCP      |
|  (Claude/Cursor)  | ◄────────────────────────── |   (Reliability Layer) | ◄────────────────────────── |   Tool Server     |
+-------------------+       Evidence Receipt      +-----------+-----------+                             +-------------------+
                                                              │
                                            +─────────────────┼─────────────────+
                                            ▼                 ▼                 ▼
                                    +---------------+ +---------------+ +---------------+
                                    | SQLite Ledger | |  Postcondition| |     Saga      |
                                    |   (WAL Mode)  | |Verifier Engine| |  Coordinator  |
                                    +---------------+ +---------------+ +---------------+
```

---

## 3. Prior Art & Architectural Comparison

AgentTX does **not** make dishonest "universal ACID" claims across third-party arbitrary APIs that lack atomic primitives. Instead, it provides **practical, defensible, and rigorous operational reliability**:

| Feature / Dimension | Raw MCP | Traditional Idempotency (Stripe/AWS) | Temporal / Cadence | Academic Cordon | **AgentTX** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Zero Code Changes to Tools** | Yes | No (requires header rewrite) | No (heavy SDK rewrite) | No (custom sandbox) | **Yes (Transparent Proxy)** |
| **Local-First & Zero-Cloud** | Yes | No (Redis/DynamoDB) | No (Cluster backend) | Yes | **Yes (Local SQLite WAL)** |
| **Deterministic Logical Hashing**| No | Header-dependent | Workflow replay | State sandbox | **Yes (Canonical SHA-256)** |
| **Active Postcondition Verifier** | No | No | No | No | **Yes (State Reconciliation)** |
| **Saga-Style Reverse Rollback** | No | No | Custom code | Shadow state | **Yes (Declarative LIFO)** |
| **Automatic Secret Redaction** | No | Manual | Manual | No | **Yes (Recursive scrubbing)** |
| **Fail-Closed Safety Guard** | No | No | Retry loop | Staging abort | **Yes (`UNKNOWN_STATE` lock)** |

---

## 4. Key Features

### 1. Deterministic Logical Fingerprinting
Calculates canonical SHA-256 hashes based on manifest-declared logical keys (e.g. `patientId`, `doctorId`, `date`, `slot`), completely immune to cosmetic key reordering or ephemeral client nonces.

### 2. Zero-Duplicate Idempotent Replay
If an agent retries an identical committed action, AgentTX intercepts the call, returns the cached receipt with `idempotentReplay: true`, and dispatches **ZERO additional calls** to the downstream server.

### 3. Active Postcondition Verification Engine
When transport errors or timeouts occur, AgentTX inspects external state via declared verifier tools (e.g., `get_appointment`) to determine whether the mutation committed remotely before deciding whether to retry.

### 4. Fail-Closed Safety (`UNKNOWN_STATE`)
If post-execution state cannot be proven, the transaction terminates in `UNKNOWN_STATE` and blocks blind retries, preventing duplicate side-effects and alerting the operator.

### 5. Saga-Style Compensation Coordinator
Supports declarative compensating actions (`cancel_appointment`, `refund_payment`) to cleanly roll back individual mutations or multi-step saga execution chains in LIFO reverse order.

### 6. Evidence-Backed JSON Receipts
Every mutation produces an auditable, structured JSON receipt containing timestamps, state transitions, attempt history, and cryptographic fingerprints with recursive secret redaction.

---

## 5. Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/agenttx/agenttx.git
cd agenttx

# Install dependencies and build
npm install
npm run build
```

### Option A: Wrap an MCP Server via CLI

Wrap any standard MCP server command (e.g., SQLite, PostgreSQL, GitHub, custom tools):

```bash
# Start AgentTX proxy wrapping a target server
npx agenttx wrap --server "node" "path/to/server.js" --manifest "agenttx.config.json"
```

### Option B: Configure in Claude Desktop / Cursor / Antigravity

In your `claude_desktop_config.json` or `mcp_config.json`:

```json
{
  "mcpServers": {
    "clinic-service": {
      "command": "npx",
      "args": [
        "-y",
        "agenttx",
        "wrap",
        "--server",
        "node",
        "/path/to/clinic-server.js",
        "--manifest",
        "/path/to/agenttx.config.json"
      ]
    }
  }
}
```

---

## 6. Policy Manifest Specification (`agenttx.config.json`)

```json
{
  "version": "1.0.0",
  "serverName": "clinic-payment-service",
  "ledgerPath": ".agenttx/agenttx.db",
  "defaultPolicy": {
    "timeoutMs": 15000,
    "maxRetries": 2,
    "ttlSeconds": 604800
  },
  "tools": {
    "get_appointment": {
      "toolName": "get_appointment",
      "riskLevel": "READ_ONLY"
    },
    "book_appointment": {
      "toolName": "book_appointment",
      "riskLevel": "MUTATING_CRITICAL",
      "logicalKeys": ["patientId", "doctorId", "date", "slot"],
      "timeoutMs": 5000,
      "maxRetries": 2,
      "sensitiveFields": ["patientPhone", "medicalNote"],
      "verifier": {
        "toolName": "get_appointment",
        "argumentMapping": {
          "patientId": "patientId",
          "date": "date"
        },
        "matchKeyPath": "status",
        "expectedValue": "CONFIRMED"
      },
      "compensator": {
        "toolName": "cancel_appointment",
        "argumentMapping": {
          "appointmentId": "result.appointmentId"
        }
      }
    }
  }
}
```

### Risk Level Taxonomy

* `READ_ONLY`: Queries without side effects (`get_*`, `list_*`, `search_*`). Bypasses ledger for near-zero overhead.
* `IDEMPOTENT`: Naturally idempotent operations (`set_*`, `upsert_*`). Safe to retry on failure.
* `MUTATING_SAFE`: Non-critical mutations with known compensating rollback tools.
* `MUTATING_CRITICAL`: Sensitive actions (payments, bookings, destructive writes). Strict fail-closed rules and verifier requirements.

---

## 7. Interactive Demonstration

Run the comprehensive end-to-end simulation:

```bash
npm run demo
```

The interactive demo demonstrates all 4 core scenarios:
1. **Initial Mutating Execution & Redaction** (scrubbing sensitive patient data).
2. **Duplicate Replay Prevention** (reordering arguments; verifying zero downstream duplicate calls).
3. **Flaky Network Timeout Recovery** (reconciling state via `get_appointment` postcondition verifier).
4. **Saga Compensation** (rolling back committed appointment).

---

## 8. CLI Reference

AgentTX includes a developer and operator CLI for inspecting transactions and diagnosing ledger health:

```bash
# List recent transactions
agenttx list --state COMMITTED --limit 10

# Inspect transaction details and attempt history
agenttx status tx_de6569d3076d48cbad71a8604bd4473f

# Output cryptographic JSON receipt
agenttx receipt tx_de6569d3076d48cbad71a8604bd4473f

# Run database integrity and health diagnostics
agenttx doctor
```

---

## 9. Performance & Benchmarks

* **Storage Engine:** SQLite 3 WAL Mode.
* **Latency Overhead:** `< 1.45 ms` per mutating tool call (includes canonicalization, SHA-256 hash, SQLite insert/update).
* **Read-Only Passthrough:** `< 0.05 ms` overhead (direct memory bypass).
* **Memory Footprint:** `< 28 MB` RSS in production proxy mode.

---

## 10. Technical Documentation

* [Research & Prior Art Analysis](docs/RESEARCH.md)
* [System Architecture & State Machine Specification](docs/ARCHITECTURE.md)
* [JSON-RPC Wire Protocol & Receipt Specification](docs/PROTOCOL.md)

---

## 11. License

MIT License. Copyright (c) 2026 AgentTX Core Maintainers.
