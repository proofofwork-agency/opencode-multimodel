# OpenCode 2 (beta) support

Implemented and verified against `opencode2` **v0.0.0-beta-17519**
(installed from npm `@opencode-ai/cli@beta`). The V2 entry module is
`src/oc2.ts`, built to `dist/oc2.js`, exported as `opencode-goal/oc2`.

## What is verified live (end-to-end smoke, 2026-08-17)

Against a real `opencode2 serve` process with live model turns:

1. **Plugin loads** from a project `opencode.json`
   `"plugins": ["…/opencode-goal/dist/oc2.js"]` (must be the entry **file**,
   not the package directory — see pitfalls).
2. **`/goal` command registered** via `ctx.command.transform` +
   `registry.update("goal", fn)` — confirmed through `/api/command`.
3. **Tools registered and executed live** via `ctx.tool.transform` +
   `registry.add`: `create_goal`, `update_goal`, `get_goal`, `goal_pause`,
   `goal_resume`, `goal_clear`. A live model turn invoked the tools with
   `{sessionID, agent}` in the execute context.
4. **Full goal lifecycle completed**: `/goal` template → model called
   `create_goal` (goal persisted in `.opencode/goal.sqlite`, frozen
   contract written) → model created the target file with the write tool →
   model called `update_goal {status: "complete", evidence: "Created
   OC2_SMOKE.md …"}` → local evidence gate + host proof (cited file
   exists) approved → goal reached `status = complete` in 6 turns.
5. **Auto-continue works**: the plugin-side drive loop polls
   `service.handleIdle` and sends continuation prompts through
   `ctx.session.prompt` (delivery `steer`).

## V2 API map (reverse-engineered)

- Plugin module contract: `export default { id, effect, setup(ctx) }`;
  `setup` is invoked by the host.
- `ctx.command.transform((reg) => reg.update(name, (existing) => next))`
- `ctx.tool.transform((reg) => reg.add({ name, description, args,
  execute(args, sctx) }))` — `sctx: {sessionID, agent, messageID, id,
  progress}`; args use JSON-schema-style shapes.
- `ctx.session`: `get({sessionID})` (no busy status exposed),
  `create({title})` → `{id}`, `prompt({sessionID, text})` (async,
  returns the queued user message), `generate({sessionID, prompt})` →
  `{text}` (works for short prompts; returns empty text for long or
  JSON-heavy prompts — see limitations), `interrupt({sessionID})`.
- `ctx.event.subscribe(fn)` accepted but no session events were observed
  flowing to plugins in this beta — the port uses polling instead.

## Limitations in this beta (documented, not hidden)

- **Independent judge off by default on OC2** (`judge: false`): the beta's
  `session.generate` returns empty text for long judge prompts, so the
  side-session judge is unreliable. Completion is still gated by the local
  evidence claim gate + host proof (`--check` or cited existing files) +
  frozen dogfood contract hash. Setting plugin options with
  `"judge": true` enables the compact judge with per-attempt fresh
  sessions and retries.
- No compaction-context hook, no per-message pause detection (no
  `chat.message` equivalent) — user interrupts rely on explicit
  `/goal pause`.
- Turn/token accounting is coarse: `session.prompt` returns before the
  model turn finishes, so per-turn token accounting uses host session
  totals only when available.

## Port notes

- The V1 `server.ts` (hook object) remains the OpenCode 1.x entry; the V2
  module reuses `GoalService` unchanged (state, contracts, ownership,
  plan-mode safety, multi-goal, limits are host-agnostic).
- Loader pitfalls (still true in beta-17519): directory plugin paths break
  `?mtime=` resolution — point `plugins` at the entry file; the discovered
  plugin set is cached beyond `~/.cache/opencode/packages`, so plugin
  iteration needs a fresh project directory; plugin loading is lazy —
  touch `/api/plugin` or `/api/command` to trigger it.

## Reproduce the smoke

```sh
npm install --prefix /tmp/oc2 @opencode-ai/cli@beta
mkdir /tmp/oc2proj && cd /tmp/oc2proj
# opencode.json: { "plugins": ["<abs path>/packages/opencode-goal/dist/oc2.js"] }
/tmp/oc2/node_modules/.bin/opencode2 serve --port 4110 --hostname 127.0.0.1
# then: create a session via /api/session, prompt it to run /goal,
# and watch .opencode/goal.sqlite reach status=complete
```

