# opencode-goal

Persisted `/goal` for [OpenCode](https://github.com/anomalyco/opencode).

Current prerelease: **`0.2.0-alpha.0`**, validated with OpenCode **1.18.15**.

`/goal` is a thread-scoped completion contract, not a longer prompt. One goal
belongs to one OpenCode session. The plugin keeps that objective across turns,
compaction, and interrupts, and it only marks the goal complete after an
evidence audit.

The model can start a goal and propose completion. It cannot pause, resume,
change the budget, or edit the Dogfood contract. Pause is user, interrupt, or
restart recovery. Completion is fail-closed: a frozen Dogfood contract or host
`--check`, plus an independent judge verdict of `met`. The judge can also
return `impossible`. The worker can stop with `unmet` and a concrete blocker.

The judge and contract author are ephemeral OpenCode sessions created by this
package. They do not come from `opencode-multimodel`.

## Install

```json
{
  "plugin": [
    "opencode-goal@alpha"
  ]
}
```

OpenCode loads the package’s `./server` and `./tui` exports. Add the same spec
to `tui.json` as well as `opencode.json`.

`/goal` applies immediately and **steers the live session**. Status, pause,
clear, budget, history, and contract never enqueue a turn. Set and resume
persist the contract, abort the current turn if it is running, and start a
goal turn.

## Use

Long results (`/goal history`, big status output) do not dump into a
toast: they open a scrollable, closeable dialog (esc) with the full text,
while the toast keeps a one-line summary.

```text
/goal Reduce p95 checkout latency below 120 ms --check "npm test" --budget 500k
/goal status
/goal history
/goal pause
/goal resume
/goal edit Keep the public API unchanged and still hit 120 ms
/goal contract
/goal contract apply
/goal clear
```

Useful flags on set:

- `--budget 200k` token cap (`k` / `m` suffixes allowed)
- `--check "npm test"` required host oracle; may be repeated
- `--verify "..."` extra success criteria for the author/judge
- `--constraint "..."` non-goals and hard limits
- `--max-turns 25` auto-continue cap
- `--max-minutes 30` elapsed-time cap
- `--dogfood` / `--no-dogfood` turn the bundled Dogfood gate on or off for this goal

Toggle later with `/goal dogfood on` or `/goal dogfood off`. Plugin default is
on (`"dogfood": true`).

On set, an independent **contract-author** session drafts a Dogfood YAML from
the story. The plugin is the only writer: it validates, freezes, and hashes
`.opencode/goals/<session>.contract.yaml`. If the project already has
`.dogfood/dogfood.contract.yaml`, that file is bound and not rewritten. A
human can edit the frozen YAML and run `/goal contract apply`. The worker
cannot.

Restart and crash recovery **continue** goals that were running (`active`,
`budget_limited`, or paused only as `interrupt` / leftover `recovery`).
User, plan, audit, and no-progress pauses stay paused. If SQLite is empty
after a crash, the plugin rehydrates from `.opencode/goals/<session>.json`.

## How the loop stops

The plugin continues once per idle, then waits for the next safe boundary.

It stops when:

- Dogfood / host proof and the independent judge both say `met` (`complete`)
- the judge returns `impossible`
- the worker reports `unmet` with a concrete blocker
- a token, turn, or duration budget is reached (`budget_limited`, after an 80% wrap-up)
- you `/goal pause` or `/goal clear`
- you send a message (default; opt in `steerWithoutPause`)
- two reserved continuation turns make no tool calls, or repeated low-output turns
- a child session is busy
- the session is in plan mode
- three prompt failures occur
- you interrupt the turn (Esc/abort); reopening the session or restarting
  OpenCode continues that goal automatically

## Completion is fail-closed

`update_goal { status: "complete" }` is not enough.

1. The frozen contract hash must still match the file bytes.
2. The bundled Dogfood CLI (`@proofofwork-agency/dogfood`) validates and runs the frozen contract. If that CLI cannot be resolved, `--check` / cited files are used.
3. The independent judge, in a separate no-tools session, must return `met`.

Other plugins can read `.opencode/goals/<sessionID>.json` without importing
this package.

## OpenCode 2 (beta)

The same plugin also runs inside OpenCode 2 beta. Add the **file path** of
the V2 entry module to your project config:

```json
{ "plugins": ["…/opencode-goal/dist/oc2.js"] }
```

The V2 module registers the `/goal` command plus the `create_goal`,
`update_goal`, `get_goal`, `goal_pause`, `goal_resume`, and `goal_clear`
tools, persists the same `.opencode/goal.sqlite` state, freezes dogfood
contracts, auto-continues idle sessions, and gates completion on evidence +
host proof. The independent judge side session is off by default on OC2
because the beta's `session.generate` returns empty text for long prompts;
everything else matches V1 behavior. See `docs/opencode2.md` for the
verified API map, limitations, and the live end-to-end smoke.

## Multiple goals and sequences

A session can hold more than one goal. Only the **focused** goal is
auto-continued; backgrounded goals stay paused until you focus them.

```
/goal add write the migration guide     # backgrounds the current goal, focuses the new one
/goal list                              # numbered goals; * marks the focused one
/goal focus 1                           # switch focus (activates a backgrounded goal)
```

`/goal <objective>` replaces only the focused goal; backgrounded goals are
kept. `/goal clear` still removes every goal in the session.

Ordered sequences queue objectives that auto-promote one at a time:

```
/goal sequence build the parser; write the tests; ship the release
```

The first objective is focused and active; the rest are queued (`paused`,
pause reason `queued`). When the focused goal completes with approved
evidence, the next queued goal is focused, activated, and started
automatically. Crash recovery never auto-resumes queued items; focus them
explicitly.

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
    "steerWithoutPause": false,
    "runHostChecks": true,
    "requireHostProof": true,
    "judge": true,
    "judgeModel": "anthropic/claude-sonnet-4-5",
    "defaultMaxTurns": 25,
    "defaultMaxDurationSeconds": 3600,
    "wrapupRatio": 0.8,
    "maxTurnTimeSeconds": 300,
    "restrictedAgents": ["plan"],
    "allowGoalExecutionFromPlan": false,
    "noToolTurnsBeforeSuppress": 2,
    "noProgressTokenThreshold": 50,
    "maxNoProgressTurns": 2,
    "checkTimeoutMs": 120000,
    "dogfood": true
  }
]
```

- `judgeModel` pins the independent judge (and contract author fallback model
  selection is unchanged) to a `provider/model` string; unset uses the session's
  current model.
- `noProgressTokenThreshold` / `maxNoProgressTurns` pause the loop after
  repeated continuation turns whose reported output tokens stay below the
  threshold. Output tokens are only counted when the host reports them; unknown
  output never triggers the pause.
- `maxTurnTimeSeconds` arms a watchdog that re-checks the session and retries
  continuation when a turn appears stuck; it never prompts while the session
  still reports busy. Off by default.
- `autoResumeInterrupted` also governs crash recovery: with `false`, goals
  paused by an interrupt stay paused across restarts.
- `--max-turns` is capped at 1000 and `--max-minutes` at 1440, matching the
  plugin-level option bounds.

State files are created `0600`. Add `.opencode/goal.sqlite*` and
`.opencode/goals/` to `.gitignore` if you do not want local runtime state
committed.

## Multiple processes

Only one OpenCode process may drive a session's goal. Each process claims the
session in `goal_locks` (owner UUID + pid, refreshed on every touch). A second
process that opens the same session becomes **passive** for that goal:

- `/goal status` and `/goal history` still work (reads are allowed).
- Mutations (`set`, `pause`, `resume`, `edit`, `clear`, completion tools)
  fail closed with the stable error `session_owned_elsewhere`.
- Auto-continue from the passive process is skipped with the reason
  `session-owned-elsewhere`; it never prompts or mutates the goal.

Locks expire 90 seconds after the last touch, or immediately when the owning
process has died (pid liveness check), with a 10-minute hard cap. Restart
recovery only takes over sessions whose owner is gone; it never steals a
live owner's session. After the owner exits, retry a goal command or fork the
session.

`@proofofwork-agency/dogfood` is a regular dependency of this package. Installing
the plugin installs the Dogfood CLI; users do not add it separately.

Dogfood is not on npm yet. This workspace pins
`file:../../../dogfood` and lists it in `bundleDependencies`, so a
published `opencode-goal` tarball still contains the CLI. When
`@proofofwork-agency/dogfood` is on the registry, switch the pin to that
version (for example `0.4.0`) and drop `bundleDependencies` if you no
longer need the tarball to carry a local copy.

## Development

```sh
bun test
bun run typecheck
bun run build
bun run benchmark
```

`bun run benchmark` runs a deterministic, provider-free behavior benchmark
(completion gating, contract tamper, loop safety, wrap-up, interrupt,
recovery, ownership, plan mode, multi-goal sequences) that exits non-zero
when any scenario fails. See `docs/comparison.md` for the scorecard against
other goal plugins.
