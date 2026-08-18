# opencode-btw

Ephemeral `/btw` side questions for [OpenCode](https://opencode.ai).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-btw@alpha"]
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

Recent side exchanges stay in an in-memory, session-scoped history ring
(`/btw-history` or `ctrl+b`) that is cleared on exit.

## Options

```json
{
  "plugin": [
    ["opencode-btw@alpha", { "model": "small", "history": 20, "tool": true }]
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

- The side channel has **no tool access**: the `btw` agent disables built-in
  and known plugin tools, denies permissions, and is capped at one step.
- The parent session's storage is never written; cleanup is enforced by
  finally-delete, abort handlers, `session.deleted` hygiene, and `dispose()`.
- Nothing persists across restarts by design.
