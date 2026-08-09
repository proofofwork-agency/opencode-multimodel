import {
  COLLAB_MODES,
  type CollabMode,
  type Fleet,
  type FleetMember,
} from "./types.ts";

export type MultiModelOptions = {
  statePath?: string;
  fleet?: Fleet;
  defaultMode: CollabMode;
  maxWorkers: number;
  maxParallel: number;
};

export function parseOptions(
  value: Record<string, unknown> | undefined,
): MultiModelOptions {
  return {
    statePath:
      typeof value?.statePath === "string" ? value.statePath : undefined,
    fleet: isFleet(value?.fleet) ? value.fleet : undefined,
    defaultMode: isMode(value?.defaultMode) ? value.defaultMode : "council",
    maxWorkers: integer(value?.maxWorkers, 8, 1, 8),
    maxParallel: integer(value?.maxParallel, 3, 1, 6),
  };
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, minimum), maximum);
}

function isMode(value: unknown): value is CollabMode {
  return (
    typeof value === "string" &&
    (COLLAB_MODES as readonly string[]).includes(value)
  );
}

function isFleet(value: unknown): value is Fleet {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fleet = value as { leadID?: unknown; members?: unknown };
  return (
    typeof fleet.leadID === "string" &&
    Array.isArray(fleet.members) &&
    fleet.members.every(isMember)
  );
}

function isMember(value: unknown): value is FleetMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const member = value as Partial<FleetMember>;
  return (
    typeof member.id === "string" &&
    typeof member.role === "string" &&
    typeof member.enabled === "boolean" &&
    !!member.model &&
    typeof member.model.providerID === "string" &&
    typeof member.model.modelID === "string"
  );
}
