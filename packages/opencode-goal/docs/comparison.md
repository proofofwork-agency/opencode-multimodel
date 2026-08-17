# Goal plugin comparison scorecard

Date: 2026-08-17. Plugins compared against the current tree of this package
(`packages/opencode-goal`, uncommitted working tree):

- **ours**: `opencode-goal` (this repo)
- **willytop8**: [`willytop8/OpenCode-goal-plugin`](https://github.com/willytop8/OpenCode-goal-plugin) (npm `opencode-goal-plugin`)
- **prevalentWare**: [`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin) (npm `@prevalentware/opencode-goal-plugin`)

Method: feature lists and claims are taken from each plugin's README
(retrieved 2026-08-17). Ours are verified by the deterministic benchmark
(`bun run benchmark`, 10/10) and the unit suite (`bun test`, 81 tests).

## Criteria matrix

| # | Criterion | ours | willytop8 | prevalentWare |
|---|---|---|---|---|
| 1 | False-completion rejected without evidence | yes (`completion-gate`) | yes (evidence markers + adjacency) | yes (evidence gate) |
| 2 | Self-reported failed check blocks completion | yes — always, incl. dogfood path (`inspectClaim` runs first in `completeFromModel`) | yes (rejected pre-archival) | partial (no structured checks surface) |
| 3 | Independent verifier beyond self-report | judge side-session (no tools) + contract author (read-only tools), fail-closed | opt-in child-session auditor (default-deny tools) | none beyond plugin itself |
| 4 | Executable completion oracle on the host | frozen hashed Dogfood contract (validate + run CLI); tamper pauses with `audit` | none (static verifier only) | none |
| 5 | Human-only contract revision | `/goal contract apply`; hash re-frozen | n/a | n/a |
| 6 | Loop safety: no-tool turns | yes (`no-tool-loop`) | yes | yes |
| 7 | Loop safety: no-progress turns | yes, output-token based; pauses only when the host reports output tokens (`no-progress-loop`) | yes | yes |
| 8 | Budget wrap-up before hard stop | yes, 80% configurable (`budget-wrapup`) | yes | yes |
| 9 | User message pauses loop (steer opt-in) | yes, default pause; `steerWithoutPause` restores steering (`user-interrupt`) | inverse default (`noInterruptOnUserMessage`) | pause |
| 10 | Crash/restart recovery | SQLite + snapshots; recovers active, leaves user-paused alone (`crash-recovery`) | ledger reconstruction into paused state | state-file recovery |
| 11 | Multi-process ownership | fail-closed passive mode: reads allowed, mutations denied `session_owned_elsewhere`, no prompts (`ownership`); locks expire by TTL + pid liveness | passive mode, immutable claim leases | none documented |
| 12 | Plan-mode safety | goals from plan agent created paused; resume refused; continuation agent-pinned (`plan-mode`) | none documented | yes (restricted agents) |
| 13 | Prompt-injection hardening | `<untrusted_objective>` XML-escaped + always-on goal-mode system policy | `<goal_objective>` wrapping | system policy block |
| 14 | Compaction survival | goal status + budget + wrap-up injected; generic auto-continue disabled while active | deterministic compaction injection | V1 only (V2 beta lacks it) |
| 15 | Persistent state hygiene | SQLite `0600`, snapshot dir `0700` | state `0600`, append-only ledger | `0600` atomic writes |
| 16 | Per-goal limits (`--max-turns`, `--max-minutes`, `--budget`) | yes, bounded to option ranges | yes (more flags) | no (plugin-level only) |
| 17 | Lifecycle history + checkpoints | `/goal history`, bounded 50 entries / 8 checkpoints | `/goal history` + JSONL ledger | `/goal history` |
| 18 | Multi-goal / focus / ordered sequences | yes — `/goal add`, `/goal list`, `/goal focus <n>`, `/goal sequence a; b` with auto-promotion on completion (`multi-goal-sequence` scenario) | yes | no |
| 19 | TUI sidebar + palette | yes (sidebar slot + palette commands) | toast notices only | yes (sidebar + palette) |
| 20 | OpenCode 2 beta support | yes — functional port on beta-17519: `/goal` command, 6 tools, persisted state, frozen contracts, auto-continue, evidence-gated completion verified end-to-end live (`docs/opencode2.md`); judge defaults off in OC2 (beta `generate` limitation, documented) | no | yes (V2 preview subset) |
| 21 | Live provider compatibility matrix published | yes — 4-model live matrix on opencode 1.18.16 (`docs/providers.md`, reproducible `scripts/provider-smoke.ts`) | yes (1.17.15 matrix, providers.md) | partial (V2 preview pin) |
| 22 | Deterministic behavior benchmark in repo | yes (`bun run benchmark`, provider-free, 9 scenarios) | yes (`benchmark:behavior`) | no |

## Where we lead

1. **Completion gating depth** (rows 2–5): the only plugin where every
   completion must pass a local structured-claim gate, an independent judge,
   and an executable frozen contract whose hash is verified at claim time.
   The benchmark proves a tampered contract pauses completion (`contract-tamper`)
   and a failed self-reported check is rejected even when the dogfood runner
   would pass (`completion-gate`).
2. **Ownership semantics** (row 11): passive mode keeps reads working where
   willytop8 denies all goal commands; locks combine TTL with pid liveness.
3. **Verified-by-default posture**: every matrix row for ours cites a
   deterministic scenario or unit test runnable without a provider
   (`bun run benchmark`, `bun test`).

## Where we trail (honest gaps)

1. **Dogfood npm pin**: `@proofofwork-agency/dogfood` resolves via a local
   `file:` pin until it is published to npm (human action); the resolution
   test skips when the pin is absent so CI stays green.
2. **OC2 judge**: independent-judge side sessions are disabled by default on
   OpenCode 2 because the beta's `session.generate` returns empty text for
   long prompts (verified; documented in `docs/opencode2.md`). Completion on
   OC2 is still evidence-gated (claim gate + host proof + contract hash).

## Reproduce

```sh
cd packages/opencode-goal
bun test          # 87 tests
bun run typecheck # tsc --noEmit
bun run benchmark # 10/10 scenarios, exit 1 on any failure
bun scripts/provider-smoke.ts --model zai-coding-plan/glm-5.3  # live V1 (needs a running server)
# OC2: see docs/opencode2.md "Reproduce the smoke"
```
