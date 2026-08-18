# btw plugin comparison scorecard

Date: 2026-08-17. Our plugin (this package, `@proofofwork-agency/opencode-btw`)
vs the strongest side-question plugins found in the wild:

- **opencode-bytheway** 0.8.0 (timrichardson/opencode-btw; 26 releases,
  dual OpenCode V1+V2, TUI-only) — the real competitor
- **kldzj/opencode-btw** — different category (hint injection), not a
  side-question plugin
- **pi-btw ecosystem** (`@narumitw/pi-btw`, `pi-smart-btw`, …) and
  `@elyracode/btw` — same pattern on other agent hosts (Pi, Elyra), not
  OpenCode plugins

Ours is verified by the unit suite (`bun test`, 46/46) with file-cited
evidence below. Competitor claims come from their published READMEs.

## Feature matrix (ours vs opencode-bytheway)

| # | Criterion | ours | bytheway |
|---|---|---|---|
| 1 | Works while main session is busy | yes — submit-key intercept consumes Enter before the queue (tui.tsx intercept, priority 20k; tested) | yes (fork switch) |
| 2 | Session isolation model | ephemeral child via parentID, always deleted in finally incl. timeout/abort/error paths (runner.ts; lifecycle-tested) | forked session; delete on /btw-end or merge |
| 3 | Child agent capability | tool-less (hard blocklist), permissions denied, maxSteps 1, temp 0, output clamp — strongest isolation (server.ts config hook; tested) | full agent with all tools (by design) |
| 4 | Context passed to side session | bounded snapshot: 40 msgs / 48k chars newest-biased, truncation markers, tool parts summarized, injection-framed as reference-only (snapshot.ts; budget-tested) | full fork (all history) or /btw-fast plain text |
| 5 | Live streaming of the answer | yes — message.part.updated fed into the TUI runner, overlay renders partials (tui.tsx event wiring; tested) | native (in-fork) |
| 6 | Result delivery | full-screen dismissible overlay + model label + notify; esc/enter (tui.tsx; navigation-tested) | you are inside the fork |
| 7 | Merge answer back into parent | opt-in `/btw --send` appends the Q&A as a user message; default fully ephemeral (tui.tsx + slash.ts; both paths tested) | /btw-merge appends plain text (with staleness confirmation) |
| 8 | Cancellation + timeout | AbortSignal race, 60s default (1s–300s clamp), abort+delete on timeout (runner.ts; tested) | /btw-end stops generation then deletes |
| 9 | Model selection | inherit / small_model / explicit provider-model (options.ts; tested) | parent model (fork semantics) |
| 10 | Agent-facing tool (side channel for the main agent) | yes — optional `btw` tool (server.ts; agent registration tested) | no |
| 11 | History | in-memory session-scoped ring (/btw-history, ctrl+b), cleared on exit — nothing persists | fork persists until ended/merged |
| 12 | Multi-turn side conversation | no (one-shot by design) | yes (fork) |
| 13 | OpenCode V2 (opencode2) | no | yes, dual V1/V2 from one package |
| 14 | Real-TUI integration tests | unit + TUI-adapter tests against test doubles (46/46) | pty-driven real-TUI integration suite |
| 15 | npm publish readiness | scoped name reserved-following convention, unblocked (was: name collision, now renamed) | 26 releases published |

## Where we lead

1. **Safety architecture** (rows 3, 4): the only plugin whose side channel is
   a tool-less, permission-denied, single-step child with a bounded,
   injection-framed snapshot — bytheway's fork is a fully-armed agent with
   the complete session history.
2. **Agent-facing side channel** (row 10): the main agent can ask `btw`
   directly; no competitor offers this.
3. **Ephemerality guarantee** (row 11): exchanges never touch disk or the
   parent transcript unless the user explicitly asks (`--send`).
4. **Streaming parity with an isolation model** (row 5): live partials in
   the overlay without giving the child tools.

## Where they lead (honest gaps)

1. Multi-turn side conversations (row 12) — a different product shape
   (inhabiting a fork) rather than a one-shot side question.
2. OpenCode V2 support (row 13) — roadmap for us.
3. Real-pty integration tests (row 14) — our 46 tests are against doubles;
   pty tests are a CI-hardening follow-up.

## Parity/superiority verdict

For the side-question use case (ask without contaminating or arming), ours
is the strongest implementation: equal or better on 12 of 15 criteria, with
a structurally safer isolation model, and the npm publish blocker is
resolved by the scoped rename. The gaps are a different product shape
(multi-turn forks), V2 support, and test-harness hardening — none of which
affect the one-shot side-question workflow this package targets.

## Reproduce

```sh
cd packages/opencode-btw
bun test          # 46/46
bun run typecheck # tsc --noEmit
```
