# Contributing to AgentX

Thank you for your interest in contributing to **AgentX**! We welcome contributions to help make AI agent tool executions deterministic, safe, and transactionally reliable.

---

## Development Workflow

### 1. Prerequisites
- Node.js >= 20.0.0
- npm >= 9.0.0

### 2. Setup
```bash
git clone https://github.com/studivox/agentx.git
cd agentx
npm install
```

### 3. Build & Typecheck
```bash
npm run build
npm run typecheck
```

### 4. Running Tests
AgentX uses [Vitest](https://vitest.dev) for test execution:
```bash
# Run full test suite
npm test

# Run a specific test file
npx vitest run tests/fingerprint.test.ts

# Watch mode
npm run test:watch
```

### 5. Running the Interactive Demo
Verify end-to-end proxy behavior, deduplication, postcondition verification, and sagas:
```bash
npm run demo
```

---

## Architecture & Code Guidelines

1. **Stdio Protocol Invariant:**
   `stdout` is strictly reserved for JSON-RPC 2.0 messages when running as a stdio proxy. Never use `console.log()` or write arbitrary data to standard output. Always use `logger` from `src/utils/logger.ts` which routes exclusively to `stderr`.
2. **Security & Redaction:**
   All sensitive fields declared in tool policies or matching standard credential patterns (e.g. passwords, tokens, API keys, credit cards) must be redacted before being stored in the SQLite ledger or receipts.
3. **Fail-Closed Safety:**
   Ambiguous execution outcomes that cannot be proven via verifier tools must transition to `UNKNOWN_STATE` rather than blindly retrying.

---

## Pull Request Process

1. Fork the repository and create your branch from `main`.
2. Ensure all tests pass (`npm test`).
3. Ensure typecheck and linting pass (`npm run typecheck && npm run lint`).
4. Submit a Pull Request describing the changes and the rationale.
