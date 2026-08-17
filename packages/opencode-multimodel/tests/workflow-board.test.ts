import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDynamicWorkflow } from "../src/dynamic.ts";
import { RunService } from "../src/orchestration.ts";
import { parseOptions } from "../src/options.ts";
import { StateStore } from "../src/state.ts";
import {
  adjacentBoardRun,
  boardOverview,
  buildWorkflowBoardRun,
  chunkTasks,
  listWorkflowBoardRuns,
  nextBoardAgent,
  preferredBoardAgent,
  previousBoardAgent,
  resolveWorkflowBoard,
} from "../src/workflow-board.ts";
import type { AgentRunner, DurableRun, Fleet } from "../src/types.ts";

const fleet: Fleet = {
  leadID: "session",
  members: [
    {
      id: "session",
      role: "session model",
      model: { providerID: "xai", modelID: "grok-4.6" },
      enabled: true,
    },
    {
      id: "codex",
      role: "worker",
      model: { providerID: "openai", modelID: "gpt" },
      enabled: true,
    },
  ],
};

describe("workflow board tiles", () => {
  test("splits a run into task tiles with lead and worker roles", () => {
    const board = buildWorkflowBoardRun(run(), fleet, [
      {
        stepID: "understand",
        memberID: "session",
        prompt: "Explore the repository and produce a plan",
        status: "completed",
        output: "Read src/tui.tsx first",
        model: "xai/grok-4.6",
      },
      {
        stepID: "change",
        memberID: "codex",
        prompt: "Execute the plan",
        status: "running",
      },
    ]);

    expect(board.leadID).toBe("session");
    expect(board.tasks.map((task) => task.id)).toEqual([
      "understand",
      "change",
      "verify",
    ]);
    expect(board.tasks[0]?.agents[0]).toMatchObject({
      role: "lead",
      memberID: "session",
      doing: "Read src/tui.tsx first",
    });
    expect(board.tasks[1]?.agents[0]).toMatchObject({
      role: "worker",
      memberID: "codex",
      doing: "Execute the plan",
    });
    expect(chunkTasks(board.tasks)).toHaveLength(2);
  });

  test("shows the selected agent's executing prompt in the overview pane", () => {
    const board = buildWorkflowBoardRun(run(), fleet, [{
      stepID: "understand",
      memberID: "session",
      prompt: "Explore the repository",
      status: "running",
    }]);
    const agent = board.tasks[0]!.agents[0]!;
    expect(boardOverview(board, agent)).toContain("LEAD · session · understand");
    expect(boardOverview(board, agent)).toContain("Executing:");
    expect(boardOverview(board, agent)).toContain("Explore the repository");
    expect(boardOverview(board)).toContain("Task:");
  });

  test("lists active workflows before finished ones", () => {
    const boards = listWorkflowBoardRuns([
      run({
        id: "old",
        status: "completed",
        updatedAt: 20,
        final: "done",
      }),
      run({
        id: "live",
        status: "running",
        updatedAt: 10,
      }),
    ], fleet);
    expect(boards.map((item) => item.id)).toEqual(["live", "old"]);
    expect(boards[0]?.active).toBe(true);
    expect(nextBoardAgent(boards[0]!, boards[0]!.tasks[0]!.agents[0]!.key)?.key)
      .toContain("change:");
    expect(adjacentBoardRun(boards, "live", 1)?.id).toBe("old");
  });

  test("prefers the running agent and wraps tile navigation", () => {
    const board = buildWorkflowBoardRun(run(), fleet);
    expect(preferredBoardAgent(board)?.stepID).toBe("change");
    const first = board.tasks[0]!.agents[0]!;
    const last = board.tasks.at(-1)!.agents[0]!;
    expect(previousBoardAgent(board, first.key)?.key).toBe(last.key);
    expect(nextBoardAgent(board, last.key)?.key).toBe(first.key);
    expect(adjacentBoardRun([], undefined, 1)).toBeUndefined();
    expect(chunkTasks([], 2)).toEqual([]);
    expect(chunkTasks(board.tasks, 2).at(-1)).toHaveLength(1);
  });

  test("adds a lead report tile and queued placeholder", () => {
    const completed = buildWorkflowBoardRun(run({
      status: "completed",
      final: "Ship the auth fix",
    }), fleet);
    expect(completed.tasks.at(-1)).toMatchObject({
      id: "report",
      agents: [{ role: "lead", output: "Ship the auth fix" }],
    });
    expect(boardOverview(completed)).toContain("Report:");
    expect(boardOverview(completed)).toContain("Ship the auth fix");

    const queued = buildWorkflowBoardRun({
      ...run({ status: "pending" }),
      steps: [],
    }, { leadID: "lead", members: [] });
    expect(queued.tasks).toEqual([expect.objectContaining({ id: "queued" })]);
    expect(queued.tasks[0]?.agents[0]?.role).toBe("lead");
  });

  test("marks collaboration seats as lead or worker and inspects a worker", () => {
    const board = buildWorkflowBoardRun({
      id: "collab_1",
      kind: "collaboration",
      definition: "council",
      sessionID: "parent",
      input: "Review the diff",
      status: "running",
      mode: "council",
      participants: ["session", "codex"],
      steps: [
        { id: "session", status: "completed", memberID: "session", output: "Lead view" },
        { id: "codex", status: "running", memberID: "codex" },
      ],
      createdAt: 1,
      updatedAt: 2,
    }, fleet, [{
      stepID: "codex",
      memberID: "codex",
      prompt: "Independent council opinion",
      status: "running",
      model: "openai/gpt",
    }]);
    expect(board.tasks[0]?.agents[0]?.role).toBe("lead");
    expect(board.tasks[1]?.agents[0]?.role).toBe("worker");
    expect(boardOverview(board, board.tasks[1]!.agents[0])).toContain(
      "WORKER · codex · codex",
    );
    expect(boardOverview(board, board.tasks[1]!.agents[0])).toContain(
      "Independent council opinion",
    );
  });

  test("resolveWorkflowBoard restores a selected run and inspects its agent", () => {
    const resolved = resolveWorkflowBoard({
      runs: [
        run({ id: "old", status: "completed", updatedAt: 1, final: "done" }),
        run({ id: "live", status: "running", updatedAt: 2 }),
      ],
      fleet,
      selectedRunID: "old",
      selectedAgentKey: "verify:session",
    });
    expect(resolved.selected?.id).toBe("old");
    expect(resolved.selectedAgent?.stepID).toBe("verify");
    expect(resolved.boards[0]?.id).toBe("live");
  });

  test("truncates long doing lines and surfaces failed step text", () => {
    const board = buildWorkflowBoardRun(run({
      steps: [{
        id: "understand",
        status: "failed",
        memberID: "session",
        error: "OpenCode model failed: timeout",
      }],
    }), fleet);
    expect(board.tasks[0]?.agents[0]?.doing).toBe("OpenCode model failed: timeout");
    const long = buildWorkflowBoardRun(run({
      steps: [{
        id: "understand",
        status: "running",
        memberID: "session",
      }],
    }), fleet, [{
      stepID: "understand",
      memberID: "session",
      prompt: "A".repeat(80),
      status: "running",
    }]);
    expect(long.tasks[0]?.agents[0]?.doing.endsWith("…")).toBe(true);
    expect(long.tasks[0]?.agents[0]?.doing.length).toBe(54);
  });
});

describe("workflow board against a live RunService", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((close) => close()));
  });

  test("persists calls the board can inspect while a run is in flight and after it finishes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-board-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const prompts: string[] = [];
    const runner: AgentRunner = {
      async run(input) {
        prompts.push(input.prompt);
        if (input.stepID === "understand") {
          await new Promise<void>((resolve) => queueMicrotask(resolve));
        }
        return {
          memberID: input.member.id,
          sessionID: `child-${input.stepID}`,
          model: input.member.model,
          text: `done:${input.stepID}`,
        };
      },
    };
    await store.initializeFleet(fleet);
    const service = new RunService(store, runner, parseOptions(undefined));
    cleanup.push(async () => {
      await service.dispose();
      await store.close();
    });

    const admitted = await service.startWorkflow({
      sessionID: "parent",
      definition: defaultDynamicWorkflow("audit the routes"),
      input: "audit the routes",
      background: true,
      sessionModel: { providerID: "xai", modelID: "grok-4.6" },
      sessionAgent: "build",
    });
    await waitFor(async () => {
      const current = await store.getRun(admitted.id);
      return current?.steps.some((step) => step.status !== "pending") === true;
    });
    const liveCalls = await store.listAgentCalls(admitted.id);
    const live = buildWorkflowBoardRun(
      (await store.getRun(admitted.id))!,
      (await store.read()).fleet,
      liveCalls,
    );
    expect(live.leadID).toBe("session");
    expect(live.tasks.map((task) => task.id)).toEqual(expect.arrayContaining([
      "understand",
      "change",
      "verify",
    ]));
    expect(live.tasks.some((task) =>
      task.agents.some((agent) => agent.role === "lead")
    )).toBe(true);
    if (liveCalls[0]) {
      expect(boardOverview(live, live.tasks[0]!.agents[0]!)).toContain(
        "Executing:",
      );
      expect(liveCalls[0].model).toBe("xai/grok-4.6");
    }

    await waitFor(async () => (await store.getRun(admitted.id))?.status === "completed");
    const finished = (await store.getRun(admitted.id))!;
    const finishedBoard = buildWorkflowBoardRun(
      finished,
      (await store.read()).fleet,
      await store.listAgentCalls(admitted.id),
    );
    expect(finishedBoard.status).toBe("completed");
    expect(finishedBoard.tasks.at(-1)?.id).toBe("report");
    expect(boardOverview(finishedBoard)).toContain("Report:");
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    expect(finishedBoard.tasks.filter((task) => task.id !== "report").every((task) =>
      task.agents[0]?.status === "completed"
    )).toBe(true);
  });
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > 3_000) throw new Error("Timed out waiting for board state.");
    await Bun.sleep(5);
  }
}

function run(overrides: Partial<DurableRun> = {}): DurableRun {
  return {
    id: "workflow_1",
    kind: "workflow",
    workflowKind: "dag",
    definition: "dynamic",
    sessionID: "parent",
    input: "audit the routes",
    status: "running",
    steps: [
      { id: "understand", status: "completed", memberID: "session" },
      { id: "change", status: "running", memberID: "codex" },
      { id: "verify", status: "pending", memberID: "session" },
    ],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as DurableRun;
}
