# AgentX Protocol Specification & Wire Format

**Document Version:** 1.0.0  
**Date:** August 24, 2026  

---

## 1. Overview

AgentX operates transparently over standard **Model Context Protocol (MCP) JSON-RPC 2.0** specifications. It preserves complete backwards compatibility with all existing MCP clients (Claude Desktop, Cursor, Antigravity, custom agent runtimes) and servers.

---

## 2. Request Handling & Interception

### 2.1. `tools/list`
- Upstream client requests tool definitions:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }
  ```
- AgentX queries downstream MCP server, decorates tool descriptions with the active risk level policy (`[AgentX: MUTATING_CRITICAL]`), and returns the tool schemas.

### 2.2. `tools/call`
- Upstream client invokes a tool:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "book_appointment",
      "arguments": {
        "patientId": "p_4081",
        "doctorId": "doc_dr_ayse",
        "date": "2026-09-01",
        "slot": "14:30",
        "patientPhone": "+905551234567"
      },
      "_meta": {
        "idempotencyKey": "custom-client-id-optional"
      }
    }
  }
  ```

---

## 3. Evidence-Backed JSON Receipt Format

Every transactional mutation yields an evidence-backed JSON receipt stored in the ledger with deterministic SHA-256 fingerprinting:

```json
{
  "receiptId": "rcpt_fec4e658537c49498fcfb2f8a5d4f376",
  "transactionId": "tx_de6569d3076d48cbad71a8604bd4473f",
  "fingerprint": "01c86a62c01771c87e4a21eb181a1f759b071abbdcfecd09d960c005a2b7e8f7",
  "toolName": "book_appointment",
  "state": "COMMITTED",
  "riskLevel": "MUTATING_CRITICAL",
  "idempotentReplay": false,
  "createdAt": "2026-08-24T14:30:00.000Z",
  "committedAt": "2026-08-24T14:30:00.250Z",
  "sanitizedArguments": {
    "patientId": "p_4081",
    "doctorId": "doc_dr_ayse",
    "date": "2026-09-01",
    "slot": "14:30",
    "patientPhone": "[REDACTED]"
  },
  "result": {
    "response": {
      "content": [
        {
          "type": "text",
          "text": "{\"appointmentId\":\"appt_p_4081_2026-09-01_14:30\",\"status\":\"CONFIRMED\"}"
        }
      ]
    }
  },
  "attemptsCount": 1,
  "verificationEvidence": null,
  "compensationHistory": null
}
```

---

## 4. Idempotent Replay Protocol

When an identical logical request is received:
1. AgentX matches the computed SHA-256 fingerprint in the local SQLite ledger.
2. If state is `COMMITTED`:
   - Downstream server is **NOT** invoked.
   - Cached response is returned immediately with `idempotentReplay: true`.
3. If state is `UNKNOWN_STATE`:
   - Request is blocked (fail-closed) with error message to prevent potential duplicate side effects.
