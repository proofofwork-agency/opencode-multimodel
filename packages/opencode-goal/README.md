# opencode-goal

Persisted `/goal` for [OpenCode](https://github.com/anomalyco/opencode).

Current prerelease: **`0.2.0-alpha.0`**, validated with OpenCode **1.18.15**.

`/goal` is a thread-scoped completion contract, not a longer prompt. One goal
belongs to one OpenCode session. The plugin keeps that objective across turns,
compaction, and interrupts, and it only marks the goal complete after an
evidence audit.

The model can start a goal and propose completion. It cannot pause, resume, or
change the budget. Pause is user or interrupt. Resume is explicit or interrupt
recovery. Crossing a token budget is `budget_limited`. Completion is
fail-closed: a host check or a cited existing file, plus an independent
small-model verdict of `met`. The judge can also return `impossible`, which
is a terminal stop.

## Install

```json
{
  "plugin": [
    "opencode-goal@alpha"
  ]
}
```

OpenCode loads the package’s `./server` and `./tui` exports. Add the same spec
to `tui.json` as well as `opencode.json`; the TUI list is separate, and `/goal`
only intercepts the busy-session queue when the TUI entry is loaded.

`/goal` applies immediately and **steers the live session**. Status, pause,
clear, and budget never enqueue a turn. Set and resume persist the contract,
abort the current turn if it is running, and start a goal turn so the session
is taken over instead of ignoring `/goal` until idle.

## Use

```text
/goal Reduce p95 checkout latency below 120 ms --check "npm test" --budget 500k
/goal status
/goal pause
/goal resume
/goal clear
```

Useful flags on set:

- `--budget 200k` token cap (`k` / `m` suffixes allowed)
- `--check "npm test"` host-run proof; may be repeated
- `--verify "..."` extra success criteria
- `--constraint "..."` non-goals and hard limits

Setting a goal writes a persisted record (SQLite + `.opencode/goals/<session>.json`)
and posts a receipt into the session. That is the confirmation a goal exists —
not a one-shot prompt. Agents receive the same contract on every later turn via
the system prompt and `get_goal`. Completion only happens through `update_goal`
plus evidence.

Setting a goal takes over the current session: if a turn is already running,
that turn is aborted and replaced with the goal start prompt. The runtime then
keeps going for as long as the OpenCode process is up — one continuation per
idle, including after you reopen the session or restart OpenCode. It is not a
detached daemon: close the process and the loop pauses until that session is
open again.

## How the loop stops

The plugin does not spin. It continues once per idle, then waits for the next
safe boundary.

It stops when:

- host proof and the independent judge both say the goal is met (`complete`)
- the judge returns `impossible`
- token usage reaches `--budget` (`budget_limited`)
- you `/goal pause` or `/goal clear`
- two continuation turns in a row make no tool calls
- a child session is busy
- the session is in plan mode
- another user prompt is already queued
- three prompt failures occur
- you interrupt the turn (Esc/abort); `/goal resume` or a session re-open continues it

`/goal resume` clears suppression and interrupt pauses. A user-paused goal
stays paused until you resume it.

## Completion is fail-closed

`update_goal { status: "complete" }` is not enough. After every idle turn a
small-model judge votes `not_met`, `met`, or `impossible`, and `/goal status`
shows that reason.

Completion also requires host proof:

1. Reject empty or thin evidence.
2. Run every `--check` on the host when `runHostChecks` is true.
3. If there is no `--check`, the evidence must cite an existing project file.
4. The independent judge must return `met`. `impossible` ends the goal.

Passing tests in prose, a todo list, or elapsed effort are not enough.

Other plugins can read `.opencode/goals/<sessionID>.json` without importing
this package.

## Options

```json
[
  "opencode-goal@alpha",
  {
    "databasePath": ".opencode/goal.sqlite",
    "snapshotDir": ".opencode/goals",
    "minDelayMs": 1500,
    "maxPromptFailures": 3,
    "autoResumeInterrupted": true,
    "runHostChecks": true,
    "requireHostProof": true,
    "judge": true,
    "noToolTurnsBeforeSuppress": 2,
    "checkTimeoutMs": 120000
  }
]
```

State files are created `0600`. Add `.opencode/goal.sqlite*` and
`.opencode/goals/` to `.gitignore` if you do not want local runtime state
committed.

## Development

```sh
bun test
bun run typecheck
bun run build
```
