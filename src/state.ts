import { dirname, resolve } from "node:path";
import type {
  Fleet,
  FleetMember,
  PersistedState,
  WorkflowDefinition,
  WorkflowRun,
} from "./types.ts";

const EMPTY_STATE: PersistedState = {
  version: 1,
  fleet: { leadID: "lead", members: [] },
  workflows: [],
  runs: [],
};

export class StateStore {
  private lane = Promise.resolve();

  constructor(readonly path: string) {}

  async read(): Promise<PersistedState> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return structuredClone(EMPTY_STATE);
    const value: unknown = await file.json();
    return normalizeState(value);
  }

  update(change: (state: PersistedState) => void | Promise<void>) {
    const next = this.lane.then(async () => {
      const state = await this.read();
      await change(state);
      await Bun.write(
        this.path,
        `${JSON.stringify({ ...state, runs: state.runs.slice(-100) }, null, 2)}\n`,
        { createPath: true },
      );
      return state;
    });
    this.lane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  initializeFleet(fleet: Fleet) {
    return this.update((state) => {
      if (state.fleet.members.length > 0) return;
      state.fleet = normalizeFleet(fleet);
    });
  }

  setLead(leadID: string) {
    return this.update((state) => {
      if (!state.fleet.members.some((member) => member.id === leadID)) {
        throw new Error(`Fleet member ${leadID} does not exist.`);
      }
      state.fleet.leadID = leadID;
    });
  }

  upsertMember(member: FleetMember) {
    return this.update((state) => {
      const index = state.fleet.members.findIndex(
        (item) => item.id === member.id,
      );
      if (index === -1) state.fleet.members.push(member);
      if (index !== -1) state.fleet.members[index] = member;
      if (!state.fleet.members.some((item) => item.id === state.fleet.leadID)) {
        state.fleet.leadID = member.id;
      }
    });
  }

  removeMember(memberID: string) {
    return this.update((state) => {
      state.fleet.members = state.fleet.members.filter(
        (member) => member.id !== memberID,
      );
      if (state.fleet.leadID === memberID)
        state.fleet.leadID = state.fleet.members[0]?.id ?? "lead";
    });
  }

  saveWorkflow(definition: WorkflowDefinition) {
    return this.update((state) => {
      const index = state.workflows.findIndex(
        (item) => item.name === definition.name,
      );
      if (index === -1) state.workflows.push(definition);
      if (index !== -1) state.workflows[index] = definition;
    });
  }

  saveRun(run: WorkflowRun) {
    return this.update((state) => {
      const index = state.runs.findIndex((item) => item.id === run.id);
      if (index === -1) state.runs.push(run);
      if (index !== -1) state.runs[index] = run;
    });
  }
}

export function defaultStatePath(directory: string) {
  return resolve(directory, ".opencode", "multimodel.json");
}

export function stateDirectory(path: string) {
  return dirname(path);
}

function normalizeState(value: unknown): PersistedState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return structuredClone(EMPTY_STATE);
  const input = value as Partial<PersistedState>;
  const fleet = normalizeFleet(input.fleet);
  return {
    version: 1,
    fleet,
    workflows: Array.isArray(input.workflows)
      ? input.workflows.filter(isWorkflow)
      : [],
    runs: Array.isArray(input.runs) ? input.runs.filter(isRun).slice(-100) : [],
  };
}

function normalizeFleet(value: unknown): Fleet {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return structuredClone(EMPTY_STATE.fleet);
  const input = value as Partial<Fleet>;
  const members = Array.isArray(input.members)
    ? input.members.filter(isMember)
    : [];
  const leadID =
    typeof input.leadID === "string" &&
    members.some((member) => member.id === input.leadID)
      ? input.leadID
      : (members[0]?.id ?? "lead");
  return { leadID, members };
}

function isMember(value: unknown): value is FleetMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<FleetMember>;
  return (
    typeof item.id === "string" &&
    typeof item.role === "string" &&
    typeof item.enabled === "boolean" &&
    !!item.model &&
    typeof item.model.providerID === "string" &&
    typeof item.model.modelID === "string"
  );
}

function isWorkflow(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<WorkflowDefinition>;
  return typeof item.name === "string" && Array.isArray(item.steps);
}

function isRun(value: unknown): value is WorkflowRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<WorkflowRun>;
  return (
    typeof item.id === "string" &&
    typeof item.definition === "string" &&
    Array.isArray(item.steps)
  );
}
