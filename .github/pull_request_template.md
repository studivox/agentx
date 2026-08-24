## Description

Please include a concise summary of the change and the issue or requirement it addresses.

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds transactional functionality)
- [ ] Breaking change (fix or feature that would cause existing behavior to change)
- [ ] Documentation update
- [ ] Performance optimization or refactor

## Invariants & Quality Checklist

- [ ] My code follows the code style and guidelines of AgentX.
- [ ] I have maintained the **stdio protocol invariant**: `stdout` is strictly reserved for JSON-RPC transport; all logs go to `stderr`.
- [ ] I have ensured zero secret/PII persistence in receipts or logs.
- [ ] I have added or updated tests covering the changes.
- [ ] All new and existing tests pass locally (`npm test`).
- [ ] TypeScript typecheck and ESLint pass without warnings (`npm run typecheck && npm run lint`).
- [ ] Verified build passes (`npm run build`).
