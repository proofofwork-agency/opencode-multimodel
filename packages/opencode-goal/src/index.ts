export { parseGoalCommand, parseBudget, GoalCommandError } from "./command.ts";
export type { GoalCommand } from "./command.ts";
export { parseOptions, GoalConfigError } from "./options.ts";
export type { GoalOptions } from "./options.ts";
export { GoalStore, resolvePath } from "./store.ts";
export { GoalSnapshotStore, readActiveGoalSnapshot, readGoalSnapshot, formatGoalInjection } from "./snapshot.ts";
export { decideContinuation, shouldSuppressNextContinuation, sameObjective } from "./policy.ts";
export type { ContinuationContext, ContinuationDecision } from "./policy.ts";
export { auditCompletion, inspectClaim, citedFiles } from "./evidence.ts";
export { parseJudgeOutput, judgePrompt } from "./judge.ts";
export type { JudgeResult, JudgeInput } from "./judge.ts";
export { GoalService, createGoalService } from "./engine.ts";
export {
  continuationPrompt,
  budgetLimitPrompt,
  startPrompt,
  goalContextBlock,
  formatGoalStatus,
  completionBudgetReport,
} from "./prompts.ts";
export { multimodelRunGate, isCodexDelegateModel, delegatePrompt } from "./bridge.ts";
export { adaptGoalClient, createdSessionID, httpJudge } from "./opencode.ts";
export {
  snapshotFromGoal,
  isTerminalStatus,
  GOAL_STATUSES,
  JUDGE_VERDICTS,
  TERMINAL_STATUSES,
} from "./types.ts";
export type {
  Goal,
  GoalSnapshot,
  GoalIndex,
  GoalStatus,
  GoalVerdict,
  JudgeVerdictName,
  PauseReason,
} from "./types.ts";
