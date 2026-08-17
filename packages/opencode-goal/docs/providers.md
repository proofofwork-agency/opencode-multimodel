# Live provider smoke matrix

Verified against a real OpenCode server process (no mocked hooks), driven
through the public HTTP API with the plugin's own `GoalService`: a live
worker turn creates `SMOKE_GOAL.md`, the host check runs on the host, the
independent judge runs in a separate no-tools side session, and the
completion gate (evidence + host check + judge) must approve before the goal
reaches `complete`.

| Date | Host | Worker + judge model | Result | Wall clock | Turns | Tokens |
|---|---|---|---|---|---|---|
| 2026-08-17 | opencode 1.18.16+local (serve, 127.0.0.1) | zai-coding-plan/glm-5.3 | PASS — judge `met`, state `complete` | 36 s | 1 | 11,825 |
| 2026-08-17 | opencode 1.18.16+local (serve, 127.0.0.1) | zai-coding-plan/glm-5.2 | PASS — judge `met`, state `complete` | 85 s | 2 | 23,947 |
| 2026-08-17 | opencode 1.18.16+local (serve, 127.0.0.1) | zai-coding-plan/glm-5-turbo | PASS — judge `met`, state `complete` | 20 s | 2 | 23,880 |
| 2026-08-17 | opencode 1.18.16+local (serve, 127.0.0.1) | zai-coding-plan/glm-4.7 | PASS — judge `met`, state `complete` | 62 s | 2 | 25,133 |

Grading is on persisted-state correctness (final goal status, judge verdict,
token accounting from the host), not on terminal rendering.

## Reproduce

Requires a running OpenCode server with live provider credentials:

```sh
opencode serve --port 4096 --hostname 127.0.0.1
bun packages/opencode-goal/scripts/provider-smoke.ts \
  --baseUrl http://127.0.0.1:4096 --model zai-coding-plan/glm-5.3 --timeout 180
```

The script prints one JSON line (`outcome`, `model`, `sessionID`, `seconds`,
`detail`) and exits non-zero on failure. `--keep` preserves the temporary
project directory for inspection.

## Hardening found by these runs

- Reasoning models occasionally return responses with no text part; the
  judge side session then sees "no text". The judge call now has a 120 s
  HTTP timeout, retries once on empty output, accepts a bare verdict line
  as a fallback format, and the engine pauses the goal (`audit`) after
  three consecutive unusable judge outputs instead of looping.
- A provider can withdraw a model id (`glm-4.6` was configured as default
  but no longer exists server-side); the smoke surfaces this immediately as
  a `ProviderModelNotFoundError` instead of a silent hang.
