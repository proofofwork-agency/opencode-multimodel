import type { Goal } from "./types.ts";

export const DEFAULT_WRAPUP_RATIO = 0.8;

export type LimitKind = "tokens" | "turns" | "duration";

export function wrapupNeeded(
  goal: Goal,
  now: number,
  ratio = DEFAULT_WRAPUP_RATIO,
): LimitKind | undefined {
  if (goal.wrapupSent || goal.lastPromptKind === "budget_limit") return undefined;
  if (
    goal.tokenBudget !== undefined &&
    goal.tokensUsed >= Math.floor(goal.tokenBudget * ratio)
  ) return "tokens";
  if (
    goal.maxTurns !== undefined &&
    goal.autoTurns >= Math.floor(goal.maxTurns * ratio)
  ) return "turns";
  if (
    goal.maxDurationSeconds !== undefined &&
    goal.timeUsedSeconds >= Math.floor(goal.maxDurationSeconds * ratio)
  ) return "duration";
  void now;
  return undefined;
}

export function hardLimitReached(goal: Goal): LimitKind | undefined {
  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    return "tokens";
  }
  if (goal.maxTurns !== undefined && goal.autoTurns >= goal.maxTurns) {
    return "turns";
  }
  if (
    goal.maxDurationSeconds !== undefined &&
    goal.timeUsedSeconds >= goal.maxDurationSeconds
  ) {
    return "duration";
  }
  return undefined;
}

export function noProgressShouldPause(input: {
  outputTokens?: number;
  threshold: number;
  streak: number;
  maxStreak: number;
  reservedContinuation: boolean;
}) {
  if (!input.reservedContinuation) return false;
  if (input.outputTokens === undefined) return false;
  if (input.outputTokens >= input.threshold) return false;
  return input.streak >= input.maxStreak;
}
