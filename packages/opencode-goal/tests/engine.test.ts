import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { GoalService } from "../src/engine.ts";
import type { JudgeResult } from "../src/judge.ts";
import { parseOptions } from "../src/options.ts";

async function setup(input: {
  evaluate?: JudgeResult;
  children?: Array<{ id: string }>;
  statuses?: Record<string, { type?: string }>;
  agent?: string;
  options?: Record<string, unknown>;
  promptOutputTokens?: number;
  directory?: string;
} = {}) {
  const directory = input.directory ?? await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const prompts: string[] = [];
  const synthetic: boolean[] = [];
  const aborted: string[] = [];
  const judgeCalls: string[] = [];
  const client = {
    busy: false,
    async prompt(request: { sessionID: string; text: string; synthetic?: boolean }) {
      prompts.push(request.text);
      synthetic.push(request.synthetic === true);
      return {
        text: "working",
        hadTools: true,
        tokens: 20,
        outputTokens: input.promptOutputTokens,
      };
    },
    async session() {
      return { busy: client.busy, agent: input.agent };
    },
    async abort(sessionID: string) {
      aborted.push(sessionID);
      client.busy = false;
    },
    async children() {
      return input.children ?? [];
    },
    async statuses() {
      return input.statuses ?? {};
    },
  };
  const service = new GoalService({
    ...parseOptions({
      databasePath: join(directory, "goal.sqlite"),
      snapshotDir: join(directory, "goals"),
      minDelayMs: 0,
      ...input.options,
    }),
    directory,
    client,
    now: () => 1_000,
    runHostCheck: async (command) => ({
      command,
      ok: true,
      code: 0,
      output: "ok",
    }),
    runDogfood: async () => ({
      verdict: "pass" as const,
      reason: "Dogfood run passed.",
      output: "ok",
    }),
    evaluate: async () => {
      judgeCalls.push("call");
      return input.evaluate ?? {
        verdict: "not_met",
        reason: "still working",
      };
    },
  });
  return { directory, prompts, synthetic, aborted, judgeCalls, client, service };
}

test("sets a goal and starts a work turn", async () => {
  const { service, prompts, synthetic } = await setup();
  const status = await service.handleCommand(
    "ses",
    `fix tests --check "npm test" --budget 50k`,
  );
  expect(status).toContain("Persisted thread goal: set.");
  expect(status).toContain("fix tests");
  expect(status).toContain("State: active");
  expect(prompts[0]).toContain("<opencode_goal_receipt>");
  expect(prompts[0]).toContain("<untrusted_objective>");
  expect(prompts[0]).not.toContain("Codex");
  expect(synthetic[0]).toBe(true);
  expect(service.get("ses")?.checks).toEqual(["npm test"]);
  service.close();
});

test("continues only while the goal is active and not suppressed", async () => {
  const { service, prompts } = await setup();
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  const first = await service.maybeContinue("ses");
  expect(first).toEqual({ action: "continue", kind: "continuation" });
  expect(prompts.at(-1)).toContain("Continue working toward the persisted thread goal");
  const goal = service.get("ses")!;
  service.store.update("ses", goal.goalID, { continuationSuppressed: true });
  expect((await service.maybeContinue("ses")).action).toBe("skip");
  service.close();
});

test("rejects completion without host proof and accepts check plus judge", async () => {
  const { service } = await setup({
    evaluate: { verdict: "met", reason: "npm test is green" },
  });
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  const rejected = await service.completeFromModel("ses", {
    evidence: "I finished the work and everything looks good now.",
  });
  expect(rejected.approved).toBe(false);
  expect(rejected.reason).toContain("--check");
  expect(service.get("ses")?.status).toBe("active");
  await service.apply("ses", { action: "resume" }, { start: false });
  await service.apply("ses", {
    action: "set",
    objective: "ship",
    checks: ["npm test"],
  }, { start: false });
  const accepted = await service.completeFromModel("ses", {
    evidence: "Ran npm test in package.json scripts: 18 passing, 0 failing.",
  });
  expect(accepted.approved).toBe(true);
  expect(service.get("ses")?.status).toBe("complete");
  expect(service.get("ses")?.lastVerdict?.verdict).toBe("met");
  service.close();
});

test("accepts cited existing files when no check is configured", async () => {
  const { directory, service } = await setup({
    evaluate: { verdict: "met", reason: "README exists and matches" },
  });
  await writeFile(join(directory, "README.md"), "# ok\n");
  await service.apply("ses", { action: "set", objective: "docs", checks: [] }, {
    start: false,
  });
  const result = await service.completeFromModel("ses", {
    evidence: "Updated README.md with the Goals lifecycle and command surface.",
  });
  expect(result.approved).toBe(true);
  service.close();
});

test("marks the goal impossible when the judge says so", async () => {
  const { service } = await setup({
    evaluate: { verdict: "impossible", reason: "API no longer exists" },
  });
  await service.apply("ses", {
    action: "set",
    objective: "use the removed API",
    checks: ["npm test"],
  }, { start: false });
  const result = await service.completeFromModel("ses", {
    evidence: "The removed-api.ts module is gone from the tree.",
  });
  expect(result.approved).toBe(false);
  expect(service.get("ses")?.status).toBe("impossible");
  service.close();
});

test("skips continuation while child sessions are busy", async () => {
  const { service } = await setup({
    children: [{ id: "child" }],
    statuses: { child: { type: "busy" } },
  });
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  const decision = await service.handleIdle("ses");
  expect(decision).toEqual({ action: "skip", reason: "children-busy" });
  service.close();
});

test("pauses when the user sends a message", async () => {
  const { service } = await setup();
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  service.noteHumanMessage("ses", "also fix types");
  expect(service.get("ses")?.status).toBe("paused");
  expect(service.get("ses")?.pauseReason).toBe("user");
  const decision = await service.handleIdle("ses");
  expect(decision).toEqual({ action: "skip", reason: "paused" });
  service.close();
});

test("fails closed when a host check fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  await mkdir(directory, { recursive: true });
  const service = new GoalService({
    ...parseOptions({
      databasePath: join(directory, "goal.sqlite"),
      snapshotDir: join(directory, "goals"),
    }),
    directory,
    runHostCheck: async (command) => ({
      command,
      ok: false,
      code: 1,
      output: "fail",
    }),
    runDogfood: async ({ command }) => ({
      verdict: command === "validate" ? "pass" as const : "fail" as const,
      reason: command === "validate" ? "Dogfood validate passed." : "Host check failed",
      output: "fail",
    }),
    evaluate: async () => ({ verdict: "met", reason: "worker said done" }),
  });
  await service.apply("ses", {
    action: "set",
    objective: "green tests",
    checks: ["npm test"],
  }, { start: false });
  const result = await service.completeFromModel("ses", {
    evidence: "I ran the tests and they passed.",
  });
  expect(result.approved).toBe(false);
  expect(result.reason).toContain("Host check failed");
  service.close();
});

test("steers a session by aborting any live turn so /goal does not wait in the queue", async () => {
  const { service, aborted, prompts } = await setup();
  await service.apply("ses", { action: "set", objective: "take over", checks: [] });
  expect(aborted).toEqual(["ses"]);
  expect(prompts.at(-1)).toContain("take over");
  expect(service.get("ses")?.status).toBe("active");
  expect(service.get("ses")?.steerUntil).toBe(9_000);
  service.close();
});

test("steer abort does not pause the goal as an interrupt", async () => {
  const { service } = await setup();
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  const goal = service.get("ses")!;
  service.store.update("ses", goal.goalID, { steerUntil: Date.now() + 8_000 });
  await service.handleInterrupt("ses");
  expect(service.get("ses")?.status).toBe("active");
  expect(service.get("ses")?.pauseReason).toBeUndefined();
  service.close();
});

test("reopening an active goal continues the runtime", async () => {
  const { service, prompts } = await setup();
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  expect(prompts).toEqual([]);
  await service.handleResume("ses");
  expect(prompts.at(-1)).toContain("persisted thread goal");
  expect(service.get("ses")?.status).toBe("active");
  service.close();
});

test("recoverActive continues stored active goals after a crash", async () => {
  const { service, prompts } = await setup();
  await service.apply("ses-a", { action: "set", objective: "one", checks: [] }, {
    start: false,
  });
  await service.apply("ses-b", { action: "set", objective: "two", checks: [] }, {
    start: false,
  });
  await service.apply("ses-c", { action: "set", objective: "paused by user", checks: [] }, {
    start: false,
  });
  await service.apply("ses-c", { action: "pause" }, { start: false });
  await service.recoverActive();
  expect(prompts.some((text) => text.includes("one"))).toBe(true);
  expect(prompts.some((text) => text.includes("two"))).toBe(true);
  expect(service.get("ses-a")?.status).toBe("active");
  expect(service.get("ses-b")?.status).toBe("active");
  expect(service.get("ses-c")?.status).toBe("paused");
  expect(service.get("ses-c")?.pauseReason).toBe("user");
  service.close();
});

test("recoverActive resumes leftover crash pauses and snapshot-only goals", async () => {
  const { directory, service, prompts } = await setup();
  await service.apply("ses-live", { action: "set", objective: "live", checks: [] }, {
    start: false,
  });
  const live = service.get("ses-live")!;
  service.store.update("ses-live", live.goalID, {
    status: "paused",
    pauseReason: "recovery",
  });
  const orphanDir = join(directory, "goals");
  await mkdir(orphanDir, { recursive: true });
  await writeFile(
    join(orphanDir, "ses_orphan.json"),
    `${JSON.stringify({
      version: 1,
      sessionID: "ses_orphan",
      goalID: "g-orphan",
      objective: "orphan snapshot",
      status: "active",
      checks: [],
      tokensUsed: 0,
      timeUsedSeconds: 0,
      turns: 0,
      autoTurns: 0,
      completable: false,
      updatedAt: Date.now(),
    })}\n`,
  );
  await service.recoverActive();
  expect(service.get("ses-live")?.status).toBe("active");
  expect(service.get("ses_orphan")?.status).toBe("active");
  expect(prompts.some((text) => text.includes("live"))).toBe(true);
  expect(prompts.some((text) => text.includes("orphan snapshot"))).toBe(true);
  service.close();
});

test("creates plan-mode goals paused and refuses resume", async () => {
  const { service } = await setup();
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
    agent: "plan",
  });
  expect(service.get("ses")?.status).toBe("paused");
  expect(service.get("ses")?.pauseReason).toBe("plan");
  await expect(service.apply("ses", { action: "resume" }, { agent: "plan" }))
    .rejects.toThrow("Plan mode");
  service.close();
});

test("can disable dogfood on a goal and skip the contract gate", async () => {
  const { service } = await setup();
  await service.apply("ses", {
    action: "set",
    objective: "ship",
    checks: ["npm test"],
    dogfood: false,
  }, { start: false });
  expect(service.get("ses")?.dogfood).toBe(false);
  expect(service.get("ses")?.contractPath).toBeUndefined();
  const status = await service.apply("ses", { action: "dogfood" });
  expect(status).toContain("Dogfood: off");
  await service.apply("ses", { action: "dogfood", enabled: true }, { start: false });
  expect(service.get("ses")?.dogfood).toBe(true);
  expect(service.get("ses")?.contractPath).toBeDefined();
  service.close();
});

test("records unmet with a concrete blocker", async () => {
  const { service } = await setup();
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  await service.markUnmet("ses", "Need the production API token.");
  expect(service.get("ses")?.status).toBe("unmet");
  expect(service.get("ses")?.blocker).toContain("API token");
  service.close();
});

test("refuses unmet on terminal goals", async () => {
  const { service } = await setup();
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  await service.markUnmet("ses", "Need the production API token.");
  await expect(service.markUnmet("ses", "Changed my mind about this goal."))
    .rejects.toThrow("cannot be marked unmet");
  service.close();
});

test("pauses after repeated low-output continuation turns only when output tokens are known", async () => {
  const low = await setup({ promptOutputTokens: 3 });
  await low.service.apply("ses", {
    action: "set",
    objective: "ship",
    checks: [],
  }, { start: false });
  await low.service.maybeContinue("ses");
  expect(low.service.get("ses")?.status).toBe("active");
  expect(low.service.get("ses")?.noProgressStreak).toBe(1);
  await low.service.maybeContinue("ses");
  expect(low.service.get("ses")?.status).toBe("paused");
  expect(low.service.get("ses")?.pauseReason).toBe("no_progress");
  expect((await low.service.maybeContinue("ses")).action).toBe("skip");
  low.service.close();

  const unknown = await setup();
  await unknown.service.apply("ses", {
    action: "set",
    objective: "ship",
    checks: [],
  }, { start: false });
  await unknown.service.maybeContinue("ses");
  await unknown.service.maybeContinue("ses");
  await unknown.service.maybeContinue("ses");
  expect(unknown.service.get("ses")?.status).toBe("active");
  expect(unknown.service.get("ses")?.noProgressStreak).toBe(0);
  unknown.service.close();
});

test("recoverActive honors autoResumeInterrupted=false", async () => {
  const { service } = await setup({
    options: { autoResumeInterrupted: false },
  });
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  await service.handleInterrupt("ses");
  expect(service.get("ses")?.pauseReason).toBe("interrupt");
  await service.recoverActive();
  expect(service.get("ses")?.status).toBe("paused");
  expect(service.get("ses")?.pauseReason).toBe("interrupt");
  service.close();
});

test("resolves the plan agent from the session when the caller omits it", async () => {
  const { service } = await setup({ agent: "plan" });
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  expect(service.get("ses")?.status).toBe("paused");
  expect(service.get("ses")?.pauseReason).toBe("plan");
  await expect(service.apply("ses", { action: "resume" }, { start: false }))
    .rejects.toThrow("Plan mode");
  service.close();
});

test("pins continuation prompts to the agent that started the goal", async () => {  const prompts: Array<Record<string, unknown>> = [];
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const client = {
    async prompt(request: Record<string, unknown>) {
      prompts.push(request);
      return { text: "working", hadTools: true, tokens: 20 };
    },
    async session() {
      return {};
    },
  };
  const service = new GoalService({
    ...parseOptions({
      databasePath: join(directory, "goal.sqlite"),
      snapshotDir: join(directory, "goals"),
      minDelayMs: 0,
    }),
    directory,
    client,
    now: () => 1_000,
    evaluate: async () => ({ verdict: "not_met", reason: "working" }),
  });
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
    agent: "build",
  });
  await service.maybeContinue("ses");
  expect(prompts.at(-1)?.agent).toBe("build");
  service.close();
});

test("auto-pauses on interrupt and can resume", async () => {
  const { service } = await setup();
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  await service.handleInterrupt("ses");
  expect(service.get("ses")?.status).toBe("paused");
  expect(service.get("ses")?.pauseReason).toBe("interrupt");
  await service.handleResume("ses");
  expect(service.get("ses")?.status).toBe("active");
  service.close();
});

test("a second process is passive while the owner holds the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const owner = await setup({ directory });
  const passive = await setup({ directory });
  await owner.service.apply("ses", { action: "set", objective: "own it", checks: [] }, {
    start: false,
  });

  await expect(
    passive.service.apply("ses", { action: "set", objective: "steal", checks: [] }, {
      start: false,
    }),
  ).rejects.toThrow("driving this same session's goal");
  expect((await passive.service.handleIdle("ses")))
    .toMatchObject({ action: "skip", reason: "session-owned-elsewhere" });
  expect((await passive.service.maybeContinue("ses")))
    .toMatchObject({ action: "skip", reason: "session-owned-elsewhere" });
  passive.service.noteHumanMessage("ses", "hello from the passive process");
  expect(owner.service.get("ses")?.status).toBe("active");

  // Reads stay available to the passive process.
  expect(await passive.service.apply("ses", { action: "status" }, { start: false }))
    .toContain("own it");

  await owner.service.apply("ses", { action: "clear" }, { start: false });
  await passive.service.apply("ses", { action: "set", objective: "mine now", checks: [] }, {
    start: false,
  });
  expect(passive.service.get("ses")?.objective).toBe("mine now");
  owner.service.close();
  passive.service.close();
});

test("recoverActive leaves live-owned sessions to their owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const owner = await setup({ directory });
  const second = await setup({ directory });
  await owner.service.apply("ses", { action: "set", objective: "owned", checks: [] }, {
    start: false,
  });
  await second.service.recoverActive();
  expect(second.prompts).toEqual([]);
  expect(owner.service.get("ses")?.status).toBe("active");
  owner.service.close();
  second.service.close();
});

test("add backgrounds the focused goal and focuses the new one", async () => {
  const { service, prompts } = await setup();
  await service.apply("ses", { action: "set", objective: "first goal", checks: [] }, {
    start: false,
  });
  await service.apply("ses", { action: "add", objective: "second goal", checks: [] }, {
    start: false,
  });
  const goals = service.store.listForSession("ses");
  expect(goals).toHaveLength(2);
  expect(service.get("ses")?.objective).toBe("second goal");
  expect(goals[0]?.status).toBe("paused");
  expect(goals[0]?.focused).toBe(false);
  expect(goals[1]?.focused).toBe(true);
  await service.maybeContinue("ses");
  expect(prompts.at(-1)).toContain("second goal");
  const list = await service.apply("ses", { action: "list" }, { start: false });
  expect(list).toContain("1. first goal");
  expect(list).toContain("2. second goal");
  service.close();
});

test("focus switches the active goal by list number", async () => {
  const { service, prompts } = await setup();
  await service.apply("ses", { action: "set", objective: "alpha", checks: [] }, {
    start: false,
  });
  await service.apply("ses", { action: "add", objective: "beta", checks: [] }, {
    start: false,
  });
  await service.apply("ses", { action: "focus", index: 1 }, { start: false });
  expect(service.get("ses")?.objective).toBe("alpha");
  expect(service.get("ses")?.status).toBe("active");
  await service.maybeContinue("ses");
  expect(prompts.at(-1)).toContain("alpha");
  service.close();
});

test("set replaces only the focused goal", async () => {
  const { service } = await setup();
  await service.apply("ses", { action: "set", objective: "keep me", checks: [] }, {
    start: false,
  });
  await service.apply("ses", { action: "add", objective: "replace me", checks: [] }, {
    start: false,
  });
  await service.apply("ses", { action: "set", objective: "fresh goal", checks: [] }, {
    start: false,
  });
  const goals = service.store.listForSession("ses");
  expect(goals.map((goal) => goal.objective)).toEqual([
    "keep me",
    "fresh goal",
  ]);
  expect(service.get("ses")?.objective).toBe("fresh goal");
  service.close();
});

test("sequence queues goals and promotes the next on completion", async () => {
  const bench = await setup({
    evaluate: { verdict: "met", reason: "done" },
  });
  await writeFile(join(bench.directory, "parser.ts"), "export {}\n");
  await service_apply_sequence(bench.service);
  const queued = bench.service.store.listForSession("ses");
  expect(queued).toHaveLength(2);
  expect(bench.service.get("ses")?.objective).toBe("build the parser");
  expect(queued[1]?.status).toBe("paused");
  expect(queued[1]?.pauseReason).toBe("queued");
  expect(queued[1]?.focused).toBe(false);

  const result = await bench.service.completeFromModel("ses", {
    evidence: "Built parser.ts and verified the exports load cleanly.",
  });
  expect(result.approved).toBe(true);
  expect(result.reason).toContain("promoted");
  const after = bench.service.store.listForSession("ses");
  expect(after[0]?.status).toBe("complete");
  expect(bench.service.get("ses")?.objective).toBe("write the tests");
  expect(bench.service.get("ses")?.status).toBe("active");
  expect(bench.prompts.some((text) => text.includes("write the tests")))
    .toBe(true);
  bench.service.close();
});

async function service_apply_sequence(service: import("../src/engine.ts").GoalService) {
  await service.apply(
    "ses",
    { action: "sequence", objectives: ["build the parser", "write the tests"] },
    { start: false },
  );
}

test("recovery ignores queued sequence items", async () => {
  const { service } = await setup();
  await service.apply(
    "ses",
    { action: "sequence", objectives: ["one", "two"] },
    { start: false },
  );
  await service.recoverActive();
  const goals = service.store.listForSession("ses");
  expect(goals[1]?.status).toBe("paused");
  expect(goals[1]?.pauseReason).toBe("queued");
  service.close();
});

test("a TUI service adopts the live server's owner and cooperates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const base = {
    databasePath: join(directory, "goal.sqlite"),
    snapshotDir: join(directory, "goals"),
    minDelayMs: 0,
  };
  const serverish = await setup({ directory });
  const serverOwner = serverish.service.store.ownerID;
  await serverish.service.apply("ses", { action: "set", objective: "shared", checks: [] }, {
    start: false,
  });
  // Simulate the real server process registration: a different live pid.
  const sleeper = Bun.spawn({ cmd: [process.execPath, "-e", "setTimeout(() => {}, 30000)"] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const db = new Database(join(directory, "goal.sqlite"));
  db.query(
    "INSERT INTO goal_services (owner, pid, started_at, heartbeat_at) VALUES (?, ?, 0, ?)",
  ).run(serverOwner, sleeper.pid, Date.now());
  db.close();

  const tui = new GoalService({
    ...parseOptions(base),
    directory,
    client: {
      async prompt() { return { text: "ok", hadTools: true, tokens: 5 }; },
      async session() { return {}; },
    },
    role: "tui",
    now: () => 1_000,
    evaluate: async () => ({ verdict: "not_met", reason: "working" }),
  });
  expect(tui.store.ownerID).toBe(serverOwner);
  const receipt = await tui.apply("ses", { action: "pause" }, { start: false });
  expect(receipt).toContain("paused");
  await tui.apply("ses", { action: "resume" }, { start: false });
  const continued = await tui.maybeContinue("ses");
  expect(continued.action).not.toBe("skip");
  tui.close();
  serverish.service.close();
  sleeper.kill();
});

test("idle sessions without goals are never locked by maybeContinue", async () => {
  const { service } = await setup();
  await service.maybeContinue("fresh-session");
  const locks = (service.store as unknown as { path: string });
  void locks;
  const db = new Database(locks.path, { readonly: true });
  const rows = db.query("SELECT session_id FROM goal_locks").all();
  db.close();
  expect(rows).toEqual([]);
  service.close();
});

describe("deterministic judge gate", () => {
  test("skips judge inference until judgeGateTurns meaningful turns passed", async () => {
    const { service, judgeCalls } = await setup();
    await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
      start: false,
    });
    // Each handleIdle accounts the finished turn, applies the gate, then
    // sends a continuation with hadTools=true (meaningful). The judge runs
    // on the fourth idle (third meaningful turn).
    await service.handleIdle("ses");
    await service.handleIdle("ses");
    await service.handleIdle("ses");
    expect(judgeCalls.length).toBe(0);
    await service.handleIdle("ses");
    expect(judgeCalls.length).toBe(1);
    service.close();
  });

  test("judgeGateTurns 0 restores always-judge behavior", async () => {
    const { service, judgeCalls } = await setup({
      options: { judgeGateTurns: 0 },
    });
    await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
      start: false,
    });
    await service.handleIdle("ses");
    expect(judgeCalls.length).toBe(1);
    service.close();
  });
});

describe("trajectory loop detection", () => {
  type LoopSetup = {
    service: import("../src/engine.ts").GoalService;
    prompts: string[];
  };

  async function loopSetup(
    traceTurns: unknown[][],
  ): Promise<LoopSetup> {
    const directory = await mkdtemp(join(tmpdir(), "opencode-goal-loop-"));
    const prompts: string[] = [];
    let index = 0;
    const service = new GoalService({
      ...parseOptions({
        databasePath: join(directory, "goal.sqlite"),
        snapshotDir: join(directory, "goals"),
        minDelayMs: 0,
      }),
      directory,
      client: {
        async prompt(request: { sessionID: string; text: string }) {
          prompts.push(request.text);
          return { text: "working", hadTools: true, tokens: 20 };
        },
        async session() {
          return {};
        },
        async messages() {
          const parts = traceTurns[index] ?? [];
          index += 1;
          return [
            { role: "user", parts: [{ type: "text", text: "go" }] },
            { role: "assistant", parts: parts as never },
          ];
        },
      },
      now: () => 1_000,
      evaluate: async () => ({ verdict: "not_met", reason: "working" }),
    });
    return { service, prompts };
  }

  test("ping-pong tool cycle with frozen checkpoints pauses with reason loop", async () => {
    const grepParts = (letter: string) => [
      { type: "tool", tool: "bash", args: { command: `grep ${letter} src` } },
      { type: "text", text: "no matches found" },
    ];
    const { service } = await loopSetup([
      grepParts("A"),
      grepParts("B"),
      grepParts("A"),
      grepParts("B"),
      grepParts("A"),
      grepParts("B"),
      grepParts("A"),
    ]);
    await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
      start: false,
    });
    for (let turn = 0; turn < 8; turn += 1) {
      await service.handleIdle("ses");
      const goal = service.get("ses");
      if (goal?.status === "paused") break;
    }
    const goal = service.get("ses");
    expect(goal?.status).toBe("paused");
    expect(goal?.pauseReason).toBe("loop");
    expect(goal?.blocker).toContain("grep");
    service.close();
  });

  test("evolving checkpoints keep a legitimate iteration cycle running", async () => {
    // Identical build->test->fix tool cycle, but every turn reports
    // different findings, so judge checkpoints evolve and the loop
    // detector exempts the cycle as legitimate iteration.
    const cycle = (step: number) => [
      { type: "tool", tool: "bash", args: { command: "npm run build" } },
      { type: "tool", tool: "bash", args: { command: "npm test" } },
      { type: "tool", tool: "edit", args: { file: "fix.ts" } },
      { type: "text", text: `iteration ${step}: tests ${step}/12 passing` },
    ];
    const directory = await mkdtemp(join(tmpdir(), "opencode-goal-loop-"));
    const prompts: string[] = [];
    let index = 0;
    const service = new GoalService({
      ...parseOptions({
        databasePath: join(directory, "goal.sqlite"),
        snapshotDir: join(directory, "goals"),
        minDelayMs: 0,
        judgeGateTurns: 1,
      }),
      directory,
      client: {
        async prompt(request: { sessionID: string; text: string }) {
          prompts.push(request.text);
          return { text: "working", hadTools: true, tokens: 20 };
        },
        async session() {
          return {};
        },
        async messages() {
          const parts = [
            cycle(1), cycle(2), cycle(3), cycle(4), cycle(5), cycle(6),
            cycle(7), cycle(8),
          ][index] ?? [];
          index += 1;
          return [
            { role: "user", parts: [{ type: "text", text: "go" }] },
            { role: "assistant", parts: parts as never },
          ];
        },
      },
      now: () => 1_000,
      evaluate: async () => ({ verdict: "not_met", reason: "working" }),
    });
    await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
      start: false,
    });
    for (let turn = 0; turn < 8; turn += 1) {
      await service.handleIdle("ses");
    }
    const goal = service.get("ses");
    expect(goal?.pauseReason === "loop").toBe(false);
    service.close();
  });

  test("continuation prompt after a loop pause names the pattern", async () => {
    const grepParts = (letter: string) => [
      { type: "tool", tool: "bash", args: { command: `grep ${letter} src` } },
      { type: "text", text: "no matches found" },
    ];
    const { service, prompts } = await loopSetup([
      grepParts("A"),
      grepParts("B"),
      grepParts("A"),
      grepParts("B"),
      grepParts("A"),
      grepParts("B"),
      grepParts("A"),
    ]);
    await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
      start: false,
    });
    for (let turn = 0; turn < 8; turn += 1) {
      await service.handleIdle("ses");
      if (service.get("ses")?.pauseReason === "loop") break;
    }
    expect(service.get("ses")?.pauseReason).toBe("loop");
    await service.apply("ses", { action: "resume" }, { start: false });
    await service.handleIdle("ses");
    expect(prompts.at(-1)).toContain("loop was detected");
    service.close();
  });
});
