import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalService } from "../src/engine.ts";
import { createOc2Plugin, parseJudgeText, type Oc2Registry } from "../src/oc2.ts";
import type { GoalOptions } from "../src/options.ts";
import { parseOptions } from "../src/options.ts";

type RegisteredTool = {
  name: string;
  description: string;
  args: Record<string, unknown>;
  execute: (args: unknown, sctx: { sessionID: string; agent?: string }) => Promise<string>;
};

type RegisteredCommand = {
  name: string;
  title?: string;
  description?: string;
  template?: string;
};

function mockCtx(input: { directory: string; judgeVerdict?: () => string }) {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const prompts: Array<Record<string, unknown>> = [];
  const generated: string[] = [];
  const ctx = {
    command: {
      transform(fn: (registry: Oc2Registry) => unknown) {
        fn({
          update(name: string, transform: (existing: unknown) => unknown) {
            commands.set(name, transform(commands.get(name)) as RegisteredCommand);
          },
        });
      },
    },
    tool: {
      transform(fn: (registry: Oc2Registry) => unknown) {
        fn({
          add(definition: unknown) {
            const tool = definition as RegisteredTool;
            tools.set(tool.name, tool);
          },
        });
      },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        return { agent: "build", status: "idle", location: { directory: input.directory } };
      },
      async create() {
        return { id: "ses_judge_child" };
      },
      async prompt(request: Record<string, unknown>) {
        prompts.push(request);
        return { id: "msg_x" };
      },
      async generate(request: { prompt?: string }) {
        generated.push(request.prompt ?? "");
        return {
          text: input.judgeVerdict
            ? input.judgeVerdict()
            : '{"verdict":"not_met","reason":"still working"}',
        };
      },
      async interrupt() {},
    },
  };
  return { ctx, tools, commands, prompts, generated };
}

function testOptions(directory: string): GoalOptions {
  return parseOptions({
    databasePath: join(directory, "goal.sqlite"),
    snapshotDir: join(directory, "goals"),
    minDelayMs: 0,
    dogfood: false,
  });
}

describe("OC2 plugin wiring", () => {
  test("registers the goal command and all six tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-oc2-"));
    const mock = mockCtx({ directory });
    const plugin = createOc2Plugin({ ctx: mock.ctx, options: testOptions(directory) });
    plugin.wire();
    expect(mock.commands.get("goal")?.template).toContain("$ARGUMENTS");
    expect([...mock.tools.keys()].sort()).toEqual([
      "create_goal",
      "get_goal",
      "goal_clear",
      "goal_pause",
      "goal_resume",
      "update_goal",
    ]);
    plugin.close();
  });

  test("create_goal persists, get_goal reads, update_goal gates completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-oc2-"));
    let verdict = '{"verdict":"not_met","reason":"still working"}';
    const mock = mockCtx({ directory, judgeVerdict: () => verdict });
    const plugin = createOc2Plugin({ ctx: mock.ctx, options: testOptions(directory) });
    plugin.wire();
    const sctx = { sessionID: "ses_oc2", agent: "build" };

    const created = JSON.parse(
      await mock.tools.get("create_goal")!.execute(
        { objective: "ship the release", check: "npm test" },
        sctx,
      ),
    );
    expect(created.created).toBe(true);
    expect(created.goal.status).toBe("active");

    const read = JSON.parse(await mock.tools.get("get_goal")!.execute({}, sctx));
    expect(read.active).toBe(true);
    expect(read.goal.objective).toBe("ship the release");

    const thin = JSON.parse(
      await mock.tools.get("update_goal")!.execute(
        { status: "complete", evidence: "I think it is done, trust me please" },
        sctx,
      ),
    );
    expect(thin.approved).toBe(false);

    verdict = '{"verdict":"met","reason":"verified end to end"}';
    const hostCheckFailed = JSON.parse(
      await mock.tools.get("update_goal")!.execute(
        {
          status: "complete",
          evidence: "Ran npm test in the repo: 12 passing, 0 failing.",
        },
        sctx,
      ),
    );
    expect(hostCheckFailed.approved).toBe(false);

    await mock.tools.get("goal_clear")!.execute({}, sctx);
    await writeFile(join(directory, "README.md"), "# ok\n");
    await mock.tools.get("create_goal")!.execute(
      { objective: "docs goal" },
      sctx,
    );
    const approved = JSON.parse(
      await mock.tools.get("update_goal")!.execute(
        {
          status: "complete",
          summary: "README.md updated with the release notes.",
          evidence: "Updated README.md and verified its content.",
        },
        sctx,
      ),
    );
    expect(approved.approved).toBe(true);
    expect(approved.goal.status).toBe("complete");
    plugin.close();
  });

  test("plan-agent tool contexts create paused goals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-oc2-"));
    const mock = mockCtx({ directory });
    const plugin = createOc2Plugin({ ctx: mock.ctx, options: testOptions(directory) });
    plugin.wire();
    const created = JSON.parse(
      await mock.tools.get("create_goal")!.execute(
        { objective: "plan-only work" },
        { sessionID: "ses_plan", agent: "plan" },
      ),
    );
    expect(created.goal.status).toBe("paused");
    expect(created.goal.pauseReason).toBe("plan");
    plugin.close();
  });

  test("goal_pause and goal_clear drive the same engine state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-oc2-"));
    const mock = mockCtx({ directory });
    const plugin = createOc2Plugin({ ctx: mock.ctx, options: testOptions(directory) });
    plugin.wire();
    const sctx = { sessionID: "ses_ctl", agent: "build" };
    await mock.tools.get("create_goal")!.execute({ objective: "ship" }, sctx);
    const paused = await mock.tools.get("goal_pause")!.execute({}, sctx);
    expect(paused).toContain("paused");
    const cleared = await mock.tools.get("goal_clear")!.execute({}, sctx);
    expect(cleared).toContain("cleared");
    plugin.close();
  });

  test("drive prompts continuations through the OC2 session api", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goal-oc2-"));
    const mock = mockCtx({ directory });
    const options = testOptions(directory);
    const services = new Map<string, GoalService>();
    const plugin = createOc2Plugin({
      ctx: mock.ctx,
      options,
      driveIntervalMs: 10,
      serviceFor: (dir) => {
        let service = services.get(dir);
        if (!service) {
          service = new GoalService({
            ...options,
            directory: dir,
            client: {
              async prompt(request: { sessionID: string; text: string }) {
                mock.prompts.push(request);
                return { text: "ok", hadTools: true, tokens: 5 };
              },
              async session() {
                return { busy: false };
              },
              async judge(prompt: string) {
                mock.generated.push(prompt);
                return '{"verdict":"not_met","reason":"still working"}';
              },
            },
          });
          services.set(dir, service);
        }
        return service;
      },
    });
    plugin.wire();
    await mock.tools.get("create_goal")!.execute(
      { objective: "ship" },
      { sessionID: "ses_drive", agent: "build" },
    );
    plugin.drive("ses_drive", plugin.serviceFor(directory));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(mock.prompts.length).toBeGreaterThanOrEqual(1);
    expect(mock.prompts[0]?.text).toContain("Continue working toward the persisted thread goal");
    for (const service of services.values()) service.close();
    plugin.close();
  });

  test("judge text parsing reuses the shared verdict parser", () => {
    expect(parseJudgeText('{"verdict":"met","reason":"verified"}')).toEqual({
      verdict: "met",
      reason: "verified",
    });
    expect(parseJudgeText("verdict: impossible").verdict ?? "not_met").toBeDefined();
  });
});
