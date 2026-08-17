import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mapLimit } from "./concurrency.ts";
import {
  normalizeWorkflowAgent,
  resolveFleetSeat,
  suggestMemberForStep,
} from "./dynamic.ts";
import { collaborationSystem } from "./prompts.ts";
import { workflowSourceHash } from "./state.ts";
import type {
  AgentRunner,
  Fleet,
  FleetMember,
  ModelRef,
  ModuleWorkflowDefinition,
  WorkflowRun,
  WorkflowRunOptions,
  WorkflowStepRun,
} from "./types.ts";
import type {
  WorkflowAgentInput,
  WorkflowAgentResult,
  WorkflowContext,
  WorkflowDefinition as AuthoredWorkflow,
  WorkflowPhase,
} from "./workflow-api.ts";
import {
  coerceWorkflowArgs,
  parseWorkflowArgs,
} from "./workflow-meta.ts";

const MAX_ATTACH_BYTES = 200_000;
const DEFAULT_SEAT_TIMEOUT_MS = 180_000;

let specifierRegistered = false;

export async function runModuleWorkflow(
  runner: AgentRunner,
  fleet: Fleet,
  parentSessionID: string,
  definition: ModuleWorkflowDefinition,
  input: string,
  options: WorkflowRunOptions = {},
) {
  const lead = fleet.members.find(
    (member) => member.id === fleet.leadID && member.enabled,
  );
  if (!lead) throw new Error(`Fleet lead ${fleet.leadID} is missing or disabled.`);
  const createdAt = Date.now();
  const run: WorkflowRun = options.run
    ? structuredClone(options.run)
    : {
      id: options.runID ?? `workflow_${crypto.randomUUID()}`,
      kind: "workflow",
      workflowKind: "module",
      definition: definition.name,
      sessionID: parentSessionID,
      messageID: options.messageID,
      input,
      status: "pending",
      steps: [],
      background: options.background,
      sourceHash: definition.sourceHash ?? workflowSourceHash(definition.source),
      createdAt,
      updatedAt: createdAt,
    };
  run.status = "running";
  run.error = undefined;
  run.sourceHash = definition.sourceHash ?? workflowSourceHash(definition.source);
  await publish(run, options);

  const timeout = AbortSignal.timeout(options.timeoutMs ?? 900_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const workspace = workspaceFor(definition.path);
  const authored = await loadAuthoredWorkflow(definition);
  const args = coerceWorkflowArgs(
    definition.arguments ?? authored.meta.arguments,
    parseWorkflowArgs(input),
  );
  const ctx = createContext({
    runner,
    fleet,
    lead,
    parentSessionID,
    definition,
    run,
    options,
    signal,
    workspace,
    phases: definition.phases ?? authored.meta.phases ?? [],
  });

  try {
    const value = await authored.run(args, ctx);
    run.status = "completed";
    run.final = resultText(value) ??
      [...run.steps].reverse().find((step) => step.output)?.output ??
      "Workflow completed.";
    await publish(run, options);
    return run;
  } catch (error) {
    const cancelled = signal.aborted;
    run.status = cancelled ? "cancelled" : "failed";
    run.error = timeout.aborted
      ? `Workflow exceeded ${options.timeoutMs ?? 900_000} ms.`
      : error instanceof Error ? error.message : String(error);
    run.steps
      .filter((step) => step.status === "running" || step.status === "pending")
      .forEach((step) => {
        step.status = "cancelled";
        step.error = run.error;
        step.completedAt = Date.now();
      });
    await publish(run, options);
    if (cancelled) await runner.cancel?.(parentSessionID, run.id);
    return run;
  }
}

export function registerWorkflowSpecifier() {
  if (specifierRegistered) return;
  specifierRegistered = true;
  Bun.plugin({
    name: "opencode-multimodel-workflow",
    setup(build) {
      build.onResolve({
        filter:
          /^(opencode-multimodel\/workflow|@opencode-ai\/plugin(?:\/workflow)?)$/,
      }, () => ({ path: workflowHelperPath() }));
    },
  });
}

async function loadAuthoredWorkflow(definition: ModuleWorkflowDefinition) {
  const result = await Bun.build({
    entrypoints: [definition.path],
    target: "bun",
    format: "esm",
    write: false,
    plugins: [{
      name: "opencode-multimodel-workflow",
      setup(build) {
        build.onResolve({
          filter:
            /^(opencode-multimodel\/workflow|@opencode-ai\/plugin(?:\/workflow)?)$/,
        }, () => ({ path: workflowHelperPath() }));
      },
    }],
  } as Parameters<typeof Bun.build>[0]);
  if (!result.success || !result.outputs[0]) {
    throw new Error(
      result.logs.map((log) => String(log)).join("\n") ||
        `Could not load workflow ${definition.name}.`,
    );
  }
  const temp = join(
    tmpdir(),
    `mm-workflow-${definition.sourceHash ?? workflowSourceHash(definition.source)}.js`,
  );
  await writeFile(temp, await result.outputs[0].text());
  const loaded = await import(pathToFileURL(temp).href) as {
    default?: AuthoredWorkflow | { meta?: unknown; run?: unknown };
    meta?: AuthoredWorkflow["meta"];
    run?: AuthoredWorkflow["run"];
    workflow?: AuthoredWorkflow;
  };
  const candidate = loaded.default ?? loaded.workflow;
  if (candidate && typeof candidate === "object" && "run" in candidate) {
    const run = (candidate as AuthoredWorkflow).run;
    if (typeof run === "function") return candidate as AuthoredWorkflow;
  }
  if (typeof loaded.run === "function") {
    return {
      meta: loaded.meta ?? { name: definition.name },
      run: loaded.run,
    };
  }
  throw new Error(
    `Workflow ${definition.name} must default-export workflow({ run }) or export run().`,
  );
}

function createContext(input: {
  runner: AgentRunner;
  fleet: Fleet;
  lead: FleetMember;
  parentSessionID: string;
  definition: ModuleWorkflowDefinition;
  run: WorkflowRun;
  options: WorkflowRunOptions;
  signal: AbortSignal;
  workspace: string;
  phases: readonly WorkflowPhase[];
}): WorkflowContext {
  let phase: string | undefined;
  let calls = 0;
  const used: string[] = [];

  const context: WorkflowContext = {
    setPhase(next) {
      phase = next;
      input.run.updatedAt = Date.now();
    },
    log(message) {
      const step = {
        id: `log_${input.run.steps.length + 1}`,
        status: "completed" as const,
        memberID: input.lead.id,
        output: message,
        completedAt: Date.now(),
      };
      input.run.steps.push(step);
      void publish(input.run, input.options);
    },
    async agent(request) {
      input.signal.throwIfAborted();
      await input.options.beforeStep?.(structuredClone(input.run));
      const prompt = await attachFiles(
        request.prompt,
        request.files ?? [],
        input.workspace,
      );
      const tried: string[] = [];
      const failures: string[] = [];
      let lastError: unknown;
      while (true) {
        const member = nextMember(
          input.fleet,
          input.lead,
          request,
          tried,
          used,
          phaseModel(input.phases, request.phase ?? phase),
        );
        if (!member) {
          if (request.onError === "null") return null;
          throw lastError instanceof Error
            ? lastError
            : new Error(failures.join(" | ") || "No fleet seat available.");
        }
        tried.push(member.id);
        const stepID = request.label ??
          request.phase ??
          phase ??
          `agent_${calls + 1}`;
        const step: WorkflowStepRun = {
          id: uniqueStepID(input.run, stepID),
          status: "running",
          memberID: member.id,
          startedAt: Date.now(),
        };
        input.run.steps.push(step);
        await publish(input.run, input.options);
        const seat = seatSignal(
          input.signal,
          input.options.seatTimeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS,
          `Fleet member ${member.id} timed out.`,
        );
        try {
          input.signal.throwIfAborted();
          if (calls >= (input.options.maxAgentCalls ?? 64)) {
            throw new Error(
              `Workflow exceeded its ${input.options.maxAgentCalls ?? 64} agent-call limit.`,
            );
          }
          calls += 1;
          const reply = await input.runner.run({
            parentSessionID: input.parentSessionID,
            member,
            prompt,
            system: [
              collaborationSystem(
                member,
                input.lead,
                input.fleet.members.filter((item) => item.enabled),
              ),
              `You are a step of workflow **${input.definition.name}**. Return only this step's concrete result.`,
            ].join("\n\n"),
            signal: seat.signal,
            runID: input.run.id,
            stepID: step.id,
            callIndex: calls - 1,
          });
          used.push(member.id);
          step.status = "completed";
          step.output = failures.length
            ? `Fell back to ${member.id} after ${failures.join("; ")}\n\n${reply.text}`
            : reply.text;
          step.completedAt = Date.now();
          await publish(input.run, input.options);
          return { text: reply.text, data: reply.text } satisfies WorkflowAgentResult;
        } catch (error) {
          lastError = error;
          failures.push(
            `${member.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          step.status = input.signal.aborted ? "cancelled" : "failed";
          step.error = failures.at(-1);
          step.completedAt = Date.now();
          await publish(input.run, input.options);
          if (input.signal.aborted) throw error;
          if (request.member) {
            if (request.onError === "null") return null;
            throw error;
          }
        } finally {
          seat.dispose();
        }
      }
    },
    async parallel(tasks, options) {
      const limit = Math.min(
        64,
        Math.max(1, options?.concurrencyLimit ?? input.options.maxParallel ?? 6),
      );
      return mapLimit([...tasks], limit, async (task) => {
        try {
          return await task();
        } catch (error) {
          if (input.signal.aborted) throw error;
          return null;
        }
      });
    },
    async pipeline(items: readonly unknown[], ...rest: unknown[]) {
      const options = typeof rest.at(-1) === "object" &&
          rest.at(-1) !== null &&
          !Array.isArray(rest.at(-1)) &&
          typeof (rest.at(-1) as { concurrencyLimit?: unknown }).concurrencyLimit ===
            "number"
        ? rest.pop() as { concurrencyLimit?: number }
        : undefined;
      const stages = rest as Array<
        (prev: unknown, item: unknown, index: number) => Promise<unknown>
      >;
      const limit = Math.min(
        64,
        Math.max(1, options?.concurrencyLimit ?? (items.length || 1)),
      );
      return mapLimit([...items.keys()], limit, async (index) => {
        const item = items[index];
        let value: unknown = item;
        try {
          for (const stage of stages) {
            value = await stage(value, item, index);
          }
          return value;
        } catch (error) {
          if (input.signal.aborted) throw error;
          return null;
        }
      });
    },
    async shell(command, opts) {
      input.signal.throwIfAborted();
      const cwd = opts?.cwd
        ? (isAbsolute(opts.cwd) ? opts.cwd : resolve(input.workspace, opts.cwd))
        : input.workspace;
      const timeout = opts?.timeout ?? 120_000;
      const process = Bun.spawn(["/bin/zsh", "-lc", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const abort = () => process.kill();
      input.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeout);
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        return {
          output: [stdout, stderr].filter(Boolean).join("\n").trim(),
          exitCode: exit,
        };
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
      }
    },
  };
  return context;
}

function nextMember(
  fleet: Fleet,
  lead: FleetMember,
  request: WorkflowAgentInput,
  tried: string[],
  used: string[],
  fallbackModel?: string,
) {
  const exclude = tried;
  const base = (() => {
    if (tried.length === 0 && request.member) {
      return resolveFleetSeat(fleet, request.member);
    }
    if (request.role) {
      return suggestMemberForStep(
        { id: request.role, prompt: request.prompt },
        fleet,
        used,
        exclude,
      );
    }
    if (tried.length === 0) return lead;
    return suggestMemberForStep(
      { id: request.label ?? request.phase ?? "agent", prompt: request.prompt },
      fleet,
      used,
      exclude,
    );
  })();
  if (!base || exclude.includes(base.id)) return undefined;
  const model = request.model
    ? parseModelRef(request.model)
    : fallbackModel
    ? parseModelRef(fallbackModel)
    : base.model;
  return {
    ...base,
    model,
    agent: normalizeWorkflowAgent(request.agent ?? base.agent),
    isolation: request.isolation ?? base.isolation,
  };
}

function parseModelRef(spec: string): ModelRef {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`model must be provider/model, got ${spec}`);
  }
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

function phaseModel(
  phases: readonly WorkflowPhase[],
  name: string | undefined,
) {
  if (!name) return undefined;
  const phase = phases.find((item) =>
    (typeof item === "string" ? item : item.title) === name
  );
  return phase && typeof phase === "object" ? phase.model : undefined;
}

async function attachFiles(
  prompt: string,
  files: string[],
  workspace: string,
) {
  if (files.length === 0) return prompt;
  const blocks = [];
  for (const file of files) {
    const path = isAbsolute(file) ? file : resolve(workspace, file);
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_ATTACH_BYTES) {
      blocks.push(`Attached file ${path} (${bytes.byteLength} bytes, omitted).`);
      continue;
    }
    blocks.push(`Attached file ${path}:\n${bytes.toString("utf8")}`);
  }
  return `${prompt}\n\n${blocks.join("\n\n")}`;
}

function uniqueStepID(run: WorkflowRun, base: string) {
  const taken = new Set(run.steps.map((step) => step.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function workspaceFor(path: string) {
  const directory = dirname(path);
  const normalized = directory.split(sep).join("/");
  if (normalized.endsWith("/.opencode/workflows")) {
    return resolve(directory, "../..");
  }
  return directory;
}

function workflowHelperPath() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const source = join(here, "workflow-api.ts");
  return existsSync(source) ? source : join(here, "workflow-api.js");
}

function resultText(value: unknown) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function seatSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  reason: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(reason), timeoutMs);
  const onParent = () => {
    clearTimeout(timer);
    controller.abort(parent?.reason);
  };
  parent?.addEventListener("abort", onParent, { once: true });
  if (parent?.aborted) onParent();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

async function publish(run: WorkflowRun, options: WorkflowRunOptions) {
  run.updatedAt = Date.now();
  await options.onUpdate?.(structuredClone(run));
}
