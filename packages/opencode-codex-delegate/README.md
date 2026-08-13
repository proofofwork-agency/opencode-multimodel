# opencode-codex-delegate

An OpenCode plugin that registers the locally authenticated OpenAI Codex CLI as a selectable provider and also exposes bounded delegation and native-review tools. It is a host adapter over [`codex-delegator`](../codex-delegator).

Current prerelease: **`0.2.0-alpha.0`**, validated with OpenCode **1.18.15**.
The package retains separate `./server` and `./tui` exports so OpenCode can load
both plugin surfaces through one installation.

## Install

Install the alpha channel by adding the tagged package to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-codex-delegate@alpha"]
}
```

For local development, use an absolute file URL or package path supported by your OpenCode version.

The plugin requires Bun 1.3 or newer plus an installed and authenticated `codex` CLI.

## Provider

On startup, the plugin calls Codex app-server's `account/read` and `model/list`, then registers a `codex-delegate` provider before OpenCode builds its provider catalog. The discovered models appear in `/models` and can be selected normally:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-codex-delegate@alpha"],
  "model": "codex-delegate/gpt-5.6-sol"
}
```

Provider calls implement AI SDK `LanguageModelV3` and are routed through `codex-delegator` to the local `codex app-server`. Authentication is whatever `codex account/read` reports. When the CLI is logged in with ChatGPT, usage goes through that Codex subscription; when it is configured with an API key, that API-key account is used instead. The plugin does not copy credentials into OpenCode.

Provider threads are persistent per OpenCode session and agent. Exact in-process retries of the same OpenCode message ID return the completed prior result instead of executing a write-capable Codex turn twice. Reasoning and text events stream into the OpenCode transcript, cancellation is forwarded, and Codex usage is translated to AI SDK usage.

The Codex app-server remains the agent runtime: it executes Codex CLI's own tools rather than OpenCode's tool or MCP registry. The registered models therefore advertise `tool_call: false` to prevent OpenCode from expecting client-executed tool calls.

Provider execution uses the same safe defaults as the delegate tools: write mode in a managed detached worktree with on-request escalation. To deliberately let the provider operate in the current checkout, opt in explicitly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-codex-delegate@alpha",
      {
        "isolation": "current",
        "approvalPolicy": "auto",
        "confirmedUnsafe": true
      }
    ]
  ],
  "model": "codex-delegate/gpt-5.6-sol"
}
```

With the default `ask` policy, Codex can work inside its sandbox but provider-mode escalation requests are rejected because the AI SDK provider interface has no OpenCode permission callback. The tool-based `codex_delegate` path does bridge those requests through OpenCode's `ask` API.

## Tools

- `codex_delegate`: run a persistent delegate turn; defaults to write mode in a managed detached worktree.
- `codex_review`: run native read-only review for uncommitted changes, a base branch, a commit, or custom instructions.
- `codex_status`: inspect an attached seat, including active turn kind and worktree.
- `codex_steer`: steer the currently active turn.
- `codex_cancel`: cancel the currently active turn.
- `codex_usage`: read Codex account usage and rate-limit buckets without starting a turn.
- `codex_close`: close a seat; cleanup (default true) drops the managed worktree and deletes the thread.
- `codex_probe`: report CLI version, authentication, transport capabilities, and available models.

OpenCode session IDs scope persisted seats, so the same seat name in two sessions does not share a Codex thread. App-server approval requests flow through OpenCode's `ask` permission API as `codex_command`, `codex_file`, or `codex_permissions`.

## Options

OpenCode supports plugin options through a `[package, options]` entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-codex-delegate@alpha",
      {
        "model": "gpt-5.6-sol",
        "mode": "write",
        "isolation": "worktree",
        "approvalPolicy": "ask",
        "timeoutMs": 300000,
        "stateDir": ".codex-delegate"
      }
    ]
  ]
}
```

Available runtime options are `executable`, `stateDir`, `model`, `mode`, `isolation`, `approvalPolicy`, `timeoutMs`, and `confirmedUnsafe`. Relative `stateDir` values resolve from the OpenCode project directory.

Provider-specific options are:

- `provider`: set to `false` to disable provider registration while retaining the tools.
- `tools`: set to `false` for provider-only operation.
- `providerId` and `providerName`: customize the provider key and display name.
- `providerModels`: add model IDs when `model/list` is unavailable.
- `providerProbeTimeoutMs`: bound startup discovery; defaults to 5 seconds.
- `contextWindow` and `outputTokens`: customize OpenCode's model metadata defaults.

`isolation: "current"` and `approvalPolicy: "bypass"` require `confirmedUnsafe: true`; keep this opt-in explicit because those settings allow the delegated process to affect the current checkout or bypass sandbox approval boundaries.

OpenCode calls the plugin's `dispose` hook on shutdown, and the shared tool/provider runtime closes every app-server process it owns. Deleting an OpenCode session also closes its attached provider and tool seats.

## Provider package entrypoint

The package exports `opencode-codex-delegate/provider` for hosts that want to configure the AI SDK provider manually. Normal OpenCode use should load the plugin: its config hook points OpenCode at the bundled provider entrypoint and supplies lifecycle-managed runtime state automatically.

## Alpha validation

The `0.2.0-alpha.0` release gate covers the server/TUI module shapes, provider
registration and streaming, idempotent retry behavior, approval bridging,
managed-worktree restart/resume, review, steering, cancellation, concurrency,
and a real combined OpenCode TEAM run. Provider-mode Codex owns its worktree;
`opencode-multimodel` intentionally does not wrap it in another OpenCode
workspace.
