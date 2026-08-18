export { parseGoalCommand, parseBudget, GoalCommandError } from "./command.ts";
export type { GoalCommand } from "./command.ts";
export {
  goalSlashArguments,
  sessionLooksBusy,
  shouldStartGoalTurn,
  shouldSteerLiveTurn,
} from "./slash.ts";
export { parseOptions, GoalConfigError } from "./options.ts";
export type { GoalOptions } from "./options.ts";
export { GoalStore, resolvePath } from "./store.ts";
export { GoalSnapshotStore, readActiveGoalSnapshot, readGoalSnapshot, formatGoalInjection } from "./snapshot.ts";
export { decideContinuation, shouldSuppressNextContinuation, sameObjective } from "./policy.ts";
export type { ContinuationContext, ContinuationDecision } from "./policy.ts";
export { auditCompletion, inspectClaim, citedFiles } from "./evidence.ts";
export { parseJudgeOutput, judgePrompt } from "./judge.ts";
export type { JudgeResult, JudgeInput } from "./judge.ts";
export {
  detectToolLoop,
  detectPureCycle,
  toolFingerprints,
  appendTrace,
} from "./trajectory.ts";
export type { LoopPattern, LoopDetection } from "./trajectory.ts";
export { GoalService, createGoalService, GoalOwnedError } from "./engine.ts";
export {
  continuationPrompt,
  budgetLimitPrompt,
  startPrompt,
  goalContextBlock,
  formatGoalStatus,
  formatGoalReceipt,
  formatContractStatus,
  agentGoalSystemBlock,
  goalModePolicy,
  escapeXml,
  completionBudgetReport,
  GOAL_RECEIPT_MARK,
} from "./prompts.ts";
export { multimodelRunGate, isCodexDelegateModel, delegatePrompt } from "./bridge.ts";
export { adaptGoalClient, createdSessionID, httpJudge } from "./opencode.ts";
export { CONTRACT_AUTHOR_ROLE, extractYamlDocument } from "./contract-author.ts";
export {
  snapshotFromGoal,
  goalFromSnapshot,
  isCrashRecoverable,
  isTerminalStatus,
  defaultGoalFields,
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
