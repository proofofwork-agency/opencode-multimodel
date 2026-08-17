import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalService } from "../src/engine.ts";
import type { JudgeResult } from "../src/judge.ts";
import { parseOptions } from "../src/options.ts";

async function setup(input: {
  evaluate?: JudgeResult;
  children?: Array<{ id: string }>;
  statuses?: Record<string, { type?: string }>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const prompts: string[] = [];
  const aborted: string[] = [];
  const client = {
    busy: false,
    async prompt(request: { sessionID: string; text: string }) {
      prompts.push(request.text);
      return { text: "working", hadTools: true, tokens: 20 };
    },
    async session() {
      return { busy: client.busy };
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
    evaluate: async () => input.evaluate ?? {
      verdict: "not_met",
      reason: "still working",
    },
  });
  return { directory, prompts, aborted, client, service };
}

test("sets a goal and starts a work turn", async () => {
  const { service, prompts } = await setup();
  const status = await service.handleCommand(
    "ses",
    `fix tests --check "npm test" --budget 50k`,
  );
  expect(status).toContain("Persisted thread goal: set.");
  expect(status).toContain("fix tests");
  expect(status).toContain("State: active");
  expect(prompts[0]).toContain("<opencode_goal_receipt>");
  expect(prompts[0]).toContain("<untrusted_objective>");
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

test("skips continuation when another user prompt is queued", async () => {
  const { service } = await setup();
  await service.apply("ses", { action: "set", objective: "ship", checks: [] }, {
    start: false,
  });
  service.noteHumanMessage("ses", "also fix types");
  service.noteHumanMessage("ses", "and the docs");
  const decision = await service.handleIdle("ses");
  expect(decision).toEqual({ action: "skip", reason: "user-queued" });
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

test("steers a busy session by aborting the live turn then starting the goal", async () => {
  const { service, client, aborted, prompts } = await setup();
  client.busy = true;
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

test("recoverActive continues every stored active goal", async () => {
  const { service, prompts } = await setup();
  await service.apply("ses-a", { action: "set", objective: "one", checks: [] }, {
    start: false,
  });
  await service.apply("ses-b", { action: "set", objective: "two", checks: [] }, {
    start: false,
  });
  await service.recoverActive();
  expect(prompts.some((text) => text.includes("one"))).toBe(true);
  expect(prompts.some((text) => text.includes("two"))).toBe(true);
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
