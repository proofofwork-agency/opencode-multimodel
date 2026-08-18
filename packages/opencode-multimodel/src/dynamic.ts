import type {
  AgentRunner,
  DagWorkflowDefinition,
  Fleet,
  FleetMember,
  ModelRef,
  WorkflowDefinition,
  WorkflowStep,
} from "./types.ts";

export const DYNAMIC_WORKFLOW_NAME = "dynamic";
export const SESSION_MEMBER_ID = "session";

export type SessionSelection = {
  model?: ModelRef;
  agent?: string;
};

export type ParsedWorkflowCommand = {
  name?: string;
  input: string;
  dynamic: boolean;
};

export class SessionSelectionCache {
  private static readonly MAX_SESSIONS = 256;
  private readonly values = new Map<string, SessionSelection>();

  remember(sessionID: string, selection: SessionSelection) {
    if (!sessionID) return;
    const current = this.values.get(sessionID) ?? {};
    this.values.delete(sessionID);
    this.values.set(sessionID, {
      model: selection.model ?? current.model,
      agent: selection.agent ?? current.agent,
    });
    while (this.values.size > SessionSelectionCache.MAX_SESSIONS) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  get(sessionID: string) {
    const value = this.values.get(sessionID);
    if (value !== undefined) {
      this.values.delete(sessionID);
      this.values.set(sessionID, value);
    }
    return value;
  }
}

export function parseWorkflowCommand(
  raw: string,
  workflows: Array<{ name: string }>,
): ParsedWorkflowCommand {
  const trimmed = raw.trim();
  if (!trimmed) return { dynamic: true, input: "" };
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const first = match?.[1] ?? "";
  const rest = (match?.[2] ?? "").trim();
  const saved = workflows.find((workflow) => workflow.name === first);
  if (saved) {
    return { name: saved.name, input: rest, dynamic: false };
  }
  return { dynamic: true, input: trimmed };
}

export function resolveRunnableWorkflow(
  workflows: WorkflowDefinition[],
  name: string | undefined,
  input: string,
): { definition: WorkflowDefinition; input: string; dynamic: boolean } {
  if (name?.trim()) {
    const saved = workflows.find((workflow) => workflow.name === name.trim());
    if (saved) {
      return { definition: saved, input, dynamic: false };
    }
    if (name.trim() !== DYNAMIC_WORKFLOW_NAME) {
      const parsed = parseWorkflowCommand(
        input.trim() ? `${name} ${input}` : name,
        workflows,
      );
      if (!parsed.dynamic && parsed.name) {
        const matched = workflows.find((workflow) =>
          workflow.name === parsed.name
        );
        if (matched) {
          return { definition: matched, input: parsed.input, dynamic: false };
        }
      }
    }
  } else {
    const parsed = parseWorkflowCommand(input, workflows);
    if (!parsed.dynamic && parsed.name) {
      const matched = workflows.find((workflow) => workflow.name === parsed.name);
      if (matched) {
        return { definition: matched, input: parsed.input, dynamic: false };
      }
    }
  }

  const task = (input || name || "").trim();
  if (!task) {
    throw new Error(
      "Workflow input is required. Pass a task, for example /workflow audit auth on every route.",
    );
  }
  return {
    definition: defaultDynamicWorkflow(task),
    input: task,
    dynamic: true,
  };
}

export function defaultDynamicWorkflow(task: string): DagWorkflowDefinition {
  return {
    kind: "dag",
    name: DYNAMIC_WORKFLOW_NAME,
    description:
      "Understand, change, and verify, picking seats from the workflow fleet",
    synthesize: true,
    maxParallel: 3,
    steps: [
      {
        id: "understand",
        prompt: [
          "You are the understand phase of a dynamic workflow.",
          "Explore the repository and produce a concrete plan for this task:",
          "",
          "${input}",
          "",
          "Return the plan only: files to read or change, risks, and the exact implementation steps.",
        ].join("\n"),
      },
      {
        id: "change",
        needs: ["understand"],
        prompt: [
          "You are the change phase of a dynamic workflow.",
          "Execute the plan. Use tools to make the changes; do not stay in planning.",
          "",
          "Task:",
          "${input}",
          "",
          "Plan:",
          "${understand}",
          "",
          "Do the work. Return what you changed and any remaining risks.",
        ].join("\n"),
      },
      {
        id: "verify",
        needs: ["change"],
        prompt: [
          "You are the verify phase of a dynamic workflow.",
          "Check that the work is complete and correct. Run relevant checks if possible.",
          "",
          "Task:",
          "${input}",
          "",
          "Plan:",
          "${understand}",
          "",
          "Work:",
          "${change}",
          "",
          "Return a verdict, remaining issues, and what the user should know.",
        ].join("\n"),
      },
    ],
  };
}

export type WorkflowStepKind = "explore" | "implement" | "review" | "general";

export function pickWorkflowSeats(fleet: Fleet): FleetMember[] {
  const enabled = fleet.members.filter((member) => member.enabled);
  if (enabled.length === 0) return [];
  const lead = enabled.find((member) => member.id === fleet.leadID) ??
    enabled[0]!;
  return [lead, ...enabled.filter((member) => member.id !== lead.id)];
}

export function resolveFleetSeat(fleet: Fleet, spec: string) {
  const normalized = spec.trim().toLowerCase();
  if (!normalized) return undefined;
  return pickWorkflowSeats(fleet).find((member) =>
    member.id.toLowerCase() === normalized ||
    member.model.modelID.toLowerCase() === normalized ||
    `${member.model.providerID}/${member.model.modelID}`.toLowerCase() ===
      normalized
  );
}

export function workflowStepKind(step: {
  id: string;
  prompt: string;
}): WorkflowStepKind {
  return kindFromText(step.id.toLowerCase()) ??
    kindFromText(step.prompt.toLowerCase()) ??
    "general";
}

function kindFromText(text: string): WorkflowStepKind | undefined {
  if (/\b(change|implement|code|write|fix|patch|apply|edit|build)\b/.test(text)) {
    return "implement";
  }
  if (/\b(verify|review|test|audit|check|judge|validate)\b/.test(text)) {
    return "review";
  }
  if (/\b(understand|research|explore|plan|discover|survey)\b/.test(text)) {
    return "explore";
  }
  return undefined;
}

export function suggestMemberForStep(
  step: { id: string; prompt: string },
  fleet: Fleet,
  used: string[] = [],
  exclude: string[] = [],
) {
  const blocked = new Set(exclude);
  const seats = pickWorkflowSeats(fleet).filter((member) =>
    !blocked.has(member.id)
  );
  if (seats.length === 0) return undefined;
  const kind = workflowStepKind(step);
  return [...seats].sort((left, right) => {
    const score = seatScore(right, kind, fleet.leadID) -
      seatScore(left, kind, fleet.leadID);
    if (score !== 0) return score;
    return Number(used.includes(left.id)) - Number(used.includes(right.id));
  })[0];
}

export function assignFleetToWorkflow(
  definition: DagWorkflowDefinition,
  fleet: Fleet,
): DagWorkflowDefinition {
  const seats = pickWorkflowSeats(fleet);
  if (seats.length === 0) return definition;
  const lead = seats[0]!;
  return {
    ...definition,
    steps: definition.steps.map((step) => {
      if (step.memberID && resolveFleetSeat(fleet, step.memberID)) {
        return step;
      }
      return { ...step, memberID: lead.id };
    }),
  };
}

export function parseAssignmentBlock(text: string) {
  const assignments = new Map<string, string>();
  const fenced = text.match(/```(?:assign(?:ments?)?)?\s*\r?\n([\s\S]*?)```/i)
    ?.[1];
  const header = text.match(/^ASSIGN(?:MENTS?)?:\s*$/im);
  const block = fenced ??
    (header?.index === undefined
      ? undefined
      : text.slice(header.index + header[0].length));
  const source = block ?? text;
  source.split("\n").forEach((line) => {
    const match = line.match(
      /^\s*-?\s*([a-zA-Z0-9_-]+)\s*[:=]\s*([a-zA-Z0-9_./-]+)\s*$/,
    );
    if (match) assignments.set(match[1]!, match[2]!);
  });
  return assignments;
}

export async function routeWorkflowAssignments(input: {
  runner?: AgentRunner;
  fleet: Fleet;
  parentSessionID: string;
  definition: DagWorkflowDefinition;
  task: string;
  signal?: AbortSignal;
  runID?: string;
}): Promise<DagWorkflowDefinition> {
  const owned = assignFleetToWorkflow(input.definition, input.fleet);
  const seats = pickWorkflowSeats(input.fleet);
  const unassigned = input.definition.steps.filter((step) => !step.memberID);
  if (!input.runner || seats.length < 2 || unassigned.length === 0) {
    return owned;
  }
  const lead = seats[0]!;
  try {
    const reply = await input.runner.run({
      parentSessionID: input.parentSessionID,
      member: lead,
      prompt: routingPrompt(input.task, unassigned, seats, lead.id),
      signal: input.signal,
      runID: input.runID,
      stepID: "__route",
    });
    return applyLeadAssignments(
      owned,
      input.fleet,
      reply.text,
      new Set(
        input.definition.steps.flatMap((step) =>
          step.memberID ? [step.id] : []
        ),
      ),
    );
  } catch {
    return owned;
  }
}

export function applyLeadAssignments(
  definition: DagWorkflowDefinition,
  fleet: Fleet,
  text: string,
  locked: Set<string> = new Set(),
) {
  const assignments = parseAssignmentBlock(text);
  if (assignments.size === 0) return definition;
  return {
    ...definition,
    steps: definition.steps.map((step) => {
      if (locked.has(step.id)) return step;
      const picked = assignments.get(step.id);
      const seat = picked ? resolveFleetSeat(fleet, picked) : undefined;
      return seat ? { ...step, memberID: seat.id } : step;
    }),
  };
}

function routingPrompt(
  task: string,
  steps: WorkflowStep[],
  seats: FleetMember[],
  leadID: string,
) {
  return [
    `You are LEAD **${leadID}**. You own every step unless you explicitly assign it.`,
    `Task:\n${task}`,
    "Steps (currently yours):",
    ...steps.map((step) =>
      `- ${step.id} (${workflowStepKind(step)}): ${step.prompt.split("\n")[0]}`
    ),
    "Fleet. A worker starts only if you name it below:",
    ...seats.map((member) =>
      `- ${member.id}${member.id === leadID ? " (LEAD)" : ""} · ${member.role} · ${member.model.providerID}/${member.model.modelID}`
    ),
    "Suggestions only — do not treat these as already started:",
    ...steps.map((step) =>
      `- ${step.id}: ${suggestMemberForStep(step, { leadID, members: seats })?.id ?? leadID}`
    ),
    "Keep a step on the lead unless another seat is clearly better. Never assign a seat you do not want started.",
    "Return exactly:",
    "ASSIGN:",
    ...steps.map((step) => `${step.id}: <seat-id>`),
  ].join("\n");
}

function seatScore(
  member: FleetMember,
  kind: WorkflowStepKind,
  leadID: string,
) {
  const blob = [
    member.id,
    member.role,
    member.model.providerID,
    member.model.modelID,
  ].join(" ").toLowerCase();
  let score = 0;
  if (member.id === leadID) score += 1;
  if (kind === "implement") {
    if (/codex|delegate|implement|builder|sol|terra|luna/.test(blob)) score += 8;
    if (/gpt-5|gpt5/.test(blob)) score += 2;
    if (member.id === leadID) score -= 2;
  }
  if (kind === "explore") {
    if (/session|lead|plan|research|grok|claude|glm/.test(blob)) score += 5;
    if (member.id === leadID) score += 3;
  }
  if (kind === "review") {
    if (/review|audit|verify|judge|grok|claude/.test(blob)) score += 5;
    if (/codex|delegate/.test(blob)) score -= 2;
    if (member.id === leadID) score += 2;
  }
  return score;
}

export function normalizeWorkflowAgent(agent?: string) {
  if (!agent || agent === "plan") return undefined;
  return agent;
}

export function applySessionModel(
  fleet: Fleet,
  selection: SessionSelection = {},
): Fleet {
  const workflowAgent = normalizeWorkflowAgent(selection.agent);
  const members = fleet.members
    .filter((member) => member.id !== SESSION_MEMBER_ID)
    .map((member) => ({
      ...member,
      agent: normalizeWorkflowAgent(member.agent),
    }));

  if (selection.model) {
    const sessionMember: FleetMember = {
      id: SESSION_MEMBER_ID,
      role: "session model",
      model: selection.model,
      agent: workflowAgent,
      enabled: true,
      isolation: "shared",
    };
    return {
      leadID: SESSION_MEMBER_ID,
      members: [sessionMember, ...members],
    };
  }

  if (members.length === 0) {
    throw new Error(
      "No session model is available and the fleet is empty. Select a model in the session or add a fleet seat with /fleet.",
    );
  }

  return {
    leadID: members.some((member) => member.id === fleet.leadID)
      ? fleet.leadID
      : members[0]!.id,
    members,
  };
}

export function mergeSessionSelection(
  ...values: Array<SessionSelection | undefined>
): SessionSelection {
  return values.reduce<SessionSelection>((merged, value) => ({
    model: value?.model ?? merged.model,
    agent: value?.agent ?? merged.agent,
  }), {});
}
