import { AgentBudget, defaultAgentBudget } from "./budget.ts";
import { mapLimit } from "./concurrency.ts";
import { formatBallots, parsePanelVote, tallyMajority } from "./jury.ts";
import { collaborationSystem, judgePrompt, jurorPrompt } from "./prompts.ts";
import type {
  AgentReply,
  AgentRunner,
  CollabActivityPhase,
  CollaborationResult,
  CollaborateOptions,
  Fleet,
  FleetMember,
  JuryVerdict,
  PanelVote,
} from "./types.ts";

const MAX_WORKERS = 8;
const MAX_PARALLEL = 6;
const MAX_TASKS = 8;

export async function collaborate(
  runner: AgentRunner,
  fleet: Fleet,
  parentSessionID: string,
  prompt: string,
  options: CollaborateOptions = {},
): Promise<CollaborationResult> {
  if (!prompt.trim()) throw new Error("A collaboration prompt is required.");
  const participants = selectParticipants(fleet, options);
  const lead = participants.find((member) => member.id === fleet.leadID);
  if (!lead)
    throw new Error(`Fleet lead ${fleet.leadID} is missing or disabled.`);
  const workers = participants.filter((member) => member.id !== lead.id);
  const mode = options.mode ?? "lead";
  const rounds = options.juryRounds ?? (mode === "jury" ? 2 : 1);
  const budget = new AgentBudget(
    options.agentBudget ?? defaultAgentBudget(mode, workers.length, rounds),
  );
  const context = {
    runner,
    parentSessionID,
    prompt,
    options,
    participants,
    lead,
    workers,
    budget,
    nextCall: 0,
    replies: [] as AgentReply[],
    log: [] as string[],
  };

  participants.forEach((member) =>
    activity(
      context,
      member,
      member.id === lead.id ? "waiting" : "queued",
      `${mode} ready`,
    ),
  );
  try {
    if (mode === "lead" || workers.length === 0)
      return await leadOnly(context, mode);
    if (mode === "pair") return await pair(context, "pair", workers[0]!);
    if (mode === "handoff") {
      return await pair(
        context,
        "handoff",
        workers.find((member) => member.id === options.handoffTo) ??
          workers[0]!,
      );
    }
    if (mode === "round") return await round(context);
    if (mode === "orchestrate") return await orchestrate(context);
    if (mode === "jury" || mode === "panel" || mode === "deliberate") {
      return await jury(context, mode, rounds);
    }
    return await council(context);
  } finally {
    participants.forEach((member) => activity(context, member, "idle", ""));
  }
}

type CollaborationContext = {
  runner: AgentRunner;
  parentSessionID: string;
  prompt: string;
  options: CollaborateOptions;
  participants: FleetMember[];
  lead: FleetMember;
  workers: FleetMember[];
  budget: AgentBudget;
  nextCall: number;
  replies: AgentReply[];
  log: string[];
};

async function leadOnly(
  context: CollaborationContext,
  mode: CollaborationResult["mode"],
) {
  const final = await invoke(
    context,
    context.lead,
    `User request:\n${context.prompt}\n\nAnswer the user directly as LEAD.`,
    "thinking",
    "lead answer",
  );
  context.log.push(`human → lead:${context.lead.id} → human`);
  return result(context, mode, final, [context.lead]);
}

async function pair(
  context: CollaborationContext,
  mode: "pair" | "handoff",
  worker: FleetMember,
) {
  const plan = await invoke(
    context,
    context.lead,
    `User request:\n${context.prompt}\n\nWrite one clear ${mode} task for worker **${worker.id}**.`,
    "thinking",
    `${mode} plan for ${worker.id}`,
  );
  context.log.push(`lead:${context.lead.id} → ${worker.id}`);
  activity(context, context.lead, "waiting", `${mode} waiting`, worker.id);
  const work = await invoke(
    context,
    worker,
    `User request:\n${context.prompt}\n\nLEAD **${context.lead.id}** assigned:\n${plan.text}\n\nExecute the task and return concrete findings to the lead.`,
    "thinking",
    `${mode} worker`,
  );
  context.log.push(`${worker.id} → lead:${context.lead.id}`);
  const final = await invoke(
    context,
    context.lead,
    `User request:\n${context.prompt}\n\nYour assignment:\n${plan.text}\n\nWorker **${worker.id}** replied:\n${work.text}\n\nWrite the final answer for the user.`,
    "synthesizing",
    `${mode} final`,
  );
  context.log.push(`lead:${context.lead.id} → human`);
  return result(context, mode, final, [context.lead, worker]);
}

async function round(context: CollaborationContext) {
  const contributions: AgentReply[] = [];
  for (const [index, member] of context.participants.entries()) {
    const transcript = contributions
      .map((reply) => `### ${reply.memberID}\n${reply.text}`)
      .join("\n\n");
    const reply = await invoke(
      context,
      member,
      [
        `User request:\n${context.prompt}`,
        member.id === context.lead.id
          ? "You are LEAD. Set direction for the round."
          : `You are a worker. LEAD is **${context.lead.id}**.`,
        transcript
          ? `Earlier contributions:\n${transcript}`
          : "You speak first.",
        "Add a concise, non-duplicative contribution for the team.",
      ].join("\n\n"),
      "thinking",
      `round ${index + 1}/${context.participants.length}`,
    );
    contributions.push(reply);
    context.log.push(`${member.id} → fleet`);
  }
  return result(context, "round", contributions.at(-1)!, context.participants);
}

async function council(context: CollaborationContext) {
  activity(
    context,
    context.lead,
    "waiting",
    "council waiting",
    context.workers.map((member) => member.id).join(","),
  );
  const views = await mapLimit(
    context.workers,
    parallelism(context),
    (member) =>
      invokeOptional(
        context,
        member,
        `User request:\n${context.prompt}\n\nGive an independent expert view to LEAD **${context.lead.id}**. Focus on evidence, risks, and a recommendation.`,
        "thinking",
        "council view",
      ),
  );
  views.forEach((reply) =>
    context.log.push(
      `${reply.memberID} → lead:${context.lead.id}${reply.error ? " (error)" : ""}`,
    ),
  );
  const final = await invoke(
    context,
    context.lead,
    `User request:\n${context.prompt}\n\nCouncil views:\n${formatReplies(views)}\n\nSynthesize the final answer, including important disagreement.`,
    "synthesizing",
    "council final",
  );
  return result(context, "council", final);
}

async function orchestrate(context: CollaborationContext) {
  const plan = await invoke(
    context,
    context.lead,
    [
      `User request:\n${context.prompt}`,
      "Plan the answer and assign zero or more active workers with a TASKS block.",
      `Available workers: ${context.workers.map((member) => member.id).join(", ")}.`,
      "Use this exact format:",
      "TASKS:",
      "- model: <worker-id>",
      "  prompt: <specific task>",
    ].join("\n\n"),
    "thinking",
    "orchestrate plan",
  );
  const parsed = parseTasksBlock(plan.text).slice(0, MAX_TASKS);
  const assignments = (
    parsed.length
      ? parsed
      : [{ model: context.workers[0]!.id, prompt: context.prompt }]
  )
    .map((task) => ({
      task,
      member: resolveWorker(context.workers, task.model),
    }))
    .filter(
      (assignment): assignment is { task: ParsedTask; member: FleetMember } =>
        !!assignment.member,
    );
  const replies = await mapLimit(
    assignments,
    parallelism(context),
    (assignment) =>
      invokeOptional(
        context,
        assignment.member,
        `User request:\n${context.prompt}\n\nLEAD plan:\n${stripTasksBlock(plan.text)}\n\nYour assigned task:\n${assignment.task.prompt}`,
        "thinking",
        "orchestrate task",
      ),
  );
  const final = await invoke(
    context,
    context.lead,
    `User request:\n${context.prompt}\n\nYour plan:\n${stripTasksBlock(plan.text)}\n\nWorker results:\n${formatReplies(replies)}\n\nWrite the final answer for the user.`,
    "synthesizing",
    "orchestrate final",
  );
  return result(context, "orchestrate", final, [
    context.lead,
    ...assignments.map((assignment) => assignment.member),
  ]);
}

async function jury(
  context: CollaborationContext,
  mode: "jury" | "panel" | "deliberate",
  rounds: 1 | 2,
) {
  let votes = await juryRound(context, 1);
  if (rounds === 2) votes = await juryRound(context, 2, votes);
  const majority = tallyMajority(votes);
  const final = await invoke(
    context,
    context.lead,
    judgePrompt(context.prompt, context.lead, votes, majority),
    "synthesizing",
    `${mode} verdict`,
  );
  const models = new Set(
    [context.lead, ...context.workers].map(
      (member) => `${member.model.providerID}/${member.model.modelID}`,
    ),
  );
  const verdict: JuryVerdict = {
    question: context.prompt,
    judgeID: context.lead.id,
    jurors: context.workers.map((member) => member.id),
    votes,
    majority,
    decision: final.text,
    rounds,
    multiModel: models.size >= 2,
    budget: context.budget.snapshot(),
  };
  return { ...result(context, mode, final), jury: verdict };
}

async function juryRound(
  context: CollaborationContext,
  round: 1 | 2,
  previous: PanelVote[] = [],
) {
  const ballots = previous.length ? formatBallots(previous) : undefined;
  const replies = await mapLimit(
    context.workers,
    parallelism(context),
    (member) =>
      invokeOptional(
        context,
        member,
        jurorPrompt({
          question: context.prompt,
          juror: member,
          lead: context.lead,
          participants: context.participants,
          round,
          peerBallots: ballots,
        }),
        "thinking",
        `jury round ${round}`,
      ),
  );
  return replies.map((reply) =>
    parsePanelVote(reply.memberID, reply.model, reply.text),
  );
}

async function invoke(
  context: CollaborationContext,
  member: FleetMember,
  prompt: string,
  phase: Extract<CollabActivityPhase, "thinking" | "synthesizing">,
  detail: string,
) {
  context.options.signal?.throwIfAborted();
  context.budget.spend(`${member.id}/${phase}`);
  activity(context, member, phase, detail);
  try {
    const callIndex = context.nextCall++;
    const reply = await context.runner.run({
      parentSessionID: context.parentSessionID,
      member,
      prompt,
      system: collaborationSystem(member, context.lead, context.participants),
      signal: context.options.signal,
      runID: context.options.runID,
      callIndex,
    });
    context.replies.push(reply);
    activity(context, member, "done", detail);
    return reply;
  } catch (error) {
    activity(context, member, "error", message(error));
    throw error;
  }
}

async function invokeOptional(
  context: CollaborationContext,
  member: FleetMember,
  prompt: string,
  phase: Extract<CollabActivityPhase, "thinking" | "synthesizing">,
  detail: string,
) {
  try {
    return await invoke(context, member, prompt, phase, detail);
  } catch (error) {
    const reply = {
      memberID: member.id,
      sessionID: "",
      model: member.model,
      text: `(worker error) ${message(error)}`,
      error: message(error),
    };
    context.replies.push(reply);
    return reply;
  }
}

function selectParticipants(fleet: Fleet, options: CollaborateOptions) {
  const enabled = fleet.members.filter((member) => member.enabled);
  const requested = options.participants?.length
    ? enabled.filter(
        (member) =>
          options.participants?.includes(member.id) ||
          member.id === fleet.leadID,
      )
    : enabled;
  const lead = enabled.find((member) => member.id === fleet.leadID);
  if (!lead) return requested;
  return [
    lead,
    ...requested
      .filter((member) => member.id !== lead.id)
      .slice(0, Math.min(options.maxWorkers ?? MAX_WORKERS, MAX_WORKERS)),
  ];
}

function result(
  context: CollaborationContext,
  mode: CollaborationResult["mode"],
  final: AgentReply,
  participants = context.participants,
): CollaborationResult {
  return {
    mode,
    leadID: context.lead.id,
    participants: [...new Set(participants.map((member) => member.id))],
    replies: context.replies,
    final,
    log: context.log,
  };
}

function activity(
  context: CollaborationContext,
  member: FleetMember,
  phase: CollabActivityPhase,
  detail: string,
  waitingOn?: string,
) {
  context.options.onActivity?.({
    memberID: member.id,
    phase,
    detail,
    waitingOn,
    model: member.model,
  });
}

function parallelism(context: CollaborationContext) {
  return Math.min(Math.max(1, context.options.maxParallel ?? 3), MAX_PARALLEL);
}

function formatReplies(replies: AgentReply[]) {
  return replies
    .map(
      (reply) =>
        `### ${reply.memberID}${reply.error ? " (error)" : ""}\n${reply.text}`,
    )
    .join("\n\n");
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type ParsedTask = { model: string; prompt: string };

export function parseTasksBlock(text: string): ParsedTask[] {
  const fenced = text.match(/```(?:tasks?)\s*\r?\n([\s\S]*?)```/i)?.[1];
  const header = text.match(/^TASKS:\s*$/im);
  const block =
    fenced ??
    (header?.index === undefined
      ? undefined
      : text.slice(header.index + header[0].length));
  if (!block) return [];
  const tasks: ParsedTask[] = [];
  let model = "";
  let prompt = "";
  let multiline = false;
  const flush = () => {
    if (model && prompt.trim())
      tasks.push({ model: model.trim(), prompt: prompt.trim() });
    model = "";
    prompt = "";
    multiline = false;
  };
  block.split("\n").forEach((line) => {
    const nextModel = line.match(/^\s*-\s*model:\s*(.+)\s*$/i)?.[1];
    if (nextModel) {
      flush();
      model = nextModel;
      return;
    }
    const nextPrompt = line.match(/^\s*prompt:\s*(.*)$/i)?.[1];
    if (nextPrompt !== undefined) {
      multiline = /^(?:\||>|\|-|>-)\s*$/.test(nextPrompt);
      prompt = multiline ? "" : nextPrompt;
      return;
    }
    if (multiline && /^\s+/.test(line))
      prompt += `${prompt ? "\n" : ""}${line.replace(/^\s{2,4}/, "")}`;
  });
  flush();
  return tasks;
}

export function stripTasksBlock(text: string) {
  const withoutFence = text
    .replace(/```(?:tasks?)\s*\r?\n[\s\S]*?```/gi, "")
    .trim();
  const index = withoutFence.search(/^TASKS:\s*$/im);
  return index < 0 ? withoutFence : withoutFence.slice(0, index).trim();
}

function resolveWorker(workers: FleetMember[], spec: string) {
  const normalized = spec.toLowerCase();
  return workers.find(
    (member) =>
      member.id.toLowerCase() === normalized ||
      member.model.modelID.toLowerCase() === normalized ||
      `${member.model.providerID}/${member.model.modelID}`.toLowerCase() ===
        normalized,
  );
}
