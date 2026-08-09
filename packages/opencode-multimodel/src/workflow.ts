import { mapLimit } from "./concurrency.ts";
import { collaborationSystem } from "./prompts.ts";
import type {
  AgentRunner,
  Fleet,
  FleetMember,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunOptions,
  WorkflowStep,
  WorkflowStepRun,
} from "./types.ts";

const MAX_STEPS = 64;
const MAX_PARALLEL = 6;

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export function validateWorkflow(definition: WorkflowDefinition) {
  if (!definition.name.trim())
    throw new WorkflowValidationError("Workflow name is required.");
  if (definition.steps.length === 0)
    throw new WorkflowValidationError(
      "Workflow must contain at least one step.",
    );
  if (definition.steps.length > MAX_STEPS)
    throw new WorkflowValidationError(`Workflow exceeds ${MAX_STEPS} steps.`);
  const ids = new Set<string>();
  definition.steps.forEach((step) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(step.id)) {
      throw new WorkflowValidationError(
        `Invalid step id ${step.id}. Use letters, numbers, _ or -.`,
      );
    }
    if (ids.has(step.id))
      throw new WorkflowValidationError(`Duplicate step id ${step.id}.`);
    if (!step.prompt.trim())
      throw new WorkflowValidationError(`Step ${step.id} has an empty prompt.`);
    ids.add(step.id);
  });
  definition.steps.forEach((step) =>
    (step.needs ?? []).forEach((dependency) => {
      if (!ids.has(dependency))
        throw new WorkflowValidationError(
          `Step ${step.id} needs missing step ${dependency}.`,
        );
      if (dependency === step.id)
        throw new WorkflowValidationError(
          `Step ${step.id} cannot depend on itself.`,
        );
    }),
  );
  const remaining = new Set(ids);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const step = definition.steps.find((item) => item.id === id)!;
      return (step.needs ?? []).every(
        (dependency) => !remaining.has(dependency),
      );
    });
    if (ready.length === 0)
      throw new WorkflowValidationError(
        "Workflow contains a dependency cycle.",
      );
    ready.forEach((id) => remaining.delete(id));
  }
  return definition;
}

export async function runWorkflow(
  runner: AgentRunner,
  fleet: Fleet,
  parentSessionID: string,
  definition: WorkflowDefinition,
  input: string,
  options: WorkflowRunOptions = {},
) {
  validateWorkflow(definition);
  const lead = fleet.members.find(
    (member) => member.id === fleet.leadID && member.enabled,
  );
  if (!lead)
    throw new Error(`Fleet lead ${fleet.leadID} is missing or disabled.`);
  const createdAt = Date.now();
  const run: WorkflowRun = {
    id: `workflow_${crypto.randomUUID()}`,
    definition: definition.name,
    sessionID: parentSessionID,
    input,
    status: "pending",
    steps: definition.steps.map((step) => ({
      id: step.id,
      status: "pending",
      memberID: step.memberID ?? lead.id,
    })),
    createdAt,
    updatedAt: createdAt,
  };
  await update(run, options, () => {
    run.status = "running";
  });

  try {
    while (run.steps.some((step) => step.status === "pending")) {
      options.signal?.throwIfAborted();
      cancelBlockedSteps(run, definition);
      const ready = definition.steps.filter((step) => {
        const state = findRunStep(run, step.id);
        return (
          state.status === "pending" &&
          (step.needs ?? []).every((dependency) =>
            isTerminal(findRunStep(run, dependency)),
          )
        );
      });
      if (
        ready.length === 0 &&
        run.steps.some((step) => step.status === "pending")
      ) {
        throw new Error("Workflow cannot make progress.");
      }
      await mapLimit(
        ready,
        Math.min(Math.max(1, definition.maxParallel ?? 3), MAX_PARALLEL),
        (step) =>
          executeStep(
            runner,
            fleet,
            lead,
            parentSessionID,
            definition,
            step,
            run,
            options,
          ),
      );
      const hardFailure = definition.steps.find((step) => {
        const state = findRunStep(run, step.id);
        return state.status === "failed" && step.continueOnError !== true;
      });
      if (hardFailure) {
        await update(run, options, () => {
          run.steps
            .filter((step) => step.status === "pending")
            .forEach((step) => {
              step.status = "cancelled";
              step.error = `Blocked by failed step ${hardFailure.id}.`;
              step.completedAt = Date.now();
            });
          run.status = "failed";
          run.error = `Step ${hardFailure.id} failed.`;
        });
        return run;
      }
    }

    if (definition.synthesize) {
      options.signal?.throwIfAborted();
      const response = await runner.run({
        parentSessionID,
        member: lead,
        prompt: [
          `Workflow **${definition.name}** input:\n${input}`,
          "Step results:",
          ...run.steps.map(
            (step) =>
              `### ${step.id} (${step.status})\n${step.output ?? step.error ?? "No output"}`,
          ),
          "As LEAD, synthesize the final workflow result for the user.",
        ].join("\n\n"),
        system: collaborationSystem(
          lead,
          lead,
          fleet.members.filter((member) => member.enabled),
        ),
        signal: options.signal,
      });
      await update(run, options, () => {
        run.final = response.text;
      });
    }

    await update(run, options, () => {
      run.status = definition.steps.some(
        (step) =>
          findRunStep(run, step.id).status === "failed" &&
          step.continueOnError !== true,
      )
        ? "failed"
        : "completed";
      if (!run.final) run.final = run.steps.at(-1)?.output;
    });
    return run;
  } catch (error) {
    const cancelled = options.signal?.aborted === true;
    await update(run, options, () => {
      run.status = cancelled ? "cancelled" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.steps
        .filter(
          (step) => step.status === "pending" || step.status === "running",
        )
        .forEach((step) => {
          step.status = "cancelled";
          step.error = cancelled ? "Workflow cancelled." : "Workflow stopped.";
          step.completedAt = Date.now();
        });
    });
    if (cancelled) await runner.cancel?.(parentSessionID);
    return run;
  }
}

async function executeStep(
  runner: AgentRunner,
  fleet: Fleet,
  lead: FleetMember,
  parentSessionID: string,
  definition: WorkflowDefinition,
  step: WorkflowStep,
  run: WorkflowRun,
  options: WorkflowRunOptions,
) {
  const state = findRunStep(run, step.id);
  await update(run, options, () => {
    state.status = "running";
    state.startedAt = Date.now();
  });
  const member = workflowMember(fleet, lead, step);
  try {
    const response = await runner.run({
      parentSessionID,
      member,
      prompt: interpolate(step.prompt, inputValues(run)),
      system: [
        collaborationSystem(
          member,
          lead,
          fleet.members.filter((item) => item.enabled),
        ),
        `You are executing declarative workflow **${definition.name}**, step **${step.id}**. Return only this step's concrete result.`,
      ].join("\n\n"),
      signal: options.signal,
    });
    await update(run, options, () => {
      state.status = "completed";
      state.memberID = member.id;
      state.output = response.text;
      state.completedAt = Date.now();
    });
  } catch (error) {
    await update(run, options, () => {
      state.status = "failed";
      state.memberID = member.id;
      state.error = error instanceof Error ? error.message : String(error);
      state.completedAt = Date.now();
    });
  }
}

function workflowMember(fleet: Fleet, lead: FleetMember, step: WorkflowStep) {
  const base = step.memberID
    ? fleet.members.find(
        (member) => member.id === step.memberID && member.enabled,
      )
    : lead;
  if (!base)
    throw new Error(
      `Workflow step ${step.id} selects missing or disabled member ${step.memberID}.`,
    );
  if (!step.model && !step.agent) return base;
  return {
    ...base,
    model: step.model ?? base.model,
    agent: step.agent ?? base.agent,
  };
}

function inputValues(run: WorkflowRun) {
  return Object.fromEntries([
    ["input", run.input],
    ...run.steps.map(
      (step) => [step.id, step.output ?? step.error ?? ""] as const,
    ),
  ]);
}

export function interpolate(template: string, values: Record<string, string>) {
  return template.replace(
    /\$\{([a-zA-Z0-9_-]+)\}/g,
    (match, key: string) => values[key] ?? match,
  );
}

function cancelBlockedSteps(run: WorkflowRun, definition: WorkflowDefinition) {
  definition.steps.forEach((step) => {
    const state = findRunStep(run, step.id);
    if (state.status !== "pending") return;
    const failed = (step.needs ?? []).find((dependency) => {
      const dependencyState = findRunStep(run, dependency);
      const dependencyDefinition = definition.steps.find(
        (item) => item.id === dependency,
      )!;
      return (
        (dependencyState.status === "failed" ||
          dependencyState.status === "cancelled") &&
        dependencyDefinition.continueOnError !== true
      );
    });
    if (!failed) return;
    state.status = "cancelled";
    state.error = `Blocked by failed dependency ${failed}.`;
    state.completedAt = Date.now();
  });
}

function findRunStep(run: WorkflowRun, id: string): WorkflowStepRun {
  return run.steps.find((step) => step.id === id)!;
}

function isTerminal(step: WorkflowStepRun) {
  return (
    step.status === "completed" ||
    step.status === "failed" ||
    step.status === "cancelled"
  );
}

async function update(
  run: WorkflowRun,
  options: WorkflowRunOptions,
  change: () => void,
) {
  change();
  run.updatedAt = Date.now();
  await options.onUpdate?.(structuredClone(run));
}
