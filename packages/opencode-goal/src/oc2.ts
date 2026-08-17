import { parseGoalCommand, GoalCommandError } from "./command.ts";
import { GoalService, GoalOwnedError } from "./engine.ts";
import type { JudgeResult } from "./judge.ts";
import type { GoalClient } from "./opencode.ts";
import { parseOptions, type GoalOptions } from "./options.ts";
import {
  formatGoalStatus,
  startPrompt,
} from "./prompts.ts";
import { parseJudgeOutput } from "./judge.ts";
import type { Goal } from "./types.ts";

type Oc2ToolContext = {
  sessionID: string;
  agent?: string;
};

export type Oc2Registry = {
  add?: (definition: unknown) => unknown;
  update?: (name: string, transform: (existing: unknown) => unknown) => unknown;
};

export type Oc2Add = NonNullable<Oc2Registry["add"]>;

export type Oc2SessionApi = {
  get: (input: { sessionID: string }) => Promise<Record<string, unknown>>;
  create: (input: { title: string; model?: unknown }) => Promise<unknown>;
  prompt: (input: Record<string, unknown>) => Promise<unknown>;
  generate?: (input: Record<string, unknown>) => Promise<unknown>;
  interrupt?: (input: { sessionID: string }) => Promise<unknown>;
};

export type Oc2Context = {
  command?: { transform: (fn: (registry: Oc2Registry) => unknown) => unknown };
  tool?: { transform: (fn: (registry: Oc2Registry) => unknown) => unknown };
  session?: Oc2SessionApi;
};

const GOAL_COMMAND_TEMPLATE = [
  "The user ran the /goal command with arguments: \"$ARGUMENTS\"",
  "",
  "Handle it strictly with the goal tools; never invent goal state:",
  "- No arguments or \"status\": call get_goal and report the persisted state verbatim.",
  "- \"pause\": call goal_pause. \"resume\": call goal_resume. \"clear\"/\"stop\"/\"cancel\": call goal_clear.",
  "- An objective (optionally with flags): call create_goal once with the parsed fields:",
  "  objective=<text>, token_budget=<number from --budget like 200k>, check=<command from --check>,",
  "  verification=<text from --verify>, constraints=<text from --constraint>.",
  "  Goals may only be created when the user explicitly asked for one.",
  "- While a goal is active: work toward it, then call update_goal with status \"complete\"",
  "  (structured evidence required) or \"unmet\" (concrete blocker required).",
].join("\n");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oc2Client(ctx: Oc2Context): GoalClient {
  return {
    async prompt({ sessionID, text, agent }) {
      const input: Record<string, unknown> = { sessionID, text };
      if (agent !== undefined) input.agent = agent;
      await ctx.session!.prompt(input);
      return { text: "", hadTools: true, tokens: 0 };
    },
    async session(sessionID) {
      const raw = await ctx.session!.get({ sessionID }).catch(() => undefined);
      const info = (raw ?? {}) as {
        agent?: string;
        status?: string;
        model?: { id: string; providerID: string; variant?: string };
      };
      return {
        agent: info.agent,
        busy: info.status === "busy",
        model: info.model,
      };
    },
    async judge(prompt, options) {
      const model = options?.model;
      let lastError = "OC2 judge generate returned no text.";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let child: string | undefined;
        try {
          const created = await (async () => {
            try {
              return await ctx.session!.create(
                model ? { title: "goal-judge", model } : { title: "goal-judge" },
              );
            } catch {
              return await ctx.session!.create({ title: "goal-judge" });
            }
          })();
          child = sessionIDFrom(created);
          if (!child) throw new Error("OC2 judge session create returned no id.");
          const out = await ctx.session!.generate!({
            sessionID: child,
            prompt: attempt === 0 ? prompt : `${prompt}\n\nAnswer with the JSON object now.`,
          });
          const text = textFromGenerate(out);
          if (text) return text;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        } finally {
          if (child) {
            await ctx.session!.interrupt?.({ sessionID: child }).catch(() => undefined);
          }
        }
      }
      throw new Error(lastError);
    },
    async abort(sessionID) {
      await ctx.session!.interrupt?.({ sessionID }).catch(() => undefined);
    },
  };
}

const claimDrivenEvaluate: CompactEvaluate = async ({ hostAudit, evidence }) => {
  if (hostAudit && evidence) {
    return {
      verdict: "met",
      reason: `Host proof verified: ${hostAudit.slice(0, 140)}`,
    };
  }
  return {
    verdict: "not_met",
    reason: "Judge disabled; completion is claim-driven via update_goal with evidence.",
  };
};

type CompactEvaluate = (input: {
  goal: Goal;
  transcript: string;
  hostAudit?: string;
  evidence?: string;
  contract?: string;
}) => Promise<JudgeResult | undefined>;

function compactJudge(ctx: Oc2Context, client: GoalClient): CompactEvaluate {
  return async ({ goal, hostAudit, evidence }) => {
    if (!ctx.session?.generate) return undefined;
    const prompt = [
      "You are an independent goal evaluator. Return exactly one JSON object and nothing else:",
      '{"verdict":"met"|"not_met"|"impossible","reason":"short reason"}',
      `Objective: ${goal.objective}`,
      goal.checks.length > 0 ? `Host checks: ${goal.checks.join("; ")}` : "",
      hostAudit ? `Host audit: ${hostAudit.slice(0, 200)}` : "",
      evidence ? `Worker evidence: ${String(evidence).slice(0, 300)}` : "",
    ].filter(Boolean).join("\n").slice(0, 900);
    try {
      const raw = await client.judge?.(prompt);
      if (!raw) return undefined;
      return parseJudgeOutput(raw);
    } catch (error) {
      return {
        verdict: "not_met",
        reason: `Independent judge failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };
}

function sessionIDFrom(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; data?: { id?: unknown } };
  if (typeof record.id === "string" && record.id) return record.id;
  if (typeof record.data?.id === "string" && record.data.id) return record.data.id;
  return undefined;
}

function textFromGenerate(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const record = value as {
    text?: unknown;
    data?: { text?: unknown } | string;
    output?: unknown;
  };
  if (typeof record.text === "string") return record.text.trim();
  if (typeof record.data === "string") return record.data.trim();
  if (typeof record.data?.text === "string") return record.data.text.trim();
  if (typeof record.output === "string") return record.output.trim();
  return "";
}

export function createOc2Plugin(input: {
  ctx: Oc2Context;
  options?: GoalOptions;
  serviceFor?: (directory: string) => GoalService;
  driveIntervalMs?: number;
  log?: (message: string) => void;
}) {
  const log = input.log ?? (() => {});
  const driveIntervalMs = input.driveIntervalMs ?? 5_000;
  const services = new Map<string, GoalService>();
  const drivers = new Set<string>();
  const clients = new Map<string, GoalClient>();

  const serviceFor = input.serviceFor ?? ((directory: string) => {
    let service = services.get(directory);
    if (!service) {
      const client = clients.get(directory) ?? oc2Client(input.ctx);
      clients.set(directory, client);
      const baseOptions = input.options ??
        parseOptions({ judge: false });
      service = new GoalService({
        ...baseOptions,
        directory,
        client,
        evaluate: baseOptions.judge === false
          ? claimDrivenEvaluate
          : compactJudge(input.ctx, client),
      });
      services.set(directory, service);
      void service.recoverActive().catch(() => undefined);
      log(`goal service ready for ${directory}`);
    }
    return service;
  });

  async function serviceForSession(sessionID: string) {
    const raw = await input.ctx.session!.get({ sessionID }).catch(() => undefined);
    const directory = ((raw as { location?: { directory?: string } })?.location ??
      {})?.directory ?? process.cwd();
    return { service: serviceFor(directory), directory };
  }

  function drive(sessionID: string, service: GoalService) {
    if (drivers.has(sessionID)) return;
    drivers.add(sessionID);
    void (async () => {
      try {
        for (let turn = 0; turn < 100; turn += 1) {
          await sleep(driveIntervalMs);
          const decision = await service.handleIdle(sessionID).catch(() => undefined);
          if (!decision || decision.action === "skip") return;
        }
      } finally {
        drivers.delete(sessionID);
      }
    })();
  }

  const commandRegistry = (registry: Oc2Registry) => {
    registry.update?.("goal", (existing) => ({
      ...(existing as object ?? {}),
      name: "goal",
      title: "goal",
      description: "Set or manage a persisted goal that continues until evidence says it is done",
      template: GOAL_COMMAND_TEMPLATE,
    }));
    return registry;
  };

  const toolRegistry = (registry: Oc2Registry) => {
    (registry.add as Oc2Add)({
      name: "get_goal",
      description:
        "Read the persisted thread goal for this session. Call before planning or claiming progress whenever /goal is active. Returns null when none exists.",
      args: {},
      async execute(_args: unknown, sctx: Oc2ToolContext) {
        const { service } = await serviceForSession(sctx.sessionID);
        const goal = service.get(sctx.sessionID);
        return JSON.stringify({
          goal: goal ?? null,
          active: goal?.status === "active",
          contract: goal ? formatGoalStatus(goal) : "No persisted goal.",
        });
      },
    });

    (registry.add as Oc2Add)({
      name: "create_goal",
      description:
        "Create a persisted thread goal only when the user or system explicitly asked for a goal (e.g. via /goal). Do not infer goals from ordinary tasks.",
      args: {
        objective: { type: "string", description: "the goal objective" },
        token_budget: { type: "number", description: "optional token budget" },
        verification: { type: "string", description: "optional success criteria" },
        constraints: { type: "string", description: "optional non-goals" },
        check: { type: "string", description: "optional host check command" },
      },
      async execute(args: {
        objective: string;
        token_budget?: number;
        verification?: string;
        constraints?: string;
        check?: string;
      }, sctx: Oc2ToolContext) {
        const { service } = await serviceForSession(sctx.sessionID);
        try {
          const goal = await service.createFromModel(sctx.sessionID, {
            objective: args.objective,
            tokenBudget: args.token_budget,
            verification: args.verification,
            constraints: args.constraints,
            checks: args.check ? [args.check] : [],
          }, sctx.agent);
          drive(sctx.sessionID, service);
          return JSON.stringify({ goal, created: true });
        } catch (error) {
          if (error instanceof GoalOwnedError) {
            return JSON.stringify({ error: error.code });
          }
          throw error;
        }
      },
    });

    (registry.add as Oc2Add)({
      name: "update_goal",
      description:
        "Mark the active thread goal complete or unmet after an evidence audit. evidence is REQUIRED: for complete, describe commands run and files changed (with file names); for unmet, describe the concrete blocker.",
      args: {
        status: { type: "string", description: '"complete" or "unmet"' },
        evidence: {
          type: "string",
          description:
            "required — concrete evidence: commands run and results, or files changed (mention file names)",
        },
        summary: { type: "string", description: "short summary of what was verified" },
      },
      async execute(args: {
        status: string;
        evidence: string;
        summary?: string;
      }, sctx: Oc2ToolContext) {
        const { service } = await serviceForSession(sctx.sessionID);
        try {
          if (args.status === "unmet") {
            const goal = await service.markUnmet(sctx.sessionID, args.evidence ?? "");
            return JSON.stringify({ approved: false, goal, reason: goal.blocker });
          }
          const result = await service.completeFromModel(sctx.sessionID, {
            evidence: args.evidence,
            summary: args.summary ?? args.evidence,
          });
          if (!result.approved) {
            drive(sctx.sessionID, service);
            return JSON.stringify({
              ...result,
              retry:
                'Completion rejected. Retry update_goal with status "complete" and a concrete evidence string that names the commands you ran and the files you changed.',
            });
          }
          return JSON.stringify(result);
        } catch (error) {
          if (error instanceof GoalOwnedError) {
            return JSON.stringify({ error: error.code });
          }
          throw error;
        }
      },
    });

    (registry.add as Oc2Add)({
      name: "goal_pause",
      description:
        "Pause the session's goal. Only call when the user explicitly asked (e.g. /goal pause).",
      args: {},
      async execute(_args: unknown, sctx: Oc2ToolContext) {
        const { service } = await serviceForSession(sctx.sessionID);
        return service.apply(sctx.sessionID, { action: "pause" }, { start: false });
      },
    });

    (registry.add as Oc2Add)({
      name: "goal_resume",
      description:
        "Resume the session's paused goal. Only call when the user explicitly asked (e.g. /goal resume).",
      args: {},
      async execute(_args: unknown, sctx: Oc2ToolContext) {
        const { service } = await serviceForSession(sctx.sessionID);
        const receipt = await service.apply(
          sctx.sessionID,
          { action: "resume" },
          { start: false, agent: sctx.agent },
        );
        drive(sctx.sessionID, service);
        return receipt;
      },
    });

    (registry.add as Oc2Add)({
      name: "goal_clear",
      description:
        "Clear every goal in the session. Only call when the user explicitly asked (e.g. /goal clear).",
      args: {},
      async execute(_args: unknown, sctx: Oc2ToolContext) {
        const { service } = await serviceForSession(sctx.sessionID);
        return service.apply(sctx.sessionID, { action: "clear" }, { start: false });
      },
    });

    return registry;
  };

  return {
    wire() {
      input.ctx.command?.transform(commandRegistry);
      input.ctx.tool?.transform(toolRegistry);
      log("opencode-goal OC2 wiring registered");
    },
    serviceFor,
    drive,
    commandRegistry,
    toolRegistry,
    parse: parseGoalCommand,
    close() {
      for (const service of services.values()) service.close();
      services.clear();
    },
  };
}

export function parseJudgeText(text: string) {
  return parseJudgeOutput(text);
}

export function goalStartPrompt(goal: Parameters<typeof startPrompt>[0]) {
  return startPrompt(goal);
}

export { GoalCommandError };

const oc2Module = {
  id: "opencode-goal",
  effect: {},
  setup(ctx: Oc2Context) {
    const plugin = createOc2Plugin({ ctx });
    plugin.wire();
    return {};
  },
};

export default oc2Module;
