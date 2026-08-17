import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { adaptGoalClient } from "./opencode.ts";
import { GoalOwnedError, GoalService } from "./engine.ts";
import { parseGoalCommand } from "./command.ts";
import { formatHistory } from "./history.ts";
import { isAbortError } from "./opencode.ts";
import { parseOptions } from "./options.ts";
import {
  agentGoalSystemBlock,
  budgetLimitPrompt,
  formatGoalReceipt,
  formatGoalStatus,
  goalModePolicy,
} from "./prompts.ts";

const server: Plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions);
  const client = input.client ?? createOpencodeClient({
    baseUrl: input.serverUrl?.toString(),
    directory: input.directory,
  });
  const goals = new GoalService({
    ...options,
    directory: input.directory,
    client: adaptGoalClient(client, {
      baseUrl: input.serverUrl?.toString(),
      directory: input.directory,
    }),
    role: "server",
  });
  void goals.recoverActive().catch(() => undefined);

  return {
    async config(config) {
      config.command ??= {};
      config.command.goal ??= {
        description:
          "Set or manage a persisted goal that continues until evidence says it is done",
        template: "$ARGUMENTS",
      };
    },
    async "command.execute.before"(event, output) {
      if (event.command !== "goal") return;
      try {
        const alreadySteering = goals.get(event.sessionID);
        if (
          alreadySteering?.steerUntil &&
          Date.now() < alreadySteering.steerUntil
        ) {
          output.parts = [{
            type: "text",
            text: formatGoalReceipt(alreadySteering, "set"),
          }] as typeof output.parts;
          return;
        }
        const command = parseGoalCommand(event.arguments ?? "");
        const agent = (event as { agent?: string }).agent;
        await goals.apply(event.sessionID, command, {
          start: false,
          steer: true,
          agent,
        });
        if (command.action === "set" || command.action === "resume") {
          await goals.takeOver(event.sessionID);
        }
        const goal = goals.get(event.sessionID);
        const text = command.action === "set" && goal
          ? formatGoalReceipt(goal, "set")
          : command.action === "resume" && goal?.status === "active"
          ? formatGoalReceipt(goal, "resumed")
          : command.action === "status"
          ? formatGoalStatus(goal)
          : command.action === "history"
          ? formatHistory(goal)
          : formatGoalReceipt(
            goal,
            command.action === "pause"
              ? "paused"
              : command.action === "clear"
              ? "cleared"
              : command.action === "budget"
              ? "budget"
              : command.action === "edit"
              ? "edited"
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
          try {
            const goal = await goals.createFromModel(context.sessionID, {
              objective: args.objective,
              tokenBudget: args.token_budget,
              verification: args.verification,
              constraints: args.constraints,
              checks: args.check ? [args.check] : [],
            }, context.agent);
            return JSON.stringify({ goal, created: true });
          } catch (error) {
            if (error instanceof GoalOwnedError) {
              return JSON.stringify({ error: error.code });
            }
            throw error;
          }
        },
      }),
      update_goal: tool({
        description:
          "Mark the active thread goal complete or unmet after an evidence audit. Pause, resume, budget, and contract changes are user-controlled.",
        args: {
          status: tool.schema.enum(["complete", "unmet"]),
          evidence: tool.schema.string().optional(),
          summary: tool.schema.string().optional(),
          blocker: tool.schema.string().optional(),
          criteria: tool.schema.array(tool.schema.object({
            criterion: tool.schema.string().optional(),
            evidence: tool.schema.array(tool.schema.string()).optional(),
          })).optional(),
          checks: tool.schema.array(tool.schema.object({
            command: tool.schema.string().optional(),
            result: tool.schema.enum(["passed", "failed", "not-run"]).optional(),
          })).optional(),
        },
        async execute(args, context) {
          try {
            if (args.status === "unmet") {
              const goal = await goals.markUnmet(
                context.sessionID,
                args.blocker ?? args.evidence ?? "",
              );
              return JSON.stringify({
                approved: false,
                goal,
                reason: goal.blocker,
              });
            }
            const result = await goals.completeFromModel(context.sessionID, {
              evidence: args.evidence,
              summary: args.summary,
              criteria: args.criteria?.flatMap((item) =>
                item.criterion
                  ? [{ criterion: item.criterion, evidence: item.evidence ?? [] }]
                  : [],
              ),
              checks: args.checks?.flatMap((item) =>
                item.command || item.result
                  ? [{ command: item.command, result: item.result }]
                  : [],
              ),
            });
            return JSON.stringify(result);
          } catch (error) {
            if (error instanceof GoalOwnedError) {
              return JSON.stringify({ error: error.code });
            }
            throw error;
          }
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
      if (event.event.type === "session.status") {
        const status = (event.event.properties as { status?: { type?: string } })
          ?.status;
        if (status?.type === "busy") goals.armWatchdog(sessionID);
        if (status?.type === "idle") goals.clearWatchdog(sessionID);
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
      output.system.push(goalModePolicy());
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
    async "experimental.compaction.autocontinue"(input, output) {
      const goal = goals.get(input.sessionID);
      if (goal && (goal.status === "active" || goal.status === "budget_limited")) {
        output.enabled = false;
      }
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
