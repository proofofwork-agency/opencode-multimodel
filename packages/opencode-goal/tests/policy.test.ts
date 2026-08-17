import { expect, test } from "bun:test";
import {
  decideContinuation,
  shouldSuppressNextContinuation,
} from "../src/policy.ts";
import { defaultGoalFields, type Goal } from "../src/types.ts";

const goal = (status: Goal["status"], extra: Partial<Goal> = {}): Goal => ({
  sessionID: "ses",
  goalID: "goal",
  objective: "ship it",
  status,
  checks: [],
  tokensUsed: 0,
  timeUsedSeconds: 0,
  turns: 1,
  lastHadTools: true,
  continuationSuppressed: false,
  noToolStreak: 0,
  createdAt: 1,
  updatedAt: 1,
  ...defaultGoalFields(),
  ...extra,
});

const base = {
  now: 10_000,
  minDelayMs: 1_500,
  busy: false,
  planMode: false,
  queuedUserInput: false,
  pluginRunActive: false,
  childrenBusy: false,
  promptFailures: 0,
  maxPromptFailures: 3,
  noToolTurnsBeforeSuppress: 2,
  wrapupRatio: 0.8,
};

test("continues an idle active goal", () => {
  expect(decideContinuation({ ...base, goal: goal("active") })).toEqual({
    action: "continue",
    kind: "continuation",
  });
});

test("skips plan mode, busy sessions, plugin runs, children, and queued input", () => {
  expect(decideContinuation({
    ...base,
    goal: goal("active"),
    planMode: true,
  }).action).toBe("skip");
  expect(skipReason(decideContinuation({
    ...base,
    goal: goal("active"),
    busy: true,
  }))).toBe("busy");
  expect(skipReason(decideContinuation({
    ...base,
    goal: goal("active"),
    pluginRunActive: true,
  }))).toBe("plugin-run-active");
  expect(skipReason(decideContinuation({
    ...base,
    goal: goal("active"),
    childrenBusy: true,
  }))).toBe("children-busy");
  expect(skipReason(decideContinuation({
    ...base,
    goal: goal("active"),
    queuedUserInput: true,
  }))).toBe("user-queued");
});

test("reports budget once then stops", () => {
  const limited = goal("budget_limited");
  expect(decideContinuation({ ...base, goal: limited })).toEqual({
    action: "continue",
    kind: "budget_limit",
  });
  expect(skipReason(decideContinuation({
    ...base,
    goal: { ...limited, lastPromptKind: "budget_limit" },
  }))).toBe("budget-already-reported");
});

test("suppresses after repeated no-tool continuation turns", () => {
  expect(shouldSuppressNextContinuation({
    hadTools: false,
    wasContinuation: true,
    streak: 2,
    threshold: 2,
  })).toBe(true);
  expect(skipReason(decideContinuation({
    ...base,
    goal: goal("active", { noToolStreak: 2 }),
  }))).toBe("no-tool-suppressed");
});

test("honors independent judge verdicts", () => {
  expect(decideContinuation({
    ...base,
    goal: goal("active", {
      lastVerdict: { verdict: "met", reason: "tests pass", at: 1 },
    }),
  }).action).toBe("complete");
  const impossible = decideContinuation({
    ...base,
    goal: goal("active", {
      lastVerdict: { verdict: "impossible", reason: "API gone", at: 1 },
    }),
  });
  expect(impossible).toEqual({
    action: "impossible",
    reason: "API gone",
  });
});

function skipReason(decision: ReturnType<typeof decideContinuation>) {
  return decision.action === "skip" ? decision.reason : undefined;
}
