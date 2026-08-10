# opencode-multimodel

Multi-model fleets, collaboration modes, and declarative workflows for original [OpenCode](https://github.com/anomalyco/opencode).

Current prerelease: **`0.2.0-alpha.0`**, validated with OpenCode **1.18.15**.

This package has two surfaces:

- `opencode-multimodel/core` is a reusable orchestration library with an injected `AgentRunner`.
- `opencode-multimodel/server` and `opencode-multimodel/tui` are OpenCode plugin entrypoints. OpenCode resolves them automatically from one installed package.

The collaboration behavior is adapted from the tested Poly orchestration engine, but this package has no Poly runtime dependency. It uses only OpenCode's public plugin and SDK APIs.

## What it adds

- `/lead` selects the model that owns assignments, synthesis, and verdicts.
- `/fleet` opens a dedicated fleet screen.
- `/collab` runs `lead`, `pair`, `round`, `council`, `orchestrate`, `handoff`, `panel`, `deliberate`, or `jury` mode.
- `/workflow` selects and runs a saved DAG or confined script workflow.
- `/mode` and the clickable composer badge select `SINGLE`, `TEAM`, or
  `WORKFLOW` without replacing OpenCode's native prompt implementation.
- `/workflows`, `/runs`, and `/graph` expose definitions, the durable event
  ledger, live run status, and fleet routing.
- Server tools provide explicit fleet, collaboration, run-control, and
  workflow capabilities in API/headless OpenCode sessions.

Each fleet seat runs in its own child OpenCode session. Parallel modes therefore use multiple provider models at the same time, subject to the providers' own concurrency and rate limits.

## Install

Install the alpha channel from npm:

```json
{
  "plugin": [
    [
      "opencode-multimodel@alpha",
      {
        "databasePath": ".opencode/multimodel.sqlite",
        "defaultMode": "council",
        "maxWorkers": 8,
        "maxParallel": 3,
        "composer": {
          "enabled": true,
          "initial": "single",
          "autoRoute": false
        },
        "workflows": {
          "scripts": false,
          "directories": [".opencode/workflows"],
          "timeoutMs": 300000,
          "maxAgentCalls": 64
        },
        "retention": {
          "runs": 100,
          "events": 10000
        }
      }
    ]
  ]
}
```

OpenCode loads the package's separate `./server` and `./tui` exports. The server entry registers tools and command templates; the TUI entry registers slash commands and additional screens.

On first use, the plugin creates `.opencode/multimodel.sqlite` with SQLite WAL,
a busy timeout, transactions, and file mode `0600`. It adds one default model
from each connected provider. The database stores fleet configuration, composer
modes, definitions, runs, steps, agent calls, child sessions, preserved
workspaces, leases, and an append-only event ledger. It never stores provider
credentials, tokens, or environment variables.

An existing `.opencode/multimodel.json` is imported once and left untouched.
The deprecated `statePath` option can point at another JSON import source.
Unfinished expired runs become `interrupted`; resume is always explicit.
Retention removes only older terminal runs, never active runs.

You can provide an explicit fleet in plugin options:

```json
{
  "plugin": [
    [
      "opencode-multimodel@alpha",
      {
        "fleet": {
          "leadID": "claude",
          "members": [
            {
              "id": "claude",
              "role": "lead reviewer",
              "model": {
                "providerID": "anthropic",
                "modelID": "claude-sonnet-4-5"
              },
              "agent": "plan",
              "enabled": true,
              "isolation": "shared"
            },
            {
              "id": "codex",
              "role": "implementation specialist",
              "model": {
                "providerID": "codex-delegate",
                "modelID": "gpt-5.6-sol"
              },
              "agent": "plan",
              "enabled": true,
              "isolation": "worktree"
            }
          ]
        }
      }
    ]
  ]
}
```

## Codex delegate participation

The multi-model plugin treats every seat as an ordinary OpenCode `{ providerID, modelID }` selection. A delegate can participate directly when its plugin exposes Codex as a real OpenCode provider, for example `codex-delegate/gpt-5.6-sol`.

Authentication and billing remain the delegate provider's responsibility. If that provider uses the Codex CLI subscription session, child fleet calls use the same subscription path and share its rate limits. This plugin does not convert API-key billing into subscription usage or bypass provider limits.

A tool-only delegate cannot be selected as a fleet model. It must expose a provider/model pair first.

## Collaboration modes

| Mode                   | Execution                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `lead`                 | Lead answers alone.                                                                     |
| `pair`                 | Lead plans, one worker responds, lead synthesizes.                                      |
| `handoff`              | Lead gives one explicit task to a selected worker, then resumes ownership.              |
| `round`                | Selected seats contribute sequentially in roster order.                                 |
| `council`              | Workers produce independent views in parallel; lead synthesizes.                        |
| `orchestrate`          | Lead emits a bounded `TASKS` plan, assigned workers run concurrently, lead synthesizes. |
| `panel` / `deliberate` | One structured ballot round; lead judges.                                               |
| `jury`                 | Two structured ballot rounds with rebuttal; lead judges.                                |

All modes enforce a model-call budget. Worker failures are preserved in council/orchestrate output so a healthy lead can still synthesize. Nested multi-model and Codex-delegate orchestration tools are disabled inside child sessions, while ordinary OpenCode implementation tools remain available. Runs may be foreground or background and can be inspected, steered, cancelled, or explicitly resumed through `multimodel_run`.

## Workflows

`kind: "dag"` workflows are safe JSON dependency graphs. The `kind` may be
omitted for compatibility with definitions saved by `0.1.x`.

Save a definition with the `multimodel_workflow` tool using `action: "save"` and JSON like:

```json
{
  "kind": "dag",
  "name": "implementation-review",
  "description": "Research and review in parallel, then merge",
  "maxParallel": 2,
  "synthesize": true,
  "steps": [
    {
      "id": "research",
      "memberID": "claude",
      "prompt": "Research the safest implementation for ${input}"
    },
    {
      "id": "tests",
      "memberID": "codex",
      "prompt": "Design tests for ${input}"
    },
    {
      "id": "merge",
      "needs": ["research", "tests"],
      "prompt": "Merge these findings:\n${research}\n\n${tests}"
    }
  ]
}
```

Steps become runnable when all dependencies finish. Ready steps run with bounded concurrency. `${input}` and `${step-id}` placeholders are interpolated from the workflow input and prior step results. Cycles, duplicate IDs, missing dependencies, and more than 64 steps are rejected before execution.

Experimental `kind: "script"` workflows are disabled by default. When
`workflows.scripts` is enabled, source runs in the bundled tree-walking
interpreter—not `eval`, `Function`, Node, or Bun. The accepted
JavaScript/TypeScript-style expression surface contains only `args`, `agent`,
`parallel`, `pipeline`, `phase`, and `log`:

```json
{
  "kind": "script",
  "name": "independent-review",
  "source": "export default async ({ agent, parallel }) => parallel([agent({ prompt: 'Review security', memberID: 'claude' }), agent({ prompt: 'Review tests', memberID: 'codex' })])"
}
```

Imports, filesystem/network access, `process`, `Bun`, host globals, dynamic
evaluation, and prototype traversal are rejected. Source is limited to 500 kB,
64 agent calls, six parallel calls, and a five-minute default timeout. OpenCode
permission is bound to `<workflow>:<normalized-source-sha256>`, so editing source
requires new permission. Resume reuses only the exact contiguous call prefix
whose index, prompt, model/agent options, and isolation still match.

Use `multimodel_workflow` to pause at a safe boundary, resume, stop active child
sessions, or restart an agent step. Worktrees remain available for inspection
until `multimodel_run` performs explicit `cleanup-workspaces`; the plugin never
auto-merges them.

## Native composer

The TUI registers replace-slots for the home and session composers but renders
OpenCode's own `api.ui.Prompt` inside them. `SINGLE` calls native submit without
modification. `TEAM` rewrites ordinary input to `/collab <mode> …`, and
`WORKFLOW` rewrites it to `/workflow <name> …`. Attachments remain on the native
prompt object. Shell mode, existing slash commands, and leading `@` input are
never rewritten.

`composer.autoRoute` defaults to `false`. When enabled, explicit multi-model
language selects TEAM and only an exact `workflow:<saved-name>` or
`workflow <saved-name>` reference selects WORKFLOW. The visible badge remains a
manual override. API/headless calls do not infer intent; use commands and tools
explicitly.

## Reusable core

```ts
import {
  collaborate,
  type AgentRunner,
  type Fleet,
} from "opencode-multimodel/core";

const runner: AgentRunner = {
  async run(input) {
    // Call any model runtime and return an AgentReply.
  },
};

const result = await collaborate(
  runner,
  fleet satisfies Fleet,
  "parent-session",
  "Review this change",
  {
    mode: "jury",
    maxParallel: 3,
  },
);
```

`OpenCodeAgentRunner` is also exported for hosts that want the provided child-session adapter.

## Safety and current host limits

- Fleet members default to `isolation: "shared"`. `isolation: "worktree"` uses
  OpenCode's experimental workspace API and fails closed if creation is
  unavailable; it never silently falls back to the shared checkout.
- `codex-delegate` retains its own worktree ownership, so the multimodel adapter
  does not create a nested OpenCode worktree for that provider.
- Server tool runs request OpenCode permission before starting multi-model calls.
- TUI mode routing is visible in the clickable composer badge and `/mode`.
- The plugin does not patch OpenCode and does not require the Poly fork.

OpenCode 1.18.15's established server/TUI plugin API remains the integration
surface because it provides custom tools, replace-slots, routes, keymaps, and
native Prompt access. The newer v2 client is used for explicit server/headless
connections, but does not yet replace those host capabilities. The plugin keeps
the two entrypoints separate so this can evolve without a package split.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

The test suite covers SQLite concurrency/migration/idempotency/recovery and
retention, composer routing and bypasses, collaboration ordering and
cancellation, DAG pause/resume, confined-script escapes/hash/timeout/budgets,
child-session restart reuse, worktree fail-closed behavior and cleanup, provider
discovery, and separate server/TUI module shapes.

The `0.2.0-alpha.0` live gate additionally installs the delegate and multi-model
plugins one at a time with OpenCode's installer, runs a real TEAM `pair` across
OpenAI and Codex, verifies durable child-session and Codex-thread reuse after a
process restart, and confirms that delegate isolation creates only the delegate's
managed worktree rather than a nested OpenCode workspace.
