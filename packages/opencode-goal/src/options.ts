export type GoalOptions = {
  databasePath: string;
  snapshotDir: string;
  multimodelDatabasePath: string;
  minDelayMs: number;
  maxPromptFailures: number;
  autoResumeInterrupted: boolean;
  runHostChecks: boolean;
  requireHostProof: boolean;
  judge: boolean;
  noToolTurnsBeforeSuppress: number;
  checkTimeoutMs: number;
};

export class GoalConfigError extends Error {
  constructor(message: string) {
    super(`Invalid opencode-goal configuration: ${message}`);
    this.name = "GoalConfigError";
  }
}

export function parseOptions(
  value: Record<string, unknown> | undefined,
): GoalOptions {
  const input = value ?? {};
  rejectUnknown(input, [
    "databasePath",
    "snapshotDir",
    "multimodelDatabasePath",
    "minDelayMs",
    "maxPromptFailures",
    "autoResumeInterrupted",
    "runHostChecks",
    "requireHostProof",
    "judge",
    "noToolTurnsBeforeSuppress",
    "checkTimeoutMs",
  ]);
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
    runHostChecks: optionalBoolean(
      input.runHostChecks,
      "runHostChecks",
      true,
    ),
    requireHostProof: optionalBoolean(
      input.requireHostProof,
      "requireHostProof",
      true,
    ),
    judge: optionalBoolean(input.judge, "judge", true),
    noToolTurnsBeforeSuppress: optionalInteger(
      input.noToolTurnsBeforeSuppress,
      "noToolTurnsBeforeSuppress",
      2,
      1,
      10,
    ),
    checkTimeoutMs: optionalInteger(
      input.checkTimeoutMs,
      "checkTimeoutMs",
      120_000,
      1_000,
      3_600_000,
    ),
  };
}

function rejectUnknown(
  input: Record<string, unknown>,
  allowed: string[],
) {
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
