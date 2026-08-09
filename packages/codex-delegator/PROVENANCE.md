# Delegator provenance

`codex-delegator` was extracted from Poly's independently maintained `@poly/delegator` package on 2026-08-09. The extracted runtime has no Poly, Headless, OpenCode, workspace, package-manager, executable, or CLI dependency beyond Bun and a local Codex CLI.

The original implementation was audited on 2026-08-03 against:

- Headless commit `43b8d53999b47802efe570047318f86a6342e7a4`, including its Codex session driver, event decoding, persistence, process-tree, and redaction code.
- OpenAI's Codex plugin for Claude Code commit `807e03ac9d5aa23bc395fdec8c3767500a86b3cf`, including its broker, runtime, process, state, and review behavior.
- The locally installed Codex CLI `0.146.0` app-server protocol and generated v2 TypeScript schemas.

The installed Codex CLI's generated schema remains the compatibility authority for the version this package executes. Future upstream fixes must be compared and ported manually.

## Preserved constraints

- Keep one app-server process alive for a continuing thread.
- Register notifications before `turn/start` or `review/start` because events may arrive before responses.
- Treat native review as a separate read-only operation with explicit target shapes.
- Preserve native thread identifiers in bounded, credential-free state.
- Treat status, result, cancellation, and ambiguous delivery as explicit lifecycle states.
- Never infer authentication from a file when `account/read` is available.
- Never replay a write-capable prompt after transport loss once `turn/start` was accepted.
- Bound and redact stdout, stderr, events, stored output, and JSON frames.
- Interrupt active turns before teardown and keep close idempotent.
