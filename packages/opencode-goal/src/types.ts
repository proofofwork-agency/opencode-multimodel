export const GOAL_STATUSES = [
  "active",
  "paused",
  "budget_limited",
  "complete",
  "impossible",
  "unmet",
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
  "plan",
  "no_progress",
  "loop",
  "queued",
  "recovery",
] as const;

export type PauseReason = (typeof PAUSE_REASONS)[number];

export const HISTORY_TYPES = [
  "created",
  "updated",
  "paused",
  "resumed",
  "completed",
  "unmet",
  "impossible",
  "checkpoint",
  "limited",
  "error",
  "contract_revised",
  "contract_bound",
] as const;

export type GoalHistoryType = (typeof HISTORY_TYPES)[number];

export type GoalHistoryEntry = {
  type: GoalHistoryType;
  detail: string;
  timestamp: number;
};

export type GoalCheckpoint = {
  summary: string;
  timestamp: number;
};

export type Goal = {
  sessionID: string;
  goalID: string;
  objective: string;
  status: GoalStatus;
  verification?: string;
  constraints?: string;
  checks: string[];
  requiredChecks: string[];
  tokenBudget?: number;
  maxTurns?: number;
  maxDurationSeconds?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  turns: number;
  autoTurns: number;
  lastHadTools: boolean;
  continuationSuppressed: boolean;
  noToolStreak: number;
  noProgressStreak: number;
  wrapupSent: boolean;
  completable: boolean;
  dogfood: boolean;
  focused: boolean;
  autoPromote: boolean;
  pauseReason?: PauseReason;
  lastEvidence?: string;
  blocker?: string;
  lastVerdict?: GoalVerdict;
  lastPromptKind?: "start" | "continuation" | "budget_limit";
  lastPromptAgent?: string;
  steerUntil?: number;
  contractPath?: string;
  contractHash?: string;
  history: GoalHistoryEntry[];
  checkpoints: GoalCheckpoint[];
  lastCheckpoint?: GoalCheckpoint;
  toolTrace: string[];
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
  maxTurns?: number;
  maxDurationSeconds?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  turns: number;
  autoTurns: number;
  lastEvidence?: string;
  blocker?: string;
  pauseReason?: PauseReason;
  lastVerdict?: GoalVerdict;
  completable: boolean;
  dogfood: boolean;
  contractPath?: string;
  contractHash?: string;
  lastCheckpoint?: GoalCheckpoint;
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
  "unmet",
] as const;

export function isTerminalStatus(status: GoalStatus) {
  return status === "complete" ||
    status === "budget_limited" ||
    status === "impossible" ||
    status === "unmet";
}

export const CRASH_RECOVERABLE_PAUSES = ["interrupt", "recovery"] as const;

export function isCrashRecoverable(
  goal: Pick<Goal, "status" | "pauseReason">,
) {
  if (goal.status === "active" || goal.status === "budget_limited") return true;
  return goal.status === "paused" &&
    (goal.pauseReason === "interrupt" || goal.pauseReason === "recovery");
}

export function goalFromSnapshot(snapshot: GoalSnapshot): Goal {
  return {
    ...defaultGoalFields(),
    sessionID: snapshot.sessionID,
    goalID: snapshot.goalID,
    objective: snapshot.objective,
    status: snapshot.status,
    verification: snapshot.verification,
    constraints: snapshot.constraints,
    checks: [...snapshot.checks],
    requiredChecks: [...snapshot.checks],
    tokenBudget: snapshot.tokenBudget,
    maxTurns: snapshot.maxTurns,
    maxDurationSeconds: snapshot.maxDurationSeconds,
    tokensUsed: snapshot.tokensUsed,
    timeUsedSeconds: snapshot.timeUsedSeconds,
    turns: snapshot.turns,
    autoTurns: snapshot.autoTurns ?? 0,
    lastHadTools: false,
    continuationSuppressed: false,
    noToolStreak: 0,
    completable: snapshot.completable ?? false,
    dogfood: snapshot.dogfood !== false,
    pauseReason: snapshot.pauseReason,
    lastEvidence: snapshot.lastEvidence,
    blocker: snapshot.blocker,
    lastVerdict: snapshot.lastVerdict,
    lastCheckpoint: snapshot.lastCheckpoint,
    checkpoints: snapshot.lastCheckpoint ? [snapshot.lastCheckpoint] : [],
    toolTrace: [],
    contractPath: snapshot.contractPath,
    contractHash: snapshot.contractHash,
    createdAt: snapshot.updatedAt,
    updatedAt: snapshot.updatedAt,
  };
}

export function defaultGoalFields(): Pick<
  Goal,
  | "requiredChecks"
  | "autoTurns"
  | "noProgressStreak"
  | "wrapupSent"
  | "completable"
  | "dogfood"
  | "focused"
  | "autoPromote"
  | "toolTrace"
  | "history"
  | "checkpoints"
> {
  return {
    requiredChecks: [],
    autoTurns: 0,
    noProgressStreak: 0,
    wrapupSent: false,
    completable: false,
    dogfood: true,
    focused: true,
    autoPromote: false,
    toolTrace: [],
    history: [],
    checkpoints: [],
  };
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
    maxTurns: goal.maxTurns,
    maxDurationSeconds: goal.maxDurationSeconds,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    turns: goal.turns,
    autoTurns: goal.autoTurns,
    lastEvidence: goal.lastEvidence,
    blocker: goal.blocker,
    pauseReason: goal.pauseReason,
    lastVerdict: goal.lastVerdict,
    completable: goal.completable,
    dogfood: goal.dogfood,
    contractPath: goal.contractPath,
    contractHash: goal.contractHash,
    lastCheckpoint: goal.lastCheckpoint,
    updatedAt: goal.updatedAt,
  };
}
