import { expect, test } from "bun:test";
import { defaultGoalFields, type Goal } from "../src/types.ts";
import { hardLimitReached, noProgressShouldPause, wrapupNeeded } from "../src/limits.ts";
import { decideContinuation } from "../src/policy.ts";

const goal = (extra: Partial<Goal> = {}): Goal => ({
  sessionID: "ses",
  goalID: "g",
  objective: "ship",
  status: "active",
  checks: [],
  tokensUsed: 0,
  timeUsedSeconds: 0,
  turns: 0,
  lastHadTools: true,
  continuationSuppressed: false,
  noToolStreak: 0,
  createdAt: 1,
  updatedAt: 1,
  ...defaultGoalFields(),
  ...extra,
});

test("wraps up at 80% then hard-stops", () => {
  const near = goal({ tokenBudget: 100, tokensUsed: 80 });
  expect(wrapupNeeded(near, 1)).toBe("tokens");
  expect(hardLimitReached(near)).toBeUndefined();
  expect(hardLimitReached(goal({ tokenBudget: 100, tokensUsed: 100 }))).toBe(
    "tokens",
  );
});

test("policy emits a budget wrap-up before the hard stop", () => {
  const decision = decideContinuation({
    goal: goal({ tokenBudget: 100, tokensUsed: 85 }),
    now: 10,
    minDelayMs: 0,
    busy: false,
    planMode: false,
    queuedUserInput: false,
    pluginRunActive: false,
    childrenBusy: false,
    promptFailures: 0,
    maxPromptFailures: 3,
    noToolTurnsBeforeSuppress: 2,
    wrapupRatio: 0.8,
  });
  expect(decision).toEqual({ action: "continue", kind: "budget_limit" });
});

test("no-progress only counts reserved continuations", () => {
  expect(noProgressShouldPause({
    outputTokens: 10,
    threshold: 50,
    streak: 2,
    maxStreak: 2,
    reservedContinuation: false,
  })).toBe(false);
  expect(noProgressShouldPause({
    outputTokens: 10,
    threshold: 50,
    streak: 2,
    maxStreak: 2,
    reservedContinuation: true,
  })).toBe(true);
});
