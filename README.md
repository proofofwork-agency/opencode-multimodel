# opencode-multimodel

Multi-model fleets, collaboration modes, and declarative workflows for original [OpenCode](https://github.com/anomalyco/opencode).

This package has two surfaces:

- `opencode-multimodel/core` is a reusable orchestration library with an injected `AgentRunner`.
- `opencode-multimodel/server` and `opencode-multimodel/tui` are OpenCode plugin entrypoints. OpenCode resolves them automatically from one installed package.

The collaboration behavior is adapted from the tested Poly orchestration engine, but this package has no Poly runtime dependency. It uses only OpenCode's public plugin and SDK APIs.

## What it adds

- `/lead` selects the model that owns assignments, synthesis, and verdicts.
- `/fleet` opens a dedicated fleet screen.
- `/collab` runs `lead`, `pair`, `round`, `council`, `orchestrate`, `handoff`, `panel`, `deliberate`, or `jury` mode.
- `/workflow` selects and runs a saved declarative DAG workflow.
- `/workflows` opens workflow definitions and run history.
- Server tools provide the same capabilities in non-TUI OpenCode sessions.

Each fleet seat runs in its own child OpenCode session. Parallel modes therefore use multiple provider models at the same time, subject to the providers' own concurrency and rate limits.

## Install

Until the package is published, install it from GitHub:

```json
{
  "plugin": [
    [
      "github:proofofwork-agency/opencode-multimodel",
      {
        "defaultMode": "council",
        "maxParallel": 3,
        "maxWorkers": 8
      }
    ]
  ]
}
```

OpenCode loads the package's separate `./server` and `./tui` exports. The server entry registers tools and command templates; the TUI entry registers slash commands and additional screens.

On first use, the plugin creates `.opencode/multimodel.json` and adds one default model from each connected provider. Use `/lead` to select the lead. Fleet state, workflow definitions, and the last 100 workflow runs are shared through that file.

You can provide an explicit fleet in plugin options:

```json
{
  "plugin": [
    [
      "opencode-multimodel",
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
              "enabled": true
            },
            {
              "id": "codex",
              "role": "implementation specialist",
              "model": {
                "providerID": "codex-delegate",
                "modelID": "gpt-5.6-codex"
              },
              "agent": "plan",
              "enabled": true
            }
          ]
        }
      }
    ]
  ]
}
```

## Codex delegate participation

The multi-model plugin treats every seat as an ordinary OpenCode `{ providerID, modelID }` selection. A delegate can participate directly when its plugin exposes Codex as a real OpenCode provider, for example `codex-delegate/gpt-5.6-codex`.

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

All modes enforce a model-call budget. Worker failures are preserved in council/orchestrate output so a healthy lead can still synthesize. Recursive multi-model tools are disabled inside child sessions.

## Declarative workflows

Workflows are JSON DAGs. They do not execute generated JavaScript.

Save a definition with the `multimodel_workflow` tool using `action: "save"` and JSON like:

```json
{
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

- Parallel seats can share a project directory. Use OpenCode's read-only/plan agent for reviewers, and avoid assigning simultaneous write work to overlapping files.
- Server tool runs request OpenCode permission before starting multi-model calls.
- TUI runs are explicit user actions from `/collab` or `/workflow`.
- Original OpenCode does not expose a plugin hook that transparently replaces every prompt on the default session screen. Collaboration therefore runs through the plugin commands/tools and dedicated screens rather than silently intercepting normal prompts.
- The plugin does not patch OpenCode and does not require the Poly fork.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

The test suite covers collaboration ordering and concurrency, jury voting, call budgets, task parsing, workflow DAG validation/runtime behavior, OpenCode child-session reuse, provider discovery, and separate server/TUI plugin module shapes.
