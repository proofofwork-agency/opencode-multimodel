# OpenCode packages

This repository is the Proof of Work OpenCode monorepo. It contains three independent public packages:

| Package | Purpose | Alpha install |
| --- | --- | --- |
| [`opencode-multimodel`](./packages/opencode-multimodel) | Multi-model fleets, collaboration modes, and declarative workflows for OpenCode. | `bun add opencode-multimodel@alpha` |
| [`codex-delegator`](./packages/codex-delegator) | Reusable Bun library for driving a locally authenticated Codex CLI. | `bun add codex-delegator@alpha` |
| [`opencode-codex-delegate`](./packages/opencode-codex-delegate) | OpenCode plugin and provider backed by `codex-delegator`. | `bun add opencode-codex-delegate@alpha` |

All packages are configured to publish on npm under the `alpha` dist-tag. Once released, OpenCode plugin configuration should keep that tag explicit while the APIs are pre-release:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-multimodel@alpha",
    "opencode-codex-delegate@alpha"
  ]
}
```

The Codex packages use the locally installed Codex CLI. Authentication remains owned by that CLI; this repository does not contain, copy, or publish Codex credentials.

## Development

```sh
bun install
bun run typecheck
bun run test
bun run build
```

Run `bun run publish:alpha` only after the full verification succeeds and npm authentication is configured. The script publishes `codex-delegator` first so the dependent OpenCode plugin can resolve it.
