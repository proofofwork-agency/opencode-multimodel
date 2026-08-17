import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { createGoalService } from "./engine.ts";
import { parseGoalCommand } from "./command.ts";
import { isAbortError } from "./opencode.ts";
import { parseOptions } from "./options.ts";
import {
  agentGoalSystemBlock,
  budgetLimitPrompt,
  continuationPrompt,
  formatGoalReceipt,
  formatGoalStatus,
  startPrompt,
} from "./prompts.ts";

const server: Plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions);
  const client = input.client ?? createOpencodeClient({
    baseUrl: input.serverUrl?.toString(),
    directory: input.directory,
  });
  const goals = createGoalService(input.directory, options, client, {
    baseUrl: input.serverUrl?.toString(),
  });
  void goals.recoverActive().catch(() => undefined);

  return {
    async config(config) {
      config.command ??= {};
      config.command.goal ??= {
        description:
          "Set or manage a persisted Codex-style goal that continues until evidence says it is done",
        template: "$ARGUMENTS",
      };
    },
    async "command.execute.before"(event, output) {
      if (event.command !== "goal") return;
      try {
        const command = parseGoalCommand(event.arguments ?? "");
        await goals.apply(event.sessionID, command, { start: false, steer: true });
        if (command.action === "set" || command.action === "resume") {
          await goals.takeOver(event.sessionID);
        }
        const goal = goals.get(event.sessionID);
        const text = command.action === "set" && goal
          ? startPrompt(goal)
          : command.action === "resume" && goal?.status === "active"
          ? continuationPrompt(goal)
          : command.action === "status"
          ? formatGoalStatus(goal)
          : formatGoalReceipt(
            goal,
            command.action === "pause"
              ? "paused"
              : command.action === "clear"
              ? "cleared"
              : command.action === "budget"
              ? "budget"
              : "updated",
          );
        output.parts = [{ type: "text", text }] as typeof output.parts;
      } catch (error) {
        output.parts = [{
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        }] as typeof output.parts;
      }
    },
    tool: {
      goal_control: tool({
        description:
          "User/system control surface for the persisted thread goal.",
        args: {
          action: tool.schema.enum([
            "status",
            "set",
            "pause",
            "resume",
            "clear",
            "budget",
          ]),
          objective: tool.schema.string().optional(),
          tokenBudget: tool.schema.number().int().positive().optional(),
          verification: tool.schema.string().optional(),
          constraints: tool.schema.string().optional(),
          check: tool.schema.string().optional(),
        },
        async execute(args, context) {
          if (args.action === "set") {
            const objective = args.objective?.trim();
            if (!objective) {
              throw new Error("objective is required to set a goal.");
            }
            return goals.apply(context.sessionID, {
              action: "set",
              objective,
              tokenBudget: args.tokenBudget,
              verification: args.verification,
              constraints: args.constraints,
              checks: args.check ? [args.check] : [],
            }, { start: false });
          }
          if (args.action === "budget") {
            return goals.apply(context.sessionID, {
              action: "budget",
              tokenBudget: args.tokenBudget,
            }, { start: false });
          }
          if (args.action === "status") {
            return goals.apply(context.sessionID, { action: "status" }, {
              start: false,
            });
          }
          return goals.apply(context.sessionID, { action: args.action }, {
            start: false,
          });
        },
      }),
      create_goal: tool({
        description:
          "Create a persisted thread goal only when the user or system explicitly asked for a goal. Do not infer goals from ordinary tasks.",
        args: {
          objective: tool.schema.string().min(1),
          token_budget: tool.schema.number().int().positive().optional(),
          verification: tool.schema.string().optional(),
          constraints: tool.schema.string().optional(),
          check: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const goal = await goals.createFromModel(context.sessionID, {
            objective: args.objective,
            tokenBudget: args.token_budget,
            verification: args.verification,
            constraints: args.constraints,
            checks: args.check ? [args.check] : [],
          });
          return JSON.stringify({ goal, created: true });
        },
      }),
      update_goal: tool({
        description:
          "Mark the active thread goal complete only after an evidence audit of the current workspace. Pause, resume, and budget changes are system-controlled.",
        args: {
          status: tool.schema.enum(["complete"]),
          evidence: tool.schema.string().optional(),
          summary: tool.schema.string().optional(),
        },
        async execute(args, context) {
          const result = await goals.completeFromModel(context.sessionID, {
            evidence: args.evidence,
            summary: args.summary,
          });
          return JSON.stringify(result);
        },
      }),
      get_goal: tool({
        description:
          "Read the persisted thread goal for this session. Call this before planning or claiming progress whenever a /goal is active. Returns null when no goal exists.",
        args: {},
        async execute(_args, context) {
          const goal = goals.get(context.sessionID) ?? null;
          return JSON.stringify({
            goal,
            active: goal?.status === "active",
            contract: goal ? formatGoalStatus(goal) : "No persisted goal.",
          });
        },
      }),
    },
    async event(event) {
      const sessionID = sessionIDFromEvent(event.event);
      if (!sessionID) return;
      if (event.event.type === "session.idle") {
        await goals.handleIdle(sessionID).catch(() => undefined);
        return;
      }
      if (event.event.type === "session.error") {
        const error = (event.event.properties as { error?: unknown })?.error;
        if (isAbortError(error)) await goals.handleInterrupt(sessionID);
        return;
      }
      if (event.event.type === "session.created") {
        await goals.handleResume(sessionID).catch(() => undefined);
      }
    },
    async "chat.message"(input, output) {
      const text = output.parts
        .filter((part) => part.type === "text" && "text" in part)
        .map((part) => String((part as { text?: string }).text ?? ""))
        .join("\n");
      goals.noteHumanMessage(input.sessionID, text);
    },
    async "experimental.chat.system.transform"(input, output) {
      const sessionID = input.sessionID;
      if (!sessionID) return;
      const goal = goals.get(sessionID);
      if (!goal || goal.status !== "active") return;
      output.system.push(agentGoalSystemBlock(goal));
    },
    async "experimental.session.compacting"(input, output) {
      const goal = goals.get(input.sessionID);
      if (!goal) return;
      output.context.push(
        [
          "Persisted thread goal must survive compaction.",
          formatGoalStatus(goal),
          goal.status === "budget_limited"
            ? budgetLimitPrompt(goal)
            : undefined,
        ].filter(Boolean).join("\n"),
      );
    },
    async dispose() {
      goals.close();
    },
  };
};

function sessionIDFromEvent(event: {
  type: string;
  properties?: Record<string, unknown>;
}) {
  const properties = event.properties ?? {};
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = properties.info;
  if (info && typeof info === "object" && "id" in info) {
    const id = (info as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

export default {
  id: "opencode-goal",
  server,
} satisfies PluginModule;
