import { SESSION_MEMBER_ID } from "./dynamic.ts";
import type {
  DurableRun,
  Fleet,
  WorkflowStepRun,
} from "./types.ts";

export type AgentCallSnapshot = {
  stepID?: string;
  memberID: string;
  prompt: string;
  status: string;
  output?: string;
  error?: string;
  model?: string;
};

export type WorkflowBoardAgent = {
  key: string;
  stepID: string;
  memberID: string;
  role: "lead" | "worker";
  status: string;
  doing: string;
  prompt: string;
  output?: string;
  error?: string;
  model?: string;
};

export type WorkflowBoardTask = {
  id: string;
  title: string;
  status: string;
  agents: WorkflowBoardAgent[];
};

export type WorkflowBoardRun = {
  id: string;
  name: string;
  kind: "workflow" | "collaboration";
  status: string;
  active: boolean;
  input: string;
  overview: string;
  leadID: string;
  tasks: WorkflowBoardTask[];
};

const ACTIVE = new Set(["pending", "running", "paused"]);

export function isActiveRunStatus(status: string) {
  return ACTIVE.has(status);
}

export function runLeadID(run: DurableRun, fleet: Fleet) {
  if (run.steps.some((step) => step.memberID === SESSION_MEMBER_ID)) {
    return SESSION_MEMBER_ID;
  }
  return fleet.leadID;
}

export function listWorkflowBoardRuns(
  runs: DurableRun[],
  fleet: Fleet,
  calls: Record<string, AgentCallSnapshot[] | undefined> = {},
): WorkflowBoardRun[] {
  return [...runs]
    .sort((left, right) => {
      const active = Number(isActiveRunStatus(right.status)) -
        Number(isActiveRunStatus(left.status));
      if (active !== 0) return active;
      return right.updatedAt - left.updatedAt;
    })
    .map((run) => buildWorkflowBoardRun(run, fleet, calls[run.id] ?? []));
}

export function buildWorkflowBoardRun(
  run: DurableRun,
  fleet: Fleet,
  calls: AgentCallSnapshot[] = [],
): WorkflowBoardRun {
  const leadID = runLeadID(run, fleet);
  const tasks = run.steps.length > 0
    ? run.steps.map((step) => taskFromStep(step, leadID, calls))
    : [pendingTask(leadID)];
  if (run.kind === "workflow" && (run.final || run.status === "completed")) {
    const already = tasks.some((task) => task.id === "report");
    if (!already) {
      tasks.push({
        id: "report",
        title: "report",
        status: run.status === "completed" ? "completed" : run.status,
        agents: [{
          key: `report:${leadID}`,
          stepID: "report",
          memberID: leadID,
          role: "lead",
          status: run.status,
          doing: firstLine(run.final) || "Synthesize the result",
          prompt: "As LEAD, synthesize the final workflow result for the user.",
          output: run.final,
          error: run.error,
        }],
      });
    }
  }
  return {
    id: run.id,
    name: run.definition,
    kind: run.kind,
    status: run.status,
    active: isActiveRunStatus(run.status),
    input: run.input,
    overview: defaultOverview(run, leadID),
    leadID,
    tasks,
  };
}

export function boardOverview(
  run: WorkflowBoardRun,
  selected?: WorkflowBoardAgent,
) {
  if (!selected) return run.overview;
  return [
    `${selected.role.toUpperCase()} · ${selected.memberID} · ${selected.stepID}`,
    selected.model ? `model ${selected.model}` : undefined,
    `status ${selected.status}`,
    "",
    "Executing:",
    selected.prompt || "(no prompt recorded)",
    selected.output ? `\nResult:\n${selected.output}` : undefined,
    selected.error ? `\nError:\n${selected.error}` : undefined,
  ].filter((line) => line !== undefined).join("\n");
}

export function firstBoardAgent(run?: WorkflowBoardRun) {
  return preferredBoardAgent(run);
}

export function preferredBoardAgent(run?: WorkflowBoardRun) {
  const agents = run?.tasks.flatMap((task) => task.agents) ?? [];
  return agents.find((agent) => agent.status === "running") ??
    agents.find((agent) => agent.status === "failed") ??
    agents[0];
}

export function nextBoardAgent(run: WorkflowBoardRun, key?: string) {
  return stepBoardAgent(run, key, 1);
}

export function previousBoardAgent(run: WorkflowBoardRun, key?: string) {
  return stepBoardAgent(run, key, -1);
}

export function resolveWorkflowBoard(input: {
  runs: DurableRun[];
  fleet: Fleet;
  calls?: Record<string, AgentCallSnapshot[] | undefined>;
  selectedRunID?: string;
  selectedAgentKey?: string;
}) {
  const boards = listWorkflowBoardRuns(input.runs, input.fleet, input.calls);
  const selected = boards.find((run) => run.id === input.selectedRunID) ??
    boards[0];
  const selectedAgent = selected
    ? selected.tasks.flatMap((task) => task.agents).find((agent) =>
      agent.key === input.selectedAgentKey
    ) ?? preferredBoardAgent(selected)
    : undefined;
  return { boards, selected, selectedAgent };
}

export function adjacentBoardRun(
  runs: WorkflowBoardRun[],
  id: string | undefined,
  delta: number,
) {
  if (runs.length === 0) return undefined;
  const index = Math.max(0, runs.findIndex((run) => run.id === id));
  const next = (index + delta + runs.length) % runs.length;
  return runs[next];
}

export function chunkTasks(tasks: WorkflowBoardTask[], size = 2) {
  const rows: WorkflowBoardTask[][] = [];
  for (let index = 0; index < tasks.length; index += size) {
    rows.push(tasks.slice(index, index + size));
  }
  return rows;
}

function stepBoardAgent(
  run: WorkflowBoardRun,
  key: string | undefined,
  delta: number,
) {
  const agents = run.tasks.flatMap((task) => task.agents);
  if (agents.length === 0) return undefined;
  const index = agents.findIndex((agent) => agent.key === key);
  const start = index === -1 ? (delta > 0 ? -1 : 0) : index;
  return agents[(start + delta + agents.length) % agents.length];
}

function taskFromStep(
  step: WorkflowStepRun,
  leadID: string,
  calls: AgentCallSnapshot[],
): WorkflowBoardTask {
  const call = calls.find((item) => item.stepID === step.id) ??
    calls.find((item) => item.memberID === step.memberID);
  return {
    id: step.id,
    title: step.id,
    status: step.status,
    agents: [{
      key: `${step.id}:${step.memberID}`,
      stepID: step.id,
      memberID: step.memberID,
      role: step.memberID === leadID ? "lead" : "worker",
      status: step.status,
      doing: agentDoing(step, call),
      prompt: call?.prompt ?? step.output ?? "",
      output: call?.output ?? step.output,
      error: call?.error ?? step.error,
      model: call?.model,
    }],
  };
}

function pendingTask(leadID: string): WorkflowBoardTask {
  return {
    id: "queued",
    title: "queued",
    status: "pending",
    agents: [{
      key: `queued:${leadID}`,
      stepID: "queued",
      memberID: leadID,
      role: "lead",
      status: "pending",
      doing: "Waiting to start",
      prompt: "",
    }],
  };
}

function agentDoing(step: WorkflowStepRun, call?: AgentCallSnapshot) {
  if (step.status === "running") {
    return firstLine(call?.prompt) || "Working…";
  }
  if (step.status === "completed") {
    return firstLine(call?.output ?? step.output) || "Done";
  }
  if (step.status === "failed") {
    return firstLine(call?.error ?? step.error) || "Failed";
  }
  if (step.status === "pending") return "Waiting";
  if (step.status === "interrupted") return "Paused";
  return step.status;
}

function defaultOverview(run: DurableRun, leadID: string) {
  const done = run.steps.filter((step) => step.status === "completed").length;
  return [
    `${run.definition} · ${run.status} · ${run.kind}`,
    `lead ${leadID} · ${done}/${run.steps.length} tasks`,
    run.input ? `\nTask:\n${run.input}` : undefined,
    run.final ? `\nReport:\n${run.final}` : undefined,
    run.error ? `\nError:\n${run.error}` : undefined,
  ].filter((line) => line !== undefined).join("\n");
}

function firstLine(value?: string) {
  const line = value?.trim().split(/\r?\n/).find((item) => item.trim());
  if (!line) return "";
  return line.length > 56 ? `${line.slice(0, 53)}…` : line;
}
