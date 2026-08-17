import {
  COLLAB_MODES,
  type CollabMode,
  type ComposerMode,
  type Fleet,
  type FleetMember,
} from "./types.ts";

export type MultiModelOptions = {
  databasePath: string;
  statePath?: string;
  fleet?: Fleet;
  defaultMode: CollabMode;
  maxWorkers: number;
  maxParallel: number;
  composer: {
    enabled: boolean;
    initial: ComposerMode;
    autoRoute: boolean;
  };
  workflows: {
    scripts: boolean;
    directories: string[];
    timeoutMs: number;
    maxAgentCalls: number;
  };
  retention: {
    runs: number;
    events: number;
  };
};

export class MultiModelConfigError extends Error {
  constructor(message: string) {
    super(`Invalid opencode-multimodel configuration: ${message}`);
    this.name = "MultiModelConfigError";
  }
}

export function parseOptions(
  value: Record<string, unknown> | undefined,
): MultiModelOptions {
  const input = value ?? {};
  rejectUnknown(input, [
    "databasePath",
    "statePath",
    "fleet",
    "defaultMode",
    "maxWorkers",
    "maxParallel",
    "composer",
    "workflows",
    "retention",
  ]);
  return {
    databasePath: optionalString(input.databasePath, "databasePath") ??
      ".opencode/multimodel.sqlite",
    statePath: optionalString(input.statePath, "statePath"),
    fleet: optionalFleet(input.fleet),
    defaultMode: optionalMode(input.defaultMode),
    maxWorkers: optionalInteger(input.maxWorkers, "maxWorkers", 8, 1, 8),
    maxParallel: optionalInteger(
      input.maxParallel,
      "maxParallel",
      3,
      1,
      6,
    ),
    composer: parseComposer(input.composer),
    workflows: parseWorkflows(input.workflows),
    retention: parseRetention(input.retention),
  };
}

function parseComposer(value: unknown): MultiModelOptions["composer"] {
  const input = optionalObject(value, "composer");
  rejectUnknown(input, ["enabled", "initial", "autoRoute"], "composer");
  const initial = input.initial ?? "single";
  if (!(["single", "team", "workflow"] as const).includes(initial as never)) {
    throw new MultiModelConfigError(
      'composer.initial must be "single", "team", or "workflow".',
    );
  }
  return {
    enabled: optionalBoolean(input.enabled, "composer.enabled", true),
    initial: initial as ComposerMode,
    autoRoute: optionalBoolean(
      input.autoRoute,
      "composer.autoRoute",
      false,
    ),
  };
}

function parseWorkflows(value: unknown): MultiModelOptions["workflows"] {
  const input = optionalObject(value, "workflows");
  rejectUnknown(
    input,
    ["scripts", "directories", "timeoutMs", "maxAgentCalls"],
    "workflows",
  );
  const directories = input.directories ?? [".opencode/workflows"];
  if (
    !Array.isArray(directories) ||
    directories.some((directory) =>
      typeof directory !== "string" || !directory.trim()
    )
  ) {
    throw new MultiModelConfigError(
      "workflows.directories must be an array of non-empty strings.",
    );
  }
  return {
    scripts: optionalBoolean(input.scripts, "workflows.scripts", false),
    directories,
    timeoutMs: optionalInteger(
      input.timeoutMs,
      "workflows.timeoutMs",
      900_000,
      100,
      3_600_000,
    ),
    maxAgentCalls: optionalInteger(
      input.maxAgentCalls,
      "workflows.maxAgentCalls",
      64,
      1,
      64,
    ),
  };
}

function parseRetention(value: unknown): MultiModelOptions["retention"] {
  const input = optionalObject(value, "retention");
  rejectUnknown(input, ["runs", "events"], "retention");
  return {
    runs: optionalInteger(input.runs, "retention.runs", 100, 1, 10_000),
    events: optionalInteger(
      input.events,
      "retention.events",
      10_000,
      100,
      1_000_000,
    ),
  };
}

function optionalObject(value: unknown, path: string) {
  if (value === undefined) return {} as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MultiModelConfigError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  input: Record<string, unknown>,
  allowed: string[],
  path?: string,
) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new MultiModelConfigError(
    `${path ? `${path}.` : ""}${unknown[0]} is not a supported option.`,
  );
}

function optionalString(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value;
  throw new MultiModelConfigError(`${path} must be a non-empty string.`);
}

function optionalBoolean(value: unknown, path: string, fallback: boolean) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new MultiModelConfigError(`${path} must be a boolean.`);
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
  throw new MultiModelConfigError(
    `${path} must be an integer between ${minimum} and ${maximum}.`,
  );
}

function optionalMode(value: unknown): CollabMode {
  if (value === undefined) return "council";
  if (
    typeof value === "string" &&
    (COLLAB_MODES as readonly string[]).includes(value)
  ) return value as CollabMode;
  throw new MultiModelConfigError(
    `defaultMode must be one of ${COLLAB_MODES.join(", ")}.`,
  );
}

function optionalFleet(value: unknown) {
  if (value === undefined) return undefined;
  const input = optionalObject(value, "fleet");
  rejectUnknown(input, ["leadID", "members"], "fleet");
  const leadID = requiredString(input.leadID, "fleet.leadID");
  if (!Array.isArray(input.members)) {
    throw new MultiModelConfigError(
      "fleet.members must be an array.",
    );
  }
  const members = input.members.map(parseMember);
  const ids = new Set(members.map((member) => member.id));
  if (ids.size !== members.length) {
    throw new MultiModelConfigError("fleet member IDs must be unique.");
  }
  if (!ids.has(leadID)) {
    throw new MultiModelConfigError(
      `fleet.leadID ${leadID} must name a fleet member.`,
    );
  }
  return { leadID, members } satisfies Fleet;
}

function parseMember(value: unknown, index: number): FleetMember {
  const path = `fleet.members[${index}]`;
  const input = optionalObject(value, path);
  rejectUnknown(
    input,
    ["id", "role", "model", "agent", "system", "enabled", "isolation"],
    path,
  );
  const model = optionalObject(input.model, `${path}.model`);
  rejectUnknown(model, ["providerID", "modelID"], `${path}.model`);
  const isolation = input.isolation ?? "shared";
  if (isolation !== "shared" && isolation !== "worktree") {
    throw new MultiModelConfigError(
      `${path}.isolation must be "shared" or "worktree".`,
    );
  }
  if (typeof input.enabled !== "boolean") {
    throw new MultiModelConfigError(`${path}.enabled must be a boolean.`);
  }
  return {
    id: requiredString(input.id, `${path}.id`),
    role: requiredString(input.role, `${path}.role`),
    model: {
      providerID: requiredString(model.providerID, `${path}.model.providerID`),
      modelID: requiredString(model.modelID, `${path}.model.modelID`),
    },
    agent: optionalString(input.agent, `${path}.agent`),
    system: optionalString(input.system, `${path}.system`),
    enabled: input.enabled,
    isolation,
  };
}

function requiredString(value: unknown, path: string) {
  const result = optionalString(value, path);
  if (result !== undefined) return result;
  throw new MultiModelConfigError(`${path} is required.`);
}
