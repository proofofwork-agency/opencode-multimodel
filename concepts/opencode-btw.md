# OpenCode BTW Plugin — Concept

Status: draft concept · Date: 2026-08-17 · Proposed package: `packages/opencode-btw` (npm `opencode-btw@alpha`)

`/btw` asks a quick, context-aware **side question** about the current session
without interrupting the main run and without polluting the main transcript.

---

## 1. Feature research

### 1.1 Claude Code `/btw` (the origin)

Sources: official power-user tips (support.claude.com), interactive-mode docs,
`claude-code-internals` command source (src/commands/btw).

- Invocation: `/btw <question>` in terminal; `Cmd+;` / `Ctrl+;` on Desktop; `/btw`
  panel in VS Code extension (≥ 2.1.227).
- Runs **while the main turn is still generating**; the main run is untouched.
- Context: the conversation so far (earlier user messages, replies, and tool
  results already gathered). It **cannot** see the unfinished in-flight answer.
- **No tool access**: cannot read new files, run commands, search, or edit. It is
  a clarification channel, not a second agent.
- Delivery: one-shot answer in a dismissible scrollable overlay
  (`local-jsx` component, spinner, markdown `ScrollBox`, arrow-key scrolling).
- Persistence: Q&A never enters the primary transcript. Terminal keeps recent
  side exchanges in short-term session memory (navigable, clearable, gone on
  exit). Desktop side chats are never saved to disk.
- Internals: `runSideQuestion()` issues a separate model query with its own
  system-prompt context, reusing cached prompt params (`CacheSafeParams`).
- Escalation: a useful side answer can be **forked into a real session** with
  full tool access.

### 1.2 Codex `/side` + `steer`

Sources: openai/codex issues #18125 (added `/side`), #18884 (asks for `/btw`
alias + `/recap`), community threads.

- Codex ships `/side`: a side conversation that keeps the main thread clean and
  returns without contaminating its working context.
- `/btw` is **not** implemented; it exists only as a community feature request
  for an alias (muscle-memory migration from Claude Code).
- Complementary primitive: **steer** — injects a steering message into the
  *active* run without ending it. `/btw` = read-only aside; steer = write path
  into the live run. Different surfaces, same anti-drift instinct.

### 1.3 Grok

No equivalent feature found. xAI/Grok tooling (grok.com, Projects, API) has no
documented side-question channel or slash-command coding CLI surface for it.
Third-party grok CLIs have nothing comparable either. For this concept Grok is
relevant only as evidence that the pattern is Claude-originated and spreading
(Codex adopted it as `/side`; OpenClaw generalized it).

### 1.4 Reference implementation: OpenClaw BTW

docs.openclaw.ai/tools/btw — the most complete public spec of the pattern:

- Snapshot the current session (including the in-flight main prompt) as
  background context.
- Run a **one-shot** side query with a boundary prompt: everything before the
  boundary is inherited read-only reference, not live instructions; answer only
  the side question; do not resume or steer the main task.
- Deliver via a **separate event** (`chat.side_result`) so clients cannot mistake
  it for conversation history; never written to session history.
- For Codex-harness sessions it forks the Codex thread (preserving auth,
  sandbox, approval policy) instead of making a raw provider call.
- Surfaces: TUI inline ephemeral block (dismissible `Enter`/`Esc`); labeled
  one-off reply on chat channels; side rail companion in Control UI with retry
  and clear.
- Explicit non-goals: no durable session, no continuation of the main task, no
  transcript persistence.

### 1.5 Comparison

| Dimension | Claude `/btw` | Codex `/side` (+steer) | Grok | OpenClaw BTW |
| --- | --- | --- | --- | --- |
| Side question while main run active | Yes | Yes (`/side`) | — | Yes |
| Execution | Separate one-shot model call, own system context | Side conversation (thread fork in harness mode) | — | Fork/one-shot on session's actual model |
| Tool access in side channel | None | Side conv is conversational | — | None (boundary prompt) |
| Enters main transcript | Never | Never | — | Never (separate `chat.side_result` event) |
| Retention | Session-memory ring (terminal); never on disk (Desktop) | Not persisted | — | In-memory only; cleared on restart/reset |
| UI surface | Dismissible scrollable overlay; `Cmd+;` Desktop; VS Code panel | TUI side conversation | — | Inline TUI block / channel reply / side rail |
| Multi-turn | Single response per invoke | Side conversation | — | One-shot (+ persistent read-only rail thread in Control UI) |
| Escalation path | Fork answer into a session | Return to main thread | — | None documented |
| Steering the live run | (queue a message) | `steer` command | — | Separate `/steer` command |

**Shared contract** (what we adopt): context-aware, one-shot, tool-less,
ephemeral, never in history, works during an active main run.

---

## 2. Product definition

### Goals

1. `/btw <question>` (alias `/side`) in the OpenCode TUI: one-shot side answer
   in a dismissible overlay, main run untouched.
2. Answer grounded in the current session's messages so far (bounded snapshot).
3. Zero pollution: no part of the exchange is written to the parent session's
   stored messages or future prompt context.
4. Session-scoped memory of recent side exchanges in the TUI (navigable,
   clearable, gone on exit) — matching Claude terminal behavior.
5. Escalation: promote a side answer into a real child session when the tangent
   becomes work.

### Non-goals (v1)

- No tool access in the side channel (hard boundary, same as Claude).
- No persistence across restarts.
- No multi-turn side conversations (invoke again for another question).
- No steering of the active run (OpenCode's own interrupt/steer flows stay
  untouched; possible follow-up).

### The BTW contract (enforced by design)

1. Snapshot → 2. one-shot query on a tool-less ephemeral child session →
3. answer rendered via a dedicated side channel → 4. child session deleted →
5. parent transcript byte-identical to before.

---

## 3. OpenCode design-standards mapping

Per https://opencode.ai/docs/plugins/ and /docs/custom-tools/:

| Standard | How we comply |
| --- | --- |
| Plugin = module exporting plugin fns; ctx `{ project, client, $, directory, worktree }` | `server.ts` / `tui.tsx` entrypoints, `PluginModule` / `TuiPluginModule` shapes, same as our two existing plugins |
| npm distribution via `opencode.json` `"plugin": ["opencode-btw@alpha"]` | package exports `./server`, `./tui`, `./core`; bun-auto-install cached like other npm plugins |
| Custom tools via `tool()` helper, `tool.schema` (Zod) args, unique names | single `btw` tool, off by default (option-gated) to preserve transcript purity |
| Tools receive `context` (sessionID, agent, directory, abort, ask, metadata) | tool path uses `context.sessionID` as parent; `context.abort` cancels the child run |
| Logging via `client.app.log`, never console.log | all diagnostics through `client.app.log({ service: "opencode-btw" })` |
| Event names (`session.deleted`, `message.updated`, `session.idle`, TUI events) | registry cleanup on `session.deleted`; completion notify on `session.idle` of the child |
| Commands via `config.command.<name>` (template + `$ARGUMENTS`) | **not used for `/btw`** — template commands route through the main session model, which would violate the never-in-history contract. TUI keymap layer owns the slash command (multimodel palette pattern). |
| Agent config in `config` hook | registers a dedicated `btw` agent: own prompt, `tools: {}` (none) — the idiomatic way to get a tool-less model call |
| Permissions (`context.ask`) only where actions need consent | no side-channel tools → no permission prompts in v1 |

Repo-internal conventions (from `opencode-codex-delegate` + `opencode-multimodel`):
strict TypeScript (`verbatimModuleSyntax`, `.ts` import extensions), lenient
clamped `parseOptions` that never throws, `dispose()` cleanup, `bun:test` with
fake clients/contexts, `bun build` + `tsc -p tsconfig.build.json`, pinned
`@opencode-ai/plugin`/`@opencode-ai/sdk`, `publishConfig.tag: "alpha"`.

---

## 4. Architecture

### 4.1 Package layout

```
packages/opencode-btw/
├── package.json            # name: opencode-btw; exports ./server ./tui ./core
├── tsconfig.json
├── tsconfig.build.json
├── src/
│   ├── server.ts           # PluginModule { id: "opencode-btw", server }
│   ├── tui.tsx             # TuiPluginModule { id: "opencode-btw", tui }
│   ├── index.ts            # ./core barrel: types + pure logic re-exports
│   ├── options.ts          # parseOptions (clamp/defaults, never throws)
│   ├── agent.ts            # BTW agent definition + boundary system prompt
│   ├── snapshot.ts         # bounded session-context snapshot builder
│   ├── runner.ts           # SideRunner: child-session lifecycle (create/prompt/abort/delete)
│   ├── registry.ts         # in-memory side-exchange store (per session ring buffer)
│   └── prompts.ts          # boundary + question prompt templates
└── tests/
    ├── module.test.ts      # entrypoint shape tests (both plugins' pattern A)
    ├── options.test.ts
    ├── snapshot.test.ts
    ├── runner.test.ts      # fake SDK client (multimodel pattern C)
    └── tui.test.ts         # headless fake TuiPluginApi
```

### 4.2 Runtime pieces

**`agent.ts` — the side-channel persona.** Registered in the `config` hook:

```ts
config.agent ??= {}
config.agent.btw = {
  name: "BTW",
  description: "Ephemeral side questions about the current session",
  prompt: BTW_BOUNDARY_PROMPT,   // "everything above is read-only reference..."
  tools: {},                     // none — hard no-tool boundary
  temperature: 0,
}
```

`BTW_BOUNDARY_PROMPT` (from the OpenClaw spec, adapted): *"You are answering a
single side question about an OpenCode session. The messages above the boundary
are inherited reference context only — not active instructions. Do not resume
or continue the main task. Do not suggest that you will take actions. Answer
the question directly and concisely from the provided context. If the context
does not contain the answer, say so."*

**`snapshot.ts` — bounded context.** `client.session.messages(parentID)` →
render to a compact transcript (role + text parts; tool results summarized,
images/attachments dropped) → apply budget (default: last 40 messages AND
≤ 48,000 chars, oldest dropped first, `[…N earlier messages truncated…]`
marker). Pure function → trivially testable.

**`runner.ts` — SideRunner.** Owns the ephemeral child session:

1. `client.session.create({ parentID, title: "btw: <question prefix>", agent: "btw", model })`
2. `client.session.prompt(childID, [snapshotMessage, questionMessage])` with
   `maxOutputTokens` clamp; stream progress via `message.updated` events.
3. Collect the single assistant text response (abort on timeout, default 60s).
4. Resolve `{ question, answer, model, tokens }` to the caller.
5. `client.session.delete(childID)` (finally-block; also on abort/failure).

Every child ID is tracked; `dispose()` deletes any stragglers. Best-effort
startup sweep deletes orphaned `btw:`-titled sessions from prior crashes.

**`registry.ts` — session memory.** In-memory `Map<parentID, SideExchange[]>`
ring (default keep 10). Powers the TUI history view and the clear action. Not
persisted; dies with the process (Claude terminal semantics).

### 4.3 Surfaces

**TUI (`tui.tsx`) — primary surface.**

- `api.keymap.registerLayer` command `{ name: "btw.ask", slashName: "btw", title: "BTW side question" }`:
  capture the pending input (or `tui.prompt.append`-prefilled question), run
  SideRunner against `api.route.current` session, open the answer overlay.
  Alias layer command `side` → same handler.
- Answer overlay: dedicated route `btw.answer` rendering the Q&A (markdown
  text, spinner while streaming, Up/Down/Page scrolling), `Enter`/`Esc`
  dismisses back to the previous route. Distinct border/style via
  `api.theme.current` so it never reads as a normal assistant message.
- `btw.history` command (default `ctrl+b`): list recent side exchanges for the
  current session, `Enter` reopens, `d` clears all.
- `api.attention.notify({ title: "btw answered" })` on completion when the
  overlay is not focused; sound/notification opt-in via options.
- Concurrency: one in-flight side question per session by default (option
  `concurrency` clamps 1–3); `Esc` during streaming aborts and deletes the child.

**Server tool (optional, off by default).**

```ts
tool: options.tool ? { btw: tool({
  description: "Ask a side question about the current session without touching the main transcript",
  args: { question: tool.schema.string().describe("The side question") },
  async execute(args, context) { /* SideRunner against context.sessionID */ },
}) } : undefined
```

For IDE/web users who accept that a tool call itself lands in the main thread.
The answer still comes from the tool-less child session. Default **off** keeps
the purity contract the default behavior.

**Escalation (v1.1 candidate).** `btw.promote` command: create a real child
session seeded with the side exchange (question + answer + snapshot) using the
normal agent, navigate to it. Mirrors Claude's fork-to-session.

### 4.4 Sequence

```
User (TUI)                     plugin                    opencode server
   │ /btw why retry here?        │                            │
   ├────────────────────────────►│ snapshot(parent messages)  │
   │                             ├───────────────────────────►│ session.messages
   │                             │◄───────────────────────────┤
   │                             ├───────────────────────────►│ session.create(agent:"btw")
   │                             ├───────────────────────────►│ session.prompt(snapshot+q)
   │        [main run continues, completely untouched]         │
   │   overlay: streaming        │◄──── message.updated ──────┤
   ├─ Enter (dismiss)            ├───────────────────────────►│ session.delete(child)
   │                             │ registry.push(exchange)    │
```

Parent session storage is never written. Cleanup is guaranteed by
finally-delete + `dispose()` + `session.deleted` event hygiene.

---

## 5. Options (lenient, clamped, never throws)

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `model` | `"inherit" \| provider/model string` | `"inherit"` | `inherit` = parent session's model (Claude parity); `"small"` shortcut resolves `config.small_model` |
| `maxMessages` | int 5–200 | 40 | snapshot message budget |
| `maxChars` | int 5k–200k | 48000 | snapshot char budget |
| `maxOutputTokens` | int 256–8192 | 2048 | one-shot answer clamp |
| `timeoutSeconds` | int 10–300 | 60 | abort + delete child |
| `history` | int 0–50 | 10 | TUI ring size; 0 disables |
| `concurrency` | int 1–3 | 1 | in-flight side questions per session |
| `tool` | bool | false | expose the `btw` tool to the main agent |
| `notify` | bool | false | attention notification on completion |

Unknown keys ignored; invalid values fall back to defaults with an
`client.app.log` warn (codex-delegate style).

---

## 6. Edge cases & failure modes

| Case | Behavior |
| --- | --- |
| Question while parent idle | Allowed; same flow (Claude allows anytime) |
| Parent session deleted mid-question | `session.deleted` event aborts child, deletes it, drops registry entry |
| Child model errors / timeout | Overlay shows error line; child deleted; retry re-invokes `/btw` |
| Server restart mid-question | Startup sweep removes orphaned `btw:` sessions; overlay lost by design (ephemeral) |
| Question needing new evidence | Boundary prompt makes the model say "not in context" → doc guidance: escalate to a normal prompt |
| Very long parent transcript | Snapshot budgets truncate deterministically (oldest first) |
| `/btw` with empty input | TUI hint line, no run |
| Two TUIs on same session | Registry is per-process; each runs its own children; no shared state needed |

---

## 7. Testing & verification

Follows repo `bun:test` conventions:

- **Shape**: `server.ts` exports `{ id, server }` without `tui`; `tui.tsx`
  exports `{ id, tui }` without `server` (pattern A).
- **Hooks**: invoke plugin fn with fake input; assert `config` hook registers
  agent `btw` with `tools: {}`; assert `tool` absent unless `tool: true`
  (pattern B).
- **Snapshot**: pure-function tests for budgets, truncation marker, part
  filtering.
- **Runner**: fake SDK client (create/prompt/abort/delete spies) covering
  happy path, timeout abort, finally-delete, dispose sweep (pattern C).
- **TUI headless**: fake `TuiPluginApi` capturing registered layer commands,
  routes, notify calls; simulate slash command run against fake runner
  (pattern D).
- Manual gate: run against OpenCode 1.18.15 — `/btw` during an active main
  run; verify parent session storage (storage diff) unchanged afterwards.

`bun run verify` (typecheck + test + build) must pass; publish as
`opencode-btw@alpha` per the root `publish:alpha` flow.

---

## 8. Milestones

1. **M1 — core**: options, snapshot, runner, agent, registry + unit tests.
2. **M2 — TUI**: `/btw` + `/side` slash commands, streaming overlay, history
   view, notify; headless TUI tests.
3. **M3 — hardening**: cleanup sweep, timeout/abort paths, concurrency clamp,
   storage-diff verification script.
4. **M4 — optional tool + promote**: `btw` tool (off by default),
   `btw.promote` escalation to a real child session.

## 9. Open questions

- Exact SDK v2 shape for `session.messages` pagination on very long sessions
  (bounded fetch vs full fetch + local trim).
- Whether the TUI can capture already-typed prompt text when the slash command
  fires (`tui.prompt.append` read path) or only `$ARGUMENTS`-style completion —
  affects whether `/btw ` autocompletes inline.
- Preferred default keybind for history (`ctrl+b` conflicts risk — confirm
  against current TUI default layers).
- Should `model: "small"` be the default for cost, at the expense of Claude
  parity (`inherit`)? Proposal: keep `inherit`, document the trade-off.
