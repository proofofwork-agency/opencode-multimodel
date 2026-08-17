# OpenCode packages

This repository is the Proof of Work OpenCode monorepo. It contains independent public packages:

Current prerelease: **`0.2.0-alpha.0`** for all packages. The alpha has
been built and exercised against OpenCode **1.18.15**. Keep the npm `alpha`
dist-tag explicit until the APIs graduate from prerelease.

| Package | Purpose | Alpha install |
| --- | --- | --- |
| [`opencode-multimodel`](./packages/opencode-multimodel) | Durable TEAM/WORKFLOW fleets, collaboration modes, dashboards, and workflows for OpenCode. | `bun add opencode-multimodel@alpha` |
| [`opencode-goal`](./packages/opencode-goal) | Persisted `/goal` runtime that continues a session until evidence-backed completion. | `bun add opencode-goal@alpha` |
| [`codex-delegator`](./packages/codex-delegator) | Reusable Bun library for driving a locally authenticated Codex CLI; this is the shared runtime, not an OpenCode plugin. | `bun add codex-delegator@alpha` |
| [`opencode-codex-delegate`](./packages/opencode-codex-delegate) | OpenCode plugin, tools, and selectable AI SDK provider backed by `codex-delegator`. | `bun add opencode-codex-delegate@alpha` |
| [`opencode-btw`](./packages/opencode-btw) | Ephemeral `/btw` side questions for OpenCode sessions without polluting the main transcript. | `bun add opencode-btw@alpha` |

All packages are configured to publish on npm under the `alpha` dist-tag. Once released, OpenCode plugin configuration should keep that tag explicit while the APIs are pre-release:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-multimodel@alpha",
    "opencode-goal@alpha",
    "opencode-codex-delegate@alpha",
    "opencode-btw@alpha"
  ]
}
```

## Successor to Poly

`opencode-multimodel` and `opencode-codex-delegate` supersede the standalone
[Poly OpenCode fork](https://github.com/proofofwork-agency/thinktank/tree/main/concepts/poly).
Poly is retained only as a historical ThinkTank concept; new OpenCode
integrations should use these plugins. Both plugins and the supporting
`codex-delegator` library are still alpha-stage and have not yet been published
to npm.

OpenCode discovers separate `./server` and `./tui` entrypoints for both plugin
packages. `opencode-codex-delegate` registers `codex-delegate/<model>` selections;
`opencode-multimodel` can use those models as ordinary fleet seats without
creating a second nested worktree.

The Codex packages use the locally installed Codex CLI. Authentication remains owned by that CLI; this repository does not contain, copy, or publish Codex credentials.

## Alpha validation

The `0.2.0-alpha.0` release gate covers unit and integration tests, package
typechecks and builds, npm tarball inspection, SQLite recovery/concurrency,
composer routing, workflow sandbox boundaries, worktree fail-closed behavior,
real Codex app-server delegation, and a combined OpenCode 1.18.15 TEAM run with
child-session and Codex-thread reuse after restart. Live Codex tests remain
opt-in because they consume an authenticated local account.

## Development

```sh
bun install
bun run verify
```

Run `bun run publish:alpha` only after the full verification succeeds and npm authentication is configured. The script publishes `codex-delegator` first so the dependent OpenCode plugin can resolve it.
