export type GoalOptions = {
  databasePath: string;
  snapshotDir: string;
  multimodelDatabasePath: string;
  minDelayMs: number;
  maxPromptFailures: number;
  autoResumeInterrupted: boolean;
  steerWithoutPause: boolean;
  runHostChecks: boolean;
  requireHostProof: boolean;
  judge: boolean;
  judgeModel?: string;
  noToolTurnsBeforeSuppress: number;
  noProgressTokenThreshold: number;
  maxNoProgressTurns: number;
  defaultMaxTurns?: number;
  defaultMaxDurationSeconds?: number;
  wrapupRatio: number;
  maxTurnTimeSeconds?: number;
  checkTimeoutMs: number;
  restrictedAgents: string[];
  allowGoalExecutionFromPlan: boolean;
  dogfood: boolean;
};

export class GoalConfigError extends Error {
  constructor(message: string) {
    super(`Invalid opencode-goal configuration: ${message}`);
    this.name = "GoalConfigError";
  }
}

const ALLOWED = [
  "databasePath",
  "snapshotDir",
  "multimodelDatabasePath",
  "minDelayMs",
  "maxPromptFailures",
  "autoResumeInterrupted",
  "steerWithoutPause",
  "runHostChecks",
  "requireHostProof",
  "judge",
  "judgeModel",
  "noToolTurnsBeforeSuppress",
  "noProgressTokenThreshold",
  "maxNoProgressTurns",
  "defaultMaxTurns",
  "defaultMaxDurationSeconds",
  "wrapupRatio",
  "maxTurnTimeSeconds",
  "checkTimeoutMs",
  "restrictedAgents",
  "allowGoalExecutionFromPlan",
  "dogfood",
];

export function parseOptions(
  value: Record<string, unknown> | undefined,
): GoalOptions {
  const input = value ?? {};
  rejectUnknown(input, ALLOWED);
  const wrapupRatio = optionalNumber(input.wrapupRatio, "wrapupRatio", 0.8, 0.1, 0.99);
  return {
    databasePath: optionalString(input.databasePath, "databasePath") ??
      ".opencode/goal.sqlite",
    snapshotDir: optionalString(input.snapshotDir, "snapshotDir") ??
      ".opencode/goals",
    multimodelDatabasePath: optionalString(
      input.multimodelDatabasePath,
      "multimodelDatabasePath",
    ) ?? ".opencode/multimodel.sqlite",
    minDelayMs: optionalInteger(input.minDelayMs, "minDelayMs", 1_500, 0, 60_000),
    maxPromptFailures: optionalInteger(
      input.maxPromptFailures,
      "maxPromptFailures",
      3,
      1,
      20,
    ),
    autoResumeInterrupted: optionalBoolean(
      input.autoResumeInterrupted,
      "autoResumeInterrupted",
      true,
    ),
    steerWithoutPause: optionalBoolean(
      input.steerWithoutPause,
      "steerWithoutPause",
      false,
    ),
    runHostChecks: optionalBoolean(input.runHostChecks, "runHostChecks", true),
    requireHostProof: optionalBoolean(
      input.requireHostProof,
      "requireHostProof",
      true,
    ),
    judge: optionalBoolean(input.judge, "judge", true),
    judgeModel: optionalString(input.judgeModel, "judgeModel"),
    noToolTurnsBeforeSuppress: optionalInteger(
      input.noToolTurnsBeforeSuppress,
      "noToolTurnsBeforeSuppress",
      2,
      1,
      10,
    ),
    noProgressTokenThreshold: optionalInteger(
      input.noProgressTokenThreshold,
      "noProgressTokenThreshold",
      50,
      1,
      10_000,
    ),
    maxNoProgressTurns: optionalInteger(
      input.maxNoProgressTurns,
      "maxNoProgressTurns",
      2,
      1,
      10,
    ),
    defaultMaxTurns: optionalInteger(
      input.defaultMaxTurns,
      "defaultMaxTurns",
      25,
      1,
      1_000,
    ),
    defaultMaxDurationSeconds: optionalInteger(
      input.defaultMaxDurationSeconds,
      "defaultMaxDurationSeconds",
      undefined,
      1,
      86_400,
    ),
    wrapupRatio,
    maxTurnTimeSeconds: optionalInteger(
      input.maxTurnTimeSeconds,
      "maxTurnTimeSeconds",
      undefined,
      1,
      3_600,
    ),
    checkTimeoutMs: optionalInteger(
      input.checkTimeoutMs,
      "checkTimeoutMs",
      120_000,
      1_000,
      3_600_000,
    ),
    restrictedAgents: optionalStringList(
      input.restrictedAgents,
      "restrictedAgents",
    ) ?? ["plan"],
    allowGoalExecutionFromPlan: optionalBoolean(
      input.allowGoalExecutionFromPlan,
      "allowGoalExecutionFromPlan",
      false,
    ),
    dogfood: optionalBoolean(input.dogfood, "dogfood", true),
  };
}

export function isRestrictedAgent(agent: string | undefined, options: GoalOptions) {
  if (options.allowGoalExecutionFromPlan) return false;
  const name = agent?.trim().toLowerCase();
  if (!name) return false;
  return options.restrictedAgents.some((item) => item.toLowerCase() === name);
}

function rejectUnknown(input: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new GoalConfigError(`${unknown[0]} is not a supported option.`);
  }
}

function optionalString(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value;
  throw new GoalConfigError(`${path} must be a non-empty string.`);
}

function optionalStringList(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim())
  ) {
    return value.map((item) => String(item).trim());
  }
  throw new GoalConfigError(`${path} must be an array of non-empty strings.`);
}

function optionalBoolean(value: unknown, path: string, fallback: boolean) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new GoalConfigError(`${path} must be a boolean.`);
}

function optionalInteger(
  value: unknown,
  path: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number;
function optionalInteger(
  value: unknown,
  path: string,
  fallback: undefined,
  minimum: number,
  maximum: number,
): number | undefined;
function optionalInteger(
  value: unknown,
  path: string,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return fallback;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  ) return value;
  throw new GoalConfigError(
    `${path} must be an integer between ${minimum} and ${maximum}.`,
  );
}

function optionalNumber(
  value: unknown,
  path: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return fallback;
  if (typeof value === "number" && value >= minimum && value <= maximum) {
    return value;
  }
  throw new GoalConfigError(
    `${path} must be a number between ${minimum} and ${maximum}.`,
  );
}
