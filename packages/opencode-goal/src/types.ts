export const GOAL_STATUSES = [
  "active",
  "paused",
  "budget_limited",
  "complete",
  "impossible",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const JUDGE_VERDICTS = ["not_met", "met", "impossible"] as const;
export type JudgeVerdictName = (typeof JUDGE_VERDICTS)[number];

export type GoalVerdict = {
  verdict: JudgeVerdictName;
  reason: string;
  at: number;
};

export const PAUSE_REASONS = [
  "user",
  "interrupt",
  "budget",
  "no_tools",
  "audit",
  "blocked",
  "owned",
] as const;

export type PauseReason = (typeof PAUSE_REASONS)[number];

export type Goal = {
  sessionID: string;
  goalID: string;
  objective: string;
  status: GoalStatus;
  verification?: string;
  constraints?: string;
  checks: string[];
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  turns: number;
  lastHadTools: boolean;
  continuationSuppressed: boolean;
  noToolStreak: number;
  pauseReason?: PauseReason;
  lastEvidence?: string;
  blocker?: string;
  lastVerdict?: GoalVerdict;
  lastPromptKind?: "start" | "continuation" | "budget_limit";
  steerUntil?: number;
  createdAt: number;
  updatedAt: number;
};

export type GoalSnapshot = {
  version: 1;
  sessionID: string;
  goalID: string;
  objective: string;
  status: GoalStatus;
  verification?: string;
  constraints?: string;
  checks: string[];
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  turns: number;
  lastEvidence?: string;
  blocker?: string;
  pauseReason?: PauseReason;
  lastVerdict?: GoalVerdict;
  updatedAt: number;
};

export type GoalIndex = {
  version: 1;
  directory: string;
  active: Array<{
    sessionID: string;
    goalID: string;
    objective: string;
    status: GoalStatus;
    updatedAt: number;
  }>;
};

export const TERMINAL_STATUSES = [
  "complete",
  "budget_limited",
  "impossible",
] as const;

export function isTerminalStatus(status: GoalStatus) {
  return status === "complete" ||
    status === "budget_limited" ||
    status === "impossible";
}

export function snapshotFromGoal(goal: Goal): GoalSnapshot {
  return {
    version: 1,
    sessionID: goal.sessionID,
    goalID: goal.goalID,
    objective: goal.objective,
    status: goal.status,
    verification: goal.verification,
    constraints: goal.constraints,
    checks: [...goal.checks],
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    turns: goal.turns,
    lastEvidence: goal.lastEvidence,
    blocker: goal.blocker,
    pauseReason: goal.pauseReason,
    lastVerdict: goal.lastVerdict,
    updatedAt: goal.updatedAt,
  };
}
