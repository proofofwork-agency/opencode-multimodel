import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import { collaborate } from "./collaborate.ts";
import {
  asOpenCodeClient,
  discoverFleet,
  OpenCodeAgentRunner,
} from "./opencode.ts";
import { parseOptions } from "./options.ts";
import { defaultStatePath, StateStore } from "./state.ts";
import {
  COLLAB_MODES,
  type CollabMode,
  type WorkflowDefinition,
} from "./types.ts";
import { runWorkflow, validateWorkflow } from "./workflow.ts";

const server: Plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions);
  const client = asOpenCodeClient(input.client);
  const store = new StateStore(
    options.statePath ?? defaultStatePath(input.directory),
  );
  await store.initializeFleet(options.fleet ?? (await discoverFleet(client)));
  const runner = new OpenCodeAgentRunner(client);

  return {
    async config(config) {
      config.command ??= {};
      config.command.lead ??= {
        description: "Select the multi-model fleet lead",
        template:
          "Call multimodel_fleet with action=set-lead and memberID=$ARGUMENTS. Return the tool result.",
      };
      config.command.fleet ??= {
        description: "Show the multi-model fleet",
        template:
          "Call multimodel_fleet with action=list. Return the tool result.",
      };
      config.command.collab ??= {
        description: "Run a multi-model collaboration",
        template: `Call multimodel_collab for this request. Use mode ${options.defaultMode} unless the first argument names a mode. Request: $ARGUMENTS`,
      };
      config.command.workflow ??= {
        description: "Run a declarative multi-model workflow",
        template:
          "Call multimodel_workflow with action=run. Treat the first argument as name and the remaining text as input: $ARGUMENTS",
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
          "List or configure the OpenCode multi-model fleet and select its lead.",
        args: {
          action: tool.schema.enum(["list", "set-lead", "add", "remove"]),
          memberID: tool.schema.string().optional(),
          role: tool.schema.string().optional(),
          providerID: tool.schema.string().optional(),
          modelID: tool.schema.string().optional(),
          agent: tool.schema.string().optional(),
        },
        async execute(args) {
          if (args.action === "set-lead") {
            if (!args.memberID)
              throw new Error("memberID is required for set-lead.");
            await store.setLead(args.memberID);
          }
          if (args.action === "remove") {
            if (!args.memberID)
              throw new Error("memberID is required for remove.");
            await store.removeMember(args.memberID);
          }
          if (args.action === "add") {
            if (!args.memberID || !args.providerID || !args.modelID) {
              throw new Error(
                "memberID, providerID and modelID are required for add.",
              );
            }
            await store.upsertMember({
              id: args.memberID,
              role: args.role ?? "specialist",
              model: { providerID: args.providerID, modelID: args.modelID },
              agent: args.agent,
              enabled: true,
            });
          }
          return formatFleet((await store.read()).fleet);
        },
      }),
      multimodel_collab: tool({
        description:
          "Run several OpenCode provider models concurrently using a Poly-derived collaboration mode, with a selected lead.",
        args: {
          prompt: tool.schema
            .string()
            .describe("The task or question for the fleet"),
          mode: tool.schema.enum(COLLAB_MODES).optional(),
          participants: tool.schema.array(tool.schema.string()).optional(),
          handoffTo: tool.schema.string().optional(),
          juryRounds: tool.schema
            .union([tool.schema.literal(1), tool.schema.literal(2)])
            .optional(),
        },
        async execute(args, context) {
          const state = await store.read();
          if (state.fleet.members.length === 0)
            throw new Error(
              "The fleet is empty. Add a model with multimodel_fleet first.",
            );
          const mode = (args.mode ?? options.defaultMode) as CollabMode;
          await context.ask({
            permission: "multimodel.collab",
            patterns: [mode],
            always: ["*"],
            metadata: {
              mode,
              participants:
                args.participants ??
                state.fleet.members.map((member) => member.id),
            },
          });
          const result = await collaborate(
            runner,
            state.fleet,
            context.sessionID,
            args.prompt,
            {
              mode,
              participants: args.participants,
              handoffTo: args.handoffTo,
              juryRounds: args.juryRounds,
              maxWorkers: options.maxWorkers,
              maxParallel: options.maxParallel,
              signal: context.abort,
              onActivity(event) {
                context.metadata({
                  title: `${event.memberID}: ${event.phase}`,
                  metadata: event,
                });
              },
            },
          );
          return {
            title: `${result.mode}: ${result.participants.join(", ")}`,
            output: result.final.text,
            metadata: {
              mode: result.mode,
              leadID: result.leadID,
              participants: result.participants,
              sessions: Object.fromEntries(
                result.replies
                  .filter((reply) => reply.sessionID)
                  .map((reply) => [reply.memberID, reply.sessionID]),
              ),
              majority: result.jury?.majority,
            },
          };
        },
      }),
      multimodel_workflow: tool({
        description:
          "Save, list, run, or inspect safe declarative multi-model DAG workflows.",
        args: {
          action: tool.schema.enum(["list", "save", "run", "history"]),
          name: tool.schema.string().optional(),
          input: tool.schema.string().optional(),
          definition: tool.schema
            .string()
            .optional()
            .describe("Workflow definition as JSON for save"),
        },
        async execute(args, context) {
          const state = await store.read();
          if (args.action === "list")
            return formatWorkflows(state.workflows, state.runs);
          if (args.action === "history")
            return JSON.stringify(state.runs.slice(-20), null, 2);
          if (args.action === "save") {
            if (!args.definition)
              throw new Error("definition JSON is required for save.");
            const definition = parseWorkflow(args.definition);
            validateWorkflow(definition);
            await store.saveWorkflow(definition);
            return `Saved workflow ${definition.name} with ${definition.steps.length} steps.`;
          }
          if (!args.name) throw new Error("name is required for run.");
          const definition = state.workflows.find(
            (workflow) => workflow.name === args.name,
          );
          if (!definition)
            throw new Error(`Workflow ${args.name} does not exist.`);
          await context.ask({
            permission: "multimodel.workflow",
            patterns: [definition.name],
            always: ["*"],
            metadata: {
              workflow: definition.name,
              steps: definition.steps.length,
            },
          });
          const run = await runWorkflow(
            runner,
            state.fleet,
            context.sessionID,
            definition,
            args.input ?? "",
            {
              signal: context.abort,
              onUpdate: (next) => store.saveRun(next).then(() => undefined),
            },
          );
          return {
            title: `${definition.name}: ${run.status}`,
            output: run.final ?? run.error ?? `Workflow ${run.status}.`,
            metadata: { runID: run.id, status: run.status, steps: run.steps },
          };
        },
      }),
    },
    async dispose() {
      await runner.close();
    },
  };
};

function formatFleet(fleet: Awaited<ReturnType<StateStore["read"]>>["fleet"]) {
  if (fleet.members.length === 0) return "Fleet is empty.";
  return [
    `Lead: ${fleet.leadID}`,
    ...fleet.members.map(
      (member) =>
        `${member.id === fleet.leadID ? "*" : "-"} ${member.id} · ${member.role} · ${member.model.providerID}/${member.model.modelID} · agent=${member.agent ?? "default"}${member.enabled ? "" : " · disabled"}`,
    ),
  ].join("\n");
}

function formatWorkflows(
  workflows: Awaited<ReturnType<StateStore["read"]>>["workflows"],
  runs: Awaited<ReturnType<StateStore["read"]>>["runs"],
) {
  if (workflows.length === 0) return "No workflows saved.";
  return [
    ...workflows.map(
      (workflow) =>
        `${workflow.name} · ${workflow.steps.length} steps${workflow.description ? ` · ${workflow.description}` : ""}`,
    ),
    "",
    `Recent runs: ${
      runs
        .slice(-10)
        .map((run) => `${run.definition}/${run.status}`)
        .join(", ") || "none"
    }`,
  ].join("\n");
}

function parseWorkflow(value: string): WorkflowDefinition {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Workflow definition must be an object.");
  return parsed as WorkflowDefinition;
}

export default { id: "opencode-multimodel", server } satisfies PluginModule;
