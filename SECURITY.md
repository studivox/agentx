# Security Policy

## Supported Versions

| Version | Supported          | Status |
| ------- | ------------------ | ------ |
| 0.1.1+  | :white_check_mark: | Active Support |
| 0.1.0   | :x:                | Deprecated (Security & Concurrency Fixes in v0.1.1) |

---

## Security Architecture & Guarantees

AgentX enforces strict local-first security invariants:

1. **Zero Plaintext Sensitive Storage:** All declared sensitive fields (passwords, tokens, credit card numbers, CVVs, API keys, medical/PII notes) and recursively nested JSON payloads are scrubbed before persistence in the SQLite ledger and execution receipts.
2. **Durable Cross-Process Idempotency:** SQLite-backed execution leases guarantee that concurrent requests with identical fingerprints execute downstream at most once, preventing duplicate financial or state-mutating side effects.
3. **Fail-Closed Ambiguity Resolution:** When an in-flight tool call times out or encounters network disconnections, unverified mutating tools transition to `UNKNOWN_STATE` rather than performing blind retries.
4. **Postcondition Verification Integrity:** Verifiers require exact structured evidence matches and ignore unstructured error noise.

---

## Reporting a Vulnerability

We take the security of **AgentX** very seriously.

If you believe you have discovered a security vulnerability in AgentX, please report it responsibly:

- **Do NOT open a public issue.**
- Report security issues via GitHub Security Advisories at [https://github.com/studivox/agentx/security/advisories](https://github.com/studivox/agentx/security/advisories) or email `security@studivox.com`.

### What to Include in Your Report
1. Clear description of the vulnerability and attack vector.
2. Minimal reproduction steps (proof-of-concept configuration or tool call script).
3. Potential impact on agent runtimes or downstream systems.
4. Suggested remediation if known.

We acknowledge receipt within 24 hours and provide rapid security advisories and patch releases.
