import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunService } from "../src/orchestration.ts";
import { parseOptions } from "../src/options.ts";
import { StateStore } from "../src/state.ts";
import type { AgentRunner, Fleet } from "../src/types.ts";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

describe("durable run control", () => {
  test("cancels a background collaboration and its active child", async () => {
    const cancelled: Array<string | undefined> = [];
    const runner: AgentRunner = {
      async run(input) {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          });
        });
      },
      async cancel(_sessionID, runID) {
        cancelled.push(runID);
      },
    };
    const { store, service } = await setup(runner);
    const admitted = await service.startCollaboration({
      sessionID: "parent",
      messageID: "message",
      prompt: "Question",
      mode: "lead",
      background: true,
    });
    await waitFor(async () => (await store.getRun(admitted.id))?.status === "running");
    await service.cancel(admitted.id);
    await waitFor(async () => (await store.getRun(admitted.id))?.status === "cancelled");

    expect(cancelled).toContain(admitted.id);
    const finished = await store.getRun(admitted.id);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.steps.every((step) => step.status === "cancelled")).toBe(
      true,
    );
  });

  test("pauses DAG workflows only between agent calls and resumes in-process", async () => {
    const releases: Array<() => void> = [];
    const calls: string[] = [];
    const runner: AgentRunner = {
      async run(input) {
        calls.push(input.prompt);
        await new Promise<void>((resolve, reject) => {
          releases.push(resolve);
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          });
        });
        return {
          memberID: input.member.id,
          sessionID: `child-${calls.length}`,
          model: input.member.model,
          text: `result-${calls.length}`,
        };
      },
    };
    const { store, service } = await setup(runner);
    const admitted = await service.startWorkflow({
      sessionID: "parent",
      messageID: "message",
      definition: {
        kind: "dag",
        name: "two-step",
        steps: [
          { id: "one", prompt: "one" },
          { id: "two", needs: ["one"], prompt: "two ${one}" },
        ],
      },
      input: "",
      background: true,
    });
    await waitFor(() => calls.length === 1);
    await service.pause(admitted.id);
    releases[0]!();
    await waitFor(async () => (await store.getRun(admitted.id))?.status === "paused");
    expect(calls).toEqual(["one"]);

    await service.resume(admitted.id);
    await waitFor(() => calls.length === 2);
    releases[1]!();
    await waitFor(async () => (await store.getRun(admitted.id))?.status === "completed");
    expect(calls).toEqual(["one", "two result-1"]);
  });

  test("enforces the configured timeout for DAG workflows", async () => {
    const runner: AgentRunner = {
      async run(input) {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(input.signal?.reason),
            { once: true },
          );
        });
      },
    };
    const { service } = await setup(runner, { workflows: { timeoutMs: 100 } });
    const run = await service.startWorkflow({
      sessionID: "parent",
      messageID: "timeout-message",
      definition: {
        kind: "dag",
        name: "timeout",
        steps: [{ id: "blocked", prompt: "never finishes" }],
      },
      input: "",
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("timed out after 100 ms");
  });

  test("persists validation failures as durable failed runs", async () => {
    const { store, service } = await setup({
      async run() {
        throw new Error("must not run");
      },
    });
    const run = await service.startWorkflow({
      sessionID: "parent",
      messageID: "invalid-message",
      definition: {
        kind: "dag",
        name: "cycle",
        steps: [
          { id: "one", needs: ["two"], prompt: "one" },
          { id: "two", needs: ["one"], prompt: "two" },
        ],
      },
      input: "",
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("dependency cycle");
    expect((await store.getRun(run.id))?.status).toBe("failed");
  });
});

async function setup(runner: AgentRunner, options?: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-run-service-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  await store.initializeFleet(fleet());
  const service = new RunService(store, runner, parseOptions(options));
  cleanup.push(async () => {
    await service.dispose();
    await store.close();
  });
  return { store, service };
}

function fleet(): Fleet {
  return {
    leadID: "lead",
    members: [{
      id: "lead",
      role: "lead",
      model: { providerID: "test", modelID: "model" },
      enabled: true,
    }],
  };
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for state.");
    await Bun.sleep(5);
  }
}
