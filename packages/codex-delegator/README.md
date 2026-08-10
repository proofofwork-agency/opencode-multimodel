# codex-delegator

`codex-delegator` is a reusable Bun library for running bounded tasks through a locally installed and authenticated OpenAI Codex CLI. It prefers one persistent `codex app-server` process per delegate seat and falls back to `codex exec --json` when app-server is unavailable.

Current prerelease: **`0.2.0-alpha.0`**. This is the reusable runtime library,
not an OpenCode plugin; install `opencode-codex-delegate@alpha` when OpenCode
plugin/provider integration is required.

## Install

```sh
bun add codex-delegator@alpha
```

The package requires Bun 1.3 or newer and a `codex` executable on `PATH`. Authentication stays owned by the Codex CLI; this library never reads or stores credentials.

## Usage

```ts
import { CodexDelegator, DelegatorError } from "codex-delegator";

const delegate = new CodexDelegator();
const probe = await delegate.probe({ cwd: process.cwd() });

if (!probe.ready) throw new Error(probe.reason ?? "Codex is unavailable");

const input = {
  sessionID: "host-session-1",
  seatId: "codex",
  cwd: process.cwd(),
  mode: "write" as const,
  isolation: "worktree" as const,
  approvalPolicy: "ask" as const,
};

const handle = await delegate.resume(input).catch((error: unknown) => {
  if (!(error instanceof DelegatorError) || error.code !== "INVALID_REQUEST")
    throw error;
  return delegate.create(input);
});

const result = await delegate.turn(handle, {
  prompt: "Add a focused regression test for the parser.",
  reasoningEffort: "high",
  timeoutMs: 300_000,
});

console.log(result.output);
await delegate.closeAll();
```

## Safety and lifecycle

- Write sessions default to a detached managed git worktree and `ask` approvals.
- `isolation: "current"` and `approvalPolicy: "bypass"` require `confirmedUnsafe: true`.
- Persistent attachments are bounded, redacted, and stored in `<git-root>/.codex-delegate` by default. Set `stateDir` on `CodexDelegator` to override this.
- Managed worktrees live beside the repository under `.codex-delegate-worktrees`.
- One seat accepts one turn at a time; different seats remain concurrent.
- Delivery failures after `turn/start` are reported as ambiguous and are never replayed automatically.
- Call `close()` for one seat or `closeAll()` during host shutdown so detached app-server children do not outlive the host.

## Configuration

`CodexDelegator` accepts `executable`, `stateDir`, `serviceName`, and `appServerArgv` overrides. `TurnInput.reasoningEffort` maps to app-server's per-turn `effort` override. The remaining constructor hooks are intended for alternate transports and deterministic testing.

Set `CODEX_DELEGATOR_LIVE=1` to enable read-only live tests. Write, review, and scale live tests have separate opt-in flags in `tests/live.test.ts`.

The `0.2.0-alpha.0` gate was exercised with the locally authenticated Codex CLI,
including app-server probe, persistent delegation, restart/resume, native review,
steering, cancellation, concurrency, and multiple seats. These live checks remain
explicit opt-ins for downstream development environments.
