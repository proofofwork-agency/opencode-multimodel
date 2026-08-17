import { isAbsolute, resolve } from "node:path";
import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import {
  DYNAMIC_WORKFLOW_NAME,
  SessionSelectionCache,
  mergeSessionSelection,
  resolveRunnableWorkflow,
} from "./dynamic.ts";
import {
  adaptPluginClient,
  asOpenCodeClient,
  discoverFleet,
  OpenCodeAgentRunner,
  resolveSessionSelection,
} from "./opencode.ts";
import { RunService } from "./orchestration.ts";
import { parseOptions } from "./options.ts";
import { validateWorkflowScript } from "./script.ts";
import {
  resolveDatabasePath,
  StateStore,
  workflowSourceHash,
} from "./state.ts";
import {
  COLLAB_MODES,
  isDagWorkflow,
  isWorkflowRun,
  type CollabMode,
  type DurableRun,
  type WorkflowDefinition,
} from "./types.ts";
import { validateWorkflow } from "./workflow.ts";
import {
  loadWorkflowDirectories,
  parseWorkflowDefinition,
} from "./workflow-files.ts";

const server: Plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions);
  const client = input.client
    ? adaptPluginClient(input.client)
    : asOpenCodeClient(createOpencodeClient({
      baseUrl: input.serverUrl?.toString(),
      directory: input.directory,
    }));
  const store = new StateStore(
    resolveDatabasePath(input.directory, options.databasePath),
    {
      legacyPath: options.statePath
        ? absolute(input.directory, options.statePath)
        : undefined,
      retention: options.retention,
    },
  );
  await store.initializeFleet(options.fleet ?? { leadID: "lead", members: [] });
  await loadWorkflowDirectories(store, input.directory, options.workflows);
  const runner = new OpenCodeAgentRunner(client, store, input.directory);
  const runs = new RunService(store, runner, options);
  const selections = new SessionSelectionCache();
  const readState = async (discover = false) => {
    const state = await store.read();
    if (!discover || options.fleet || state.fleet.members.length > 0) {
      return state;
    }
    await store.initializeFleet(await discoverFleet(client));
    return store.read();
  };

  return {
    async config(config) {
      config.command ??= {};
      const commandModel = typeof config.small_model === "string" &&
          config.small_model.trim()
        ? config.small_model
        : undefined;
      config.command.lead ??= {
        description: "Select the multi-model fleet lead",
        model: commandModel,
        template:
          "Call multimodel_fleet with action=set-lead and memberID=$ARGUMENTS. Return the tool result.",
      };
      config.command.fleet ??= {
        description: "Show the multi-model fleet",
        model: commandModel,
        template:
          "Call multimodel_fleet with action=list. Return the tool result.",
      };
      config.command.collab ??= {
        description: "Run a multi-model collaboration",
        model: commandModel,
        template: `Act only as a deterministic command adapter. Do not answer the user's request yourself. Call multimodel_collab exactly once and return its tool result verbatim.

The raw command arguments are between the delimiters below:
<multimodel_arguments>
$ARGUMENTS
</multimodel_arguments>

Parsing rules:
1. Read the first whitespace-delimited token.
2. If it is one of ${COLLAB_MODES.join(", ")}, pass that exact token as mode and copy every character after the following whitespace into prompt.
3. Otherwise pass mode=${options.defaultMode} and copy all raw command arguments into prompt.
4. The prompt is required. If text remains after a recognized mode, the tool's prompt argument MUST contain that complete text verbatim and MUST NOT be empty.`,
      };
      config.command.workflow ??= {
        description:
          "Run a saved workflow, or start a dynamic understand-change-verify workflow on the session model",
        template: `Act only as a deterministic command adapter. Do not answer the user's request yourself. Call multimodel_workflow exactly once and return its tool result verbatim.

The raw command arguments are between the delimiters below:
<multimodel_arguments>
$ARGUMENTS
</multimodel_arguments>

Parsing rules:
1. If the arguments are empty, call action=list.
2. Read the first whitespace-delimited token.
3. If it is the exact name of a saved workflow, call action=run with name set to that token and copy every remaining character into input.
4. Otherwise omit name and copy ALL raw command arguments into input. This starts a dynamic workflow for that task.
5. The input is required for a run. Never pass an empty input for a task, and never answer the task yourself.`,
      };
      config.command.workflows ??= {
        description: "List multi-model workflows and recent runs",
        template:
          "Call multimodel_workflow with action=list. Return the tool result.",
      };
    },
    tool: {
      multimodel_fleet: tool({
        description:
          "List or configure the durable OpenCode multi-model fleet, its lead, enabled state, and isolation.",
        args: {
          action: tool.schema.enum([
            "list",
            "set-lead",
            "add",
            "update",
            "remove",
            "enable",
            "disable",
          ]),
          memberID: tool.schema.string().optional(),
          role: tool.schema.string().optional(),
          providerID: tool.schema.string().optional(),
          modelID: tool.schema.string().optional(),
          agent: tool.schema.string().optional(),
          isolation: tool.schema.enum(["shared", "worktree"]).optional(),
        },
        async execute(args, context) {
          if (args.action !== "list") {
            const memberID = requireText(args.memberID, "memberID");
            const pattern = `${args.action}:${memberID}`;
            await context.ask({
              permission: "multimodel.fleet",
              patterns: [pattern],
              always: [pattern],
              metadata: { action: args.action, memberID },
            });
          }
          if (args.action === "set-lead") {
            await store.setLead(requireText(args.memberID, "memberID"));
          }
          if (args.action === "remove") {
            await store.removeMember(requireText(args.memberID, "memberID"));
          }
          if (args.action === "enable" || args.action === "disable") {
            await store.enableMember(
              requireText(args.memberID, "memberID"),
              args.action === "enable",
            );
          }
          if (args.action === "add" || args.action === "update") {
            const state = await readState();
            const memberID = requireText(args.memberID, "memberID");
            const existing = state.fleet.members.find((member) =>
              member.id === memberID
            );
            if (args.action === "update" && !existing) {
              throw new Error(`Fleet member ${memberID} does not exist.`);
            }
            await store.upsertMember({
              id: memberID,
              role: args.role ?? existing?.role ?? "specialist",
              model: {
                providerID: args.providerID ?? existing?.model.providerID ??
                  requireText(args.providerID, "providerID"),
                modelID: args.modelID ?? existing?.model.modelID ??
                  requireText(args.modelID, "modelID"),
              },
              agent: args.agent ?? existing?.agent,
              enabled: existing?.enabled ?? true,
              isolation: args.isolation ?? existing?.isolation ?? "shared",
            });
          }
          return formatFleet((await readState(args.action === "list")).fleet);
        },
      }),
      multimodel_collab: tool({
        description:
          "Start a foreground or background multi-model collaboration. Always pass the complete user request in prompt; never omit or answer it outside the tool.",
        args: {
          prompt: tool.schema.string().min(1).describe(
            "Required complete collaboration request, copied verbatim from the command after its optional mode token. Never pass an empty string.",
          ),
          mode: tool.schema.enum(COLLAB_MODES).optional(),
          participants: tool.schema.array(tool.schema.string()).optional(),
          handoffTo: tool.schema.string().optional(),
          juryRounds: tool.schema
            .union([tool.schema.literal(1), tool.schema.literal(2)])
            .optional(),
          background: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          const state = await readState(true);
          if (state.fleet.members.length === 0) {
            throw new Error(
              "The fleet is empty. Add a model with multimodel_fleet first.",
            );
          }
          const mode = (args.mode ?? options.defaultMode) as CollabMode;
          await context.ask({
            permission: "multimodel.collab",
            patterns: [mode],
            always: ["*"],
            metadata: {
              mode,
              participants: args.participants ??
                state.fleet.members.map((member) => member.id),
              background: args.background === true,
            },
          });
          const run = await runs.startCollaboration({
            sessionID: context.sessionID,
            messageID: context.messageID,
            prompt: args.prompt,
            mode,
            participants: args.participants,
            handoffTo: args.handoffTo,
            juryRounds: args.juryRounds,
            background: args.background,
            signal: args.background ? undefined : context.abort,
            onActivity(event) {
              context.metadata({
                title: `${event.memberID}: ${event.phase}`,
                metadata: { runID: undefined, ...event },
              });
            },
          });
          return runOutput(run);
        },
      }),
      multimodel_run: tool({
        description:
          "Inspect, cancel, steer, resume, or clean up workspaces for durable multi-model runs.",
        args: {
          action: tool.schema.enum([
            "list",
            "get",
            "cancel",
            "steer",
            "resume",
            "cleanup-workspaces",
          ]),
          runID: tool.schema.string().optional(),
          prompt: tool.schema.string().optional(),
        },
        async execute(args, context) {
          if (args.action === "list") {
            return JSON.stringify(await store.listRuns(100), null, 2);
          }
          if (args.action === "cleanup-workspaces") {
            const count = await runs.cleanupWorkspaces(args.runID);
            return `Removed ${count} preserved workspace${count === 1 ? "" : "s"}.`;
          }
          const runID = requireText(args.runID, "runID");
          if (args.action === "get") {
            const run = await store.getRun(runID);
            if (!run) throw new Error(`Run ${runID} does not exist.`);
            return JSON.stringify(run, null, 2);
          }
          await context.ask({
            permission: `multimodel.run.${args.action}`,
            patterns: [runID],
            always: [runID],
            metadata: { runID },
          });
          if (args.action === "cancel") await runs.cancel(runID);
          if (args.action === "resume") await runs.resume(runID);
          if (args.action === "steer") {
            await runs.steer(runID, requireText(args.prompt, "prompt"));
          }
          return runOutput((await store.getRun(runID))!);
        },
      }),
      multimodel_workflow: tool({
        description:
          "Save, inspect, run, pause, resume, stop, or restart durable DAG and confined script workflows.",
        args: {
          action: tool.schema.enum([
            "list",
            "save",
            "inspect",
            "run",
            "history",
            "pause",
            "resume",
            "stop",
            "restart-agent",
          ]),
          name: tool.schema.string().optional(),
          runID: tool.schema.string().optional(),
          stepID: tool.schema.string().optional(),
          input: tool.schema.string().optional(),
          background: tool.schema.boolean().optional(),
          definition: tool.schema
            .string()
            .optional()
            .describe("DAG or confined script workflow definition as JSON"),
        },
        async execute(args, context) {
          const state = await readState(args.action === "run");
          if (args.action === "list") {
            return formatWorkflows(state.workflows, state.runs);
          }
          if (args.action === "history") {
            return JSON.stringify(
              state.runs.filter(isWorkflowRun).slice(0, 20),
              null,
              2,
            );
          }
          if (args.action === "inspect") {
            const name = requireText(args.name, "name");
            const definition = state.workflows.find((item) => item.name === name);
            if (!definition) throw new Error(`Workflow ${name} does not exist.`);
            return JSON.stringify(definition, null, 2);
          }
          if (args.action === "save") {
            const definition = parseWorkflowDefinition(
              requireText(args.definition, "definition"),
            );
            if (definition.kind === "script") {
              if (!options.workflows.scripts) {
                throw new Error(
                  "Script workflows are disabled. Set workflows.scripts=true to enable them.",
                );
              }
              const validated = validateWorkflowScript(definition.source);
              definition.sourceHash = validated.sourceHash;
            } else if (definition.kind !== "module") {
              validateWorkflow(definition);
            }
            await store.saveWorkflow(definition);
            return `Saved ${definition.kind ?? "dag"} workflow ${definition.name}.`;
          }
          if (args.action === "pause" || args.action === "resume" ||
            args.action === "stop" || args.action === "restart-agent") {
            const runID = requireText(args.runID, "runID");
            await context.ask({
              permission: `multimodel.workflow.${args.action}`,
              patterns: [runID],
              always: [runID],
              metadata: { runID },
            });
            if (args.action === "pause") await runs.pause(runID);
            if (args.action === "resume") await runs.resume(runID);
            if (args.action === "stop") await runs.stop(runID);
            if (args.action === "restart-agent") {
              await runs.restartAgent(
                runID,
                requireText(args.stepID, "stepID"),
              );
            }
            return runOutput((await store.getRun(runID))!);
          }
          const resolved = resolveRunnableWorkflow(
            state.workflows,
            args.name,
            args.input ?? "",
          );
          if (resolved.definition.kind === "script" && !options.workflows.scripts) {
            throw new Error("Script workflows are disabled by configuration.");
          }
          const pattern = resolved.dynamic
            ? DYNAMIC_WORKFLOW_NAME
            : resolved.definition.kind === "script" ||
                resolved.definition.kind === "module"
              ? `${resolved.definition.name}:${workflowSourceHash(resolved.definition.source)}`
              : resolved.definition.name;
          await context.ask({
            permission: "multimodel.workflow",
            patterns: [pattern],
            always: [pattern],
            metadata: {
              workflow: resolved.definition.name,
              kind: resolved.definition.kind ?? "dag",
              dynamic: resolved.dynamic,
              sourceHash: resolved.definition.kind === "script" ||
                  resolved.definition.kind === "module"
                ? workflowSourceHash(resolved.definition.source)
                : undefined,
              background: args.background === true,
            },
          });
          const session = mergeSessionSelection(
            selections.get(context.sessionID),
            await resolveSessionSelection(client, context.sessionID),
            { agent: context.agent },
          );
          return runOutput(await runs.startWorkflow({
            sessionID: context.sessionID,
            messageID: context.messageID,
            definition: resolved.definition,
            input: resolved.input,
            background: args.background,
            signal: args.background ? undefined : context.abort,
            sessionModel: session.model,
            sessionAgent: session.agent,
          }));
        },
      }),
    },
    "chat.message": async (input) => {
      if (!input.model?.providerID || !input.model.modelID) return;
      selections.remember(input.sessionID, {
        model: input.model,
        agent: input.agent,
      });
    },
    async "experimental.chat.system.transform"(input, output) {
      if (!input.sessionID) return;
      const stored = await store.getSessionMode(input.sessionID);
      if (stored?.mode !== "workflow") return;
      output.system.push(
        "This session is in WORKFLOW mode. For a user task that is not already a slash command, call multimodel_workflow with action=run and put the complete task in input. Omit name unless the user named a saved workflow. Do not answer the task yourself.",
      );
    },
    async dispose() {
      await runs.dispose();
      await runner.close();
      await store.close();
    },
  };
};

function formatFleet(fleet: Awaited<ReturnType<StateStore["read"]>>["fleet"]) {
  if (fleet.members.length === 0) return "Fleet is empty.";
  return [
    `Lead: ${fleet.leadID}`,
    ...fleet.members.map((member) =>
      `${member.id === fleet.leadID ? "*" : "-"} ${member.id} · ${member.role} · ${member.model.providerID}/${member.model.modelID} · agent=${member.agent ?? "default"} · isolation=${member.isolation ?? "shared"}${member.enabled ? "" : " · disabled"}`
    ),
  ].join("\n");
}

function formatWorkflows(
  workflows: WorkflowDefinition[],
  runs: DurableRun[],
) {
  if (workflows.length === 0) {
    return "No saved workflows. /workflow <task> starts a dynamic understand-change-verify run on the current session model.";
  }
  return [
    ...workflows.map((workflow) =>
      workflow.kind === "script"
        ? `${workflow.name} · script · sha256:${workflow.sourceHash ?? workflowSourceHash(workflow.source)}`
        : workflow.kind === "module"
        ? `${workflow.name} · ts · ${(workflow.phases ?? []).map((phase) =>
          typeof phase === "string" ? phase : phase.title
        ).join(" → ") || "module"}${
          workflow.description ? ` · ${workflow.description}` : ""
        }`
        : `${workflow.name} · dag · ${workflow.steps.length} steps${workflow.description ? ` · ${workflow.description}` : ""}`
    ),
    "",
    `Recent runs: ${
      runs
        .filter(isWorkflowRun)
        .slice(0, 10)
        .map((run) => `${run.definition}/${run.status}`)
        .join(", ") || "none"
    }`,
  ].join("\n");
}

function runOutput(run: DurableRun) {
  return {
    title: `${run.definition}: ${run.status}`,
    output: run.background && run.status === "pending"
      ? `Background run ${run.id} was admitted.`
      : run.final ?? run.error ?? `Run ${run.id} is ${run.status}.`,
    metadata: {
      runID: run.id,
      kind: run.kind,
      status: run.status,
      background: run.background === true,
      steps: run.steps,
    },
  };
}

function requireText(value: string | undefined, name: string) {
  if (value?.trim()) return value;
  throw new Error(`${name} is required.`);
}

function absolute(directory: string, path: string) {
  return isAbsolute(path) ? path : resolve(directory, path);
}

export default { id: "opencode-multimodel", server } satisfies PluginModule;
