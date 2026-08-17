import type { Goal } from "./types.ts";
import { isTerminalStatus } from "./types.ts";

export type ContinuationDecision =
  | { action: "continue"; kind: "continuation" | "budget_limit" }
  | { action: "skip"; reason: string }
  | { action: "complete" }
  | { action: "impossible"; reason: string };

export type ContinuationContext = {
  goal?: Goal;
  now: number;
  lastPromptAt?: number;
  minDelayMs: number;
  busy: boolean;
  planMode: boolean;
  queuedUserInput: boolean;
  pluginRunActive: boolean;
  childrenBusy: boolean;
  promptFailures: number;
  maxPromptFailures: number;
  noToolTurnsBeforeSuppress: number;
};

export function decideContinuation(
  context: ContinuationContext,
): ContinuationDecision {
  const goal = context.goal;
  if (!goal) return { action: "skip", reason: "no-goal" };
  if (context.busy) return { action: "skip", reason: "busy" };
  if (context.queuedUserInput) return { action: "skip", reason: "user-queued" };
  if (context.pluginRunActive) {
    return { action: "skip", reason: "plugin-run-active" };
  }
  if (context.childrenBusy) {
    return { action: "skip", reason: "children-busy" };
  }
  if (context.planMode) return { action: "skip", reason: "plan-mode" };
  if (context.promptFailures >= context.maxPromptFailures) {
    return { action: "skip", reason: "prompt-failures" };
  }
  if (
    context.lastPromptAt !== undefined &&
    context.now - context.lastPromptAt < context.minDelayMs
  ) {
    return { action: "skip", reason: "cooldown" };
  }
  if (goal.status === "complete") return { action: "skip", reason: "complete" };
  if (goal.status === "impossible") {
    return { action: "skip", reason: "impossible" };
  }
  if (goal.status === "paused") return { action: "skip", reason: "paused" };
  if (goal.status === "budget_limited") {
    if (goal.lastPromptKind === "budget_limit") {
      return { action: "skip", reason: "budget-already-reported" };
    }
    return { action: "continue", kind: "budget_limit" };
  }
  if (
    goal.continuationSuppressed ||
    goal.noToolStreak >= context.noToolTurnsBeforeSuppress
  ) {
    return { action: "skip", reason: "no-tool-suppressed" };
  }
  if (goal.lastVerdict?.verdict === "impossible") {
    return { action: "impossible", reason: goal.lastVerdict.reason };
  }
  if (goal.lastVerdict?.verdict === "met") return { action: "complete" };
  return { action: "continue", kind: "continuation" };
}

export function shouldSuppressNextContinuation(input: {
  hadTools: boolean;
  wasContinuation: boolean;
  streak: number;
  threshold: number;
}) {
  return input.wasContinuation && !input.hadTools &&
    input.streak >= input.threshold;
}

export function sameObjective(left: string, right: string) {
  return normalizeObjective(left) === normalizeObjective(right);
}

export function normalizeObjective(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export { isTerminalStatus };
