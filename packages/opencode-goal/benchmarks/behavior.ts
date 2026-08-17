import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalService } from "../src/engine.ts";
import { parseOptions } from "../src/options.ts";
import type { Goal } from "../src/types.ts";
import type { JudgeResult } from "../src/judge.ts";

type Scenario = {
  name: string;
  claim: string;
  run: () => Promise<boolean>;
};

const results: Array<{ name: string; claim: string; ok: boolean }> = [];

async function scenario(name: string, claim: string, run: () => Promise<boolean>) {
  let ok = false;
  try {
    ok = await run();
  } catch {
    ok = false;
  }
  results.push({ name, claim, ok });
}

type Harness = {
  directory: string;
  prompts: string[];
  evaluate?: JudgeResult;
  client: {
    busy: boolean;
    promptOutputTokens?: number;
    promptHadTools?: boolean;
    agent?: string;
    prompt: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    session: (id: string) => Promise<Record<string, unknown>>;
    abort: (id: string) => Promise<void>;
    children: () => Promise<Array<{ id: string }>>;
    statuses: () => Promise<Record<string, unknown>>;
  };
};

async function harness(input: {
  evaluate?: JudgeResult;
  promptOutputTokens?: number;
  promptHadTools?: boolean;
  agent?: string;
} = {}): Promise<Harness & { service: GoalService }> {
  const directory = await mkdtemp(join(tmpdir(), "goal-bench-"));
  const prompts: string[] = [];
  const client: Harness["client"] = {
    busy: false,
    promptOutputTokens: input.promptOutputTokens,
    promptHadTools: input.promptHadTools,
    agent: input.agent,
    async prompt(request) {
      prompts.push(String(request.text));
      return {
        text: "ok",
        hadTools: input.promptHadTools !== false,
        tokens: 2_000,
        outputTokens: input.promptOutputTokens,
      };
    },
    async session() {
      return { busy: client.busy, agent: client.agent };
    },
    async abort() {},
    async children() {
      return [];
    },
    async statuses() {
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
    evaluate: async () =>
      input.evaluate ?? { verdict: "not_met", reason: "still working" },
  });
  return { directory, prompts, client, service };
}

function activeGoal(goal: Goal | undefined) {
  return goal?.status === "active";
}

await scenario(
  "completion-gate",
  "unproven and failed-check completion claims are both rejected; only evidence + host check + judge pass",
  async () => {
    const bench = await harness({
      evaluate: { verdict: "met", reason: "verified" },
    });
    const { service } = bench;
    await service.apply("ses", {
      action: "set",
      objective: "ship",
      checks: [],
    }, { start: false });

    const empty = await service.completeFromModel("ses", {
      evidence: "I finished the work and everything looks good now.",
    });
    const unproven = !empty.approved && activeGoal(service.get("ses"));

    await service.apply("ses", {
      action: "set",
      objective: "ship",
      checks: ["npm test"],
    }, { start: false });
    const failed = await service.completeFromModel("ses", {
      summary: "All done and fully verified across every criterion.",
      checks: [{ command: "npm test", result: "failed" }],
    });
    const rejected = unproven && !failed.approved &&
      activeGoal(service.get("ses"));

    const good = await service.completeFromModel("ses", {
      evidence: "Ran npm test in the repo: 40 passing, 0 failing.",
    });
    service.close();
    return rejected && good.approved === true;
  },
);

await scenario(
  "contract-tamper",
  "a tampered frozen contract pauses completion with an audit reason",
  async () => {
    const bench = await harness({
      evaluate: { verdict: "met", reason: "verified" },
    });
    const { service, directory } = bench;
    await service.apply("ses", {
      action: "set",
      objective: "ship",
      checks: ["npm test"],
      dogfood: false,
    }, { start: false });
    const goal = service.get("ses")!;
    const contractPath = join(directory, "goal.contract.yaml");
    await writeFile(contractPath, "checks: [npm test]\n");
    service.store.update("ses", goal.goalID, {
      dogfood: true,
      contractPath,
      contractHash: "deadbeef",
    });
    const result = await service.completeFromModel("ses", {
      evidence: "Ran npm test in the repo: 40 passing, 0 failing.",
    });
    const stored = service.get("ses");
    service.close();
    return result.approved === false && stored?.status === "paused" &&
      stored?.pauseReason === "audit";
  },
);

await scenario(
  "no-tool-loop",
  "repeated tool-free continuation turns stop the loop instead of chatting forever",
  async () => {
    const bench = await harness({ promptHadTools: false });
    const { service, prompts } = bench;
    await service.apply("ses", {
      action: "set",
      objective: "ship",
      checks: [],
    }, { start: false });
    for (let index = 0; index < 10; index += 1) {
      await service.maybeContinue("ses");
    }
    const bounded = prompts.length <= 4;
    const stopped = (await service.maybeContinue("ses")).action === "skip";
    service.close();
    return bounded && stopped;
  },
);

await scenario(
  "no-progress-loop",
  "repeated low-output continuation turns pause the goal",
  async () => {
    const bench = await harness({ promptOutputTokens: 3, promptHadTools: true });
    const { service } = bench;
    await service.apply("ses", {
      action: "set",
      objective: "ship",
      checks: [],
    }, { start: false });
    await service.maybeContinue("ses");
    await service.maybeContinue("ses");
    const goal = service.get("ses");
    service.close();
    return goal?.status === "paused" && goal?.pauseReason === "no_progress";
  },
);

await scenario(
  "budget-wrapup",
  "the loop sends exactly one wrap-up prompt at the budget boundary and then stops",
  async () => {
    const bench = await harness();
    const { service, prompts } = bench;
    await service.apply("ses", {
      action: "set",
      objective: "ship",
      checks: [],
      tokenBudget: 3_000,
    }, { start: false });
    await service.maybeContinue("ses");
    const goal = service.get("ses")!;
    service.store.update("ses", goal.goalID, { tokensUsed: 2_600 });
    await service.maybeContinue("ses");
    const wrapups = prompts.filter((text) =>
      text.includes("reached its token budget") ||
      text.includes("safety limit")
    ).length;
    const after = await service.maybeContinue("ses");
    const stored = service.get("ses");
    service.close();
    return wrapups === 1 && after.action === "skip" &&
      stored?.status === "budget_limited";
  },
);

await scenario(
  "user-interrupt",
  "a human message pauses the loop and resume hands control back",
  async () => {
    const bench = await harness();
    const { service } = bench;
    await service.apply("ses", {
      action: "set",
      objective: "ship",
      checks: [],
    }, { start: false });
    service.noteHumanMessage("ses", "wait, change of plans please");
    const paused = service.get("ses")?.status === "paused";
    await service.apply("ses", { action: "resume" }, { start: false });
    const resumed = activeGoal(service.get("ses"));
    service.close();
    return paused && resumed;
  },
);

await scenario(
  "crash-recovery",
  "active goals continue after a restart; user-paused goals stay paused",
  async () => {
    const bench = await harness();
    const { service, directory } = bench;
    await service.apply("live", {
      action: "set",
      objective: "keep going",
      checks: [],
    }, { start: false });
    await service.apply("held", {
      action: "set",
      objective: "stay paused",
      checks: [],
    }, { start: false });
    await service.apply("held", { action: "pause" }, { start: false });
    service.close();

    const revived = await harness();
    const next = new GoalService({
      ...parseOptions({
        databasePath: join(directory, "goal.sqlite"),
        snapshotDir: join(directory, "goals"),
        minDelayMs: 0,
      }),
      directory,
      client: revived.client,
      now: () => 1_000,
      evaluate: async () => ({ verdict: "not_met", reason: "working" }),
    });
    await next.recoverActive();
    const live = next.get("live");
    const held = next.get("held");
    next.close();
    return activeGoal(live) && held?.status === "paused" &&
      held?.pauseReason === "user";
  },
);

await scenario(
  "ownership",
  "a second process is passive: reads work, mutations fail closed, no prompts fire",
  async () => {
    const bench = await harness();
    const { service, directory } = bench;
    await service.apply("ses", {
      action: "set",
      objective: "owned",
      checks: [],
    }, { start: false });
    const other = await harness();
    const passive = new GoalService({
      ...parseOptions({
        databasePath: join(directory, "goal.sqlite"),
        snapshotDir: join(directory, "goals"),
        minDelayMs: 0,
      }),
      directory,
      client: other.client,
      now: () => 1_000,
      evaluate: async () => ({ verdict: "not_met", reason: "working" }),
    });
    let denied = false;
    try {
      await passive.apply("ses", { action: "pause" }, { start: false });
    } catch {
      denied = true;
    }
    const idle = await passive.handleIdle("ses");
    const status = await passive.apply("ses", { action: "status" }, {
      start: false,
    });
    passive.close();
    service.close();
    return denied && idle.action === "skip" && status.includes("owned") &&
      other.prompts.length === 0;
  },
);

await scenario(
  "plan-mode",
  "goals created from a plan agent start paused and cannot self-resume",
  async () => {
    const bench = await harness();
    const { service } = bench;
    await service.apply("ses", {
      action: "set",
      objective: "plan-only work",
      checks: [],
    }, { start: false, agent: "plan" });
    const created = service.get("ses");
    let refused = false;
    try {
      await service.apply("ses", { action: "resume" }, {
        start: false,
        agent: "plan",
      });
    } catch {
      refused = true;
    }
    service.close();
    return created?.status === "paused" && created?.pauseReason === "plan" &&
      refused;
  },
);

await scenario(
  "multi-goal-sequence",
  "goals can be backgrounded, refocused, and queued as an auto-promoting sequence",
  async () => {
    const bench = await harness({
      evaluate: { verdict: "met", reason: "done" },
    });
    const { service, directory } = bench;
    await writeFile(join(directory, "work.md"), "# done\n");
    await service.apply("ses", {
      action: "set",
      objective: "first goal",
      checks: [],
    }, { start: false });
    await service.apply("ses", {
      action: "add",
      objective: "second goal",
      checks: [],
    }, { start: false });
    const afterAdd = service.store.listForSession("ses");
    const addOk = afterAdd.length === 2 &&
      afterAdd[0]?.status === "paused" && afterAdd[0]?.focused === false &&
      service.get("ses")?.objective === "second goal";
    await service.apply("ses", { action: "focus", index: 1 }, { start: false });
    const focusOk = service.get("ses")?.objective === "first goal" &&
      service.get("ses")?.status === "active";
    await service.apply("ses", { action: "clear" }, { start: false });
    const cleared = service.get("ses") === undefined;
    void cleared;
    await service.apply("ses", {
      action: "sequence",
      objectives: ["build the parser", "write the tests"],
    }, { start: false });
    const queued = service.store.listForSession("ses");
    const queueOk = queued.length === 2 &&
      queued[1]?.pauseReason === "queued" && queued[1]?.focused === false;
    const result = await service.completeFromModel("ses", {
      evidence: "Built work.md deliverable and verified the parser.",
    });
    const promoted = result.approved === true &&
      service.get("ses")?.objective === "write the tests" &&
      service.get("ses")?.status === "active";
    service.close();
    return addOk && focusOk && queueOk && promoted;
  },
);

const width = Math.max(...results.map((row) => row.name.length)) + 2;
console.log("opencode-goal deterministic behavior benchmark");
console.log("=".repeat(72));
for (const row of results) {
  console.log(
    `${row.name.padEnd(width)} ${row.ok ? "PASS" : "FAIL"}  ${row.claim}`,
  );
}
const passed = results.filter((row) => row.ok).length;
console.log("=".repeat(72));
console.log(`${passed}/${results.length} scenarios passed`);

if (passed !== results.length) process.exit(1);
