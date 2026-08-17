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

export const WORKFLOW_HEARTBEAT_MS = 20_000;

export type WorkflowIndicator = {
  line: string;
  checklist: string;
  active: boolean;
  runID?: string;
};

export function formatWorkflowChecklist(run: DurableRun) {
  if (run.steps.length === 0) return run.status;
  return run.steps.map((step) => {
    const mark = step.status === "completed"
      ? "✓"
      : step.status === "running"
      ? "●"
      : step.status === "failed"
      ? "✗"
      : step.status === "cancelled" || step.status === "interrupted"
      ? "–"
      : "○";
    return step.status === "running"
      ? `${mark} ${step.id} ${step.memberID}`
      : `${mark} ${step.id}`;
  }).join("   ");
}

export function formatWorkflowIndicator(
  runs: DurableRun[],
  now = Date.now(),
): WorkflowIndicator {
  const live = [...runs]
    .filter((run) => isActiveRunStatus(run.status))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  if (live.length === 0) return { line: "", checklist: "", active: false };
  const run = live[0]!;
  const step = liveStep(run);
  const elapsed = formatElapsed(now - (step?.startedAt ?? run.updatedAt));
  const seat = step ? `${step.id}/${step.memberID}` : run.status;
  const extra = live.length > 1 ? `  +${live.length - 1} more` : "";
  return {
    line: `✻ Running ${run.definition} · ${seat} · ${elapsed}${extra}`,
    checklist: formatWorkflowChecklist(run),
    active: true,
    runID: run.id,
  };
}

export function workflowHeartbeatKey(run: DurableRun) {
  const step = liveStep(run);
  return `${run.id}:${run.status}:${step?.id ?? ""}:${step?.memberID ?? ""}`;
}

export function formatWorkflowHeartbeat(run: DurableRun, now = Date.now()) {
  const step = liveStep(run);
  const elapsed = formatElapsed(now - (step?.startedAt ?? run.updatedAt));
  if (step) {
    return `${run.definition} still working · ${step.id} · ${step.memberID} · ${elapsed}`;
  }
  return `${run.definition} still ${run.status} · ${elapsed}`;
}

export function shouldEmitWorkflowHeartbeat(input: {
  previousKey?: string;
  lastAt?: number;
  key: string;
  now: number;
  intervalMs?: number;
}) {
  if (!input.previousKey) return false;
  if (input.previousKey !== input.key) return true;
  return input.now - (input.lastAt ?? 0) >=
    (input.intervalMs ?? WORKFLOW_HEARTBEAT_MS);
}

function liveStep(run: DurableRun) {
  return run.steps.find((step) => step.status === "running") ??
    run.steps.find((step) => step.status === "pending");
}

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
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
  const live = selected.status === "running";
  return [
    `${selected.role.toUpperCase()} · ${selected.memberID} · ${selected.stepID}`,
    selected.model ? `model ${selected.model}` : undefined,
    `status ${selected.status}`,
    "",
    live ? "Executing:" : "Prompt:",
    selected.prompt || "(no prompt recorded)",
    selected.output ? `\nResult:\n${selected.output}` : undefined,
    selected.error ? `\nError:\n${selected.error}` : undefined,
  ].filter((line) => line !== undefined).join("\n");
}

export function executingBoardAgent(
  run?: WorkflowBoardRun,
  selectedKey?: string,
) {
  const live = preferredBoardAgent(run);
  if (live?.status === "running") return live;
  if (!run || !selectedKey) return live;
  return run.tasks.flatMap((task) => task.agents).find((agent) =>
    agent.key === selectedKey
  ) ?? live;
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
  const matching = calls.filter((item) =>
    item.stepID === step.id ||
    (!item.stepID && item.memberID === step.memberID)
  );
  const call = matching.at(-1) ??
    calls.find((item) => item.memberID === step.memberID);
  const status = fresherStatus(call?.status, step.status);
  return {
    id: step.id,
    title: step.id,
    status,
    agents: [{
      key: `${step.id}:${step.memberID}`,
      stepID: step.id,
      memberID: step.memberID,
      role: step.memberID === leadID ? "lead" : "worker",
      status,
      doing: agentDoing(step, call, status),
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

function agentDoing(
  step: WorkflowStepRun,
  call: AgentCallSnapshot | undefined,
  status: string,
) {
  if (status === "running") {
    return firstLine(call?.prompt) || firstLine(step.output) || "Working…";
  }
  if (status === "completed") {
    return firstLine(call?.output ?? step.output) || "Done";
  }
  if (status === "failed") {
    return firstLine(call?.error ?? step.error) || "Failed";
  }
  if (status === "cancelled" || status === "stopped") {
    return firstLine(step.error) || "Cancelled";
  }
  if (status === "pending") return "Waiting";
  if (status === "interrupted" || status === "paused") return "Paused";
  return status;
}

function fresherStatus(callStatus: string | undefined, stepStatus: string) {
  const rank: Record<string, number> = {
    pending: 0,
    queued: 0,
    waiting: 0,
    paused: 1,
    interrupted: 1,
    running: 2,
    completed: 3,
    failed: 3,
    cancelled: 3,
    stopped: 3,
  };
  if (!callStatus) return stepStatus;
  return (rank[callStatus] ?? 0) >= (rank[stepStatus] ?? 0)
    ? callStatus
    : stepStatus;
}

function defaultOverview(run: DurableRun, leadID: string) {
  const done = run.steps.filter((step) => step.status === "completed").length;
  const stalled = (run.status === "running" || run.status === "pending") &&
    run.steps.length > 0 &&
    run.steps.every((step) => step.status === "pending");
  return [
    `${run.definition} · ${run.status} · ${run.kind}`,
    `lead ${leadID} · ${done}/${run.steps.length} tasks`,
    run.input ? `\nTask:\n${run.input}` : undefined,
    stalled
      ? run.kind === "collaboration"
        ? "\nLead is planning. Worker tiles stay queued until they are invoked."
        : "\nAssigning seats and starting the first task…"
      : undefined,
    run.final ? `\nReport:\n${run.final}` : undefined,
    run.error ? `\nError:\n${run.error}` : undefined,
  ].filter((line) => line !== undefined).join("\n");
}

function firstLine(value?: string) {
  const line = value?.trim().split(/\r?\n/).find((item) => item.trim());
  if (!line) return "";
  return line.length > 56 ? `${line.slice(0, 53)}…` : line;
}
