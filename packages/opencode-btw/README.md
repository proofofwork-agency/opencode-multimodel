# @proofofwork-agency/opencode-btw

Ephemeral `/btw` side questions for [OpenCode](https://opencode.ai).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@proofofwork-agency/opencode-btw@alpha"]
}
```

Also add the same spec to `tui.json`. OpenCode loads server plugins from
`opencode.json` and TUI plugins from `tui.json`; `/btw` only exists if the TUI
entry loads.

`/btw` and `/side` run immediately even while the main session is busy. They
do not join the prompt queue.

## What it does

`/btw <question>` (alias `/side`) asks a one-shot, context-aware side question
about the current session:

1. Snapshots the parent session's recent messages into a bounded transcript.
2. Creates an ephemeral child session running a dedicated tool-less `btw`
   agent with a boundary prompt (inherited context is reference only).
3. Streams the answer into a dismissible TUI overlay while the main run
   continues untouched.
4. Deletes the child session. The question and answer never enter the parent
   transcript.

`/btw --send <question>` answers the same way, then merges the question and
answer into the parent session as a user message so the main agent can act
on it in its next turn. Without `--send` the exchange stays ephemeral.

`/btw --thread <question>` opens a multi-turn side conversation: the child
session survives between questions and follow-up `--thread` questions
continue it with full thread context (still tool-less and isolated).
`/btw --end` closes and deletes the thread.

An experimental OpenCode 2 (beta) entry exists at `opencode-btw/oc2`
(command + tools register; the beta's Code Mode runtime currently fails to
execute plugin tools — see docs/comparison.md).

Recent side exchanges stay in an in-memory, session-scoped history ring
(`/btw-history` or `ctrl+b`) that is cleared on exit.

> **Naming**: the package is published as `@proofofwork-agency/opencode-btw`
> because the unscoped npm name `opencode-btw` is taken by an unrelated
> hint-injection plugin. The plugin id and `/btw` command are unchanged.

## Options

```json
{
  "plugin": [
    ["@proofofwork-agency/opencode-btw@alpha", { "model": "small", "history": 20, "tool": true }]
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `model` | `"inherit"` | `inherit` uses the parent session's model, `small` uses `small_model`, or set an explicit `provider/model` |
| `maxMessages` | `40` | Snapshot message budget (5–200) |
| `maxChars` | `48000` | Snapshot character budget (5k–200k) |
| `maxOutputTokens` | `2048` | Answer clamp for side responses (256–8192) |
| `timeoutMs` | `60000` | Abort and delete the child after this long (1s–300s) |
| `history` | `10` | Session-scoped history ring size; `0` disables (0–50) |
| `concurrency` | `1` | In-flight side questions per session (1–3) |
| `tool` | `false` | Expose a `btw` tool to the main agent (the tool call itself lands in the transcript; the answer still comes from the tool-less child) |
| `notify` | `false` | Attention notification when a side answer completes |

Invalid values fall back to defaults; unknown keys are ignored.

## Design boundaries

See `docs/comparison.md` for the feature-by-feature scorecard against
`opencode-bytheway` and the other side-question plugins.

- The side channel has **no tool access**: the `btw` agent disables built-in
  and known plugin tools, denies permissions, and is capped at one step.
- The parent session's storage is never written; cleanup is enforced by
  finally-delete, abort handlers, `session.deleted` hygiene, and `dispose()`.
- Nothing persists across restarts by design.
