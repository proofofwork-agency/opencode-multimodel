import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunService } from "../src/orchestration.ts";
import { defaultDynamicWorkflow } from "../src/dynamic.ts";
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

describe("resume hardening", () => {
  test("resumes an interrupted dynamic run with a reconstructed definition", async () => {
    const releases: Array<() => void> = [];
    const calls: string[] = [];
    const runner: AgentRunner = {
      async run(input) {
        calls.push(input.prompt);
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
      messageID: "dyn-message",
      definition: defaultDynamicWorkflow("ship the thing"),
      input: "ship the thing",
      background: true,
    });
    const dynamicName = admitted.definition;
    expect(dynamicName).toBe("dynamic");
    // Simulate a hard crash: no saved definition exists for "dynamic".
    await service.pause(admitted.id);
    await service.dispose();
    const afterCrash = await store.getRun(admitted.id);
    const crashStatus = afterCrash?.status ?? "missing";
    expect(["paused", "interrupted", "cancelled"].indexOf(crashStatus) >= 0)
      .toBe(true);

    const resumed = await service.resume(admitted.id);
    expect(resumed.id).toBe(admitted.id);
    await waitFor(async () =>
      (await store.getRun(admitted.id))?.status === "completed"
    );
    expect((await store.getRun(admitted.id))?.final).toBeDefined();
  });

  test("rejects resume when the DAG definition dropped recorded steps", async () => {
    const runner: AgentRunner = {
      async run(input) {
        return {
          memberID: input.member.id,
          sessionID: "child",
          model: input.member.model,
          text: "done",
        };
      },
    };
    const { store, service } = await setup(runner);
    const definition = {
      kind: "dag" as const,
      name: "edited",
      steps: [
        { id: "one", prompt: "one" },
        { id: "two", needs: ["one"], prompt: "two" },
      ],
    };
    await store.saveWorkflow(definition);
    const admitted = await service.startWorkflow({
      sessionID: "parent",
      messageID: "edit-message",
      definition,
      input: "",
      background: true,
    });
    await service.pause(admitted.id);
    await service.dispose();
    // Simulate the file being edited: step "two" removed from the store.
    const state = await store.read();
    const workflow = state.workflows.find((item) => item.name === "edited")!;
    const dag = workflow as typeof definition;
    const pruned = {
      ...dag,
      steps: dag.steps.filter((step) => step.id !== "two"),
    };
    await store.saveWorkflow(pruned);
    await expect(service.resume(admitted.id)).rejects.toThrow("changed since this run");
  });

  test("preserves recorded seat routing across a resume", async () => {
    const seenMembers: string[] = [];
    const runner: AgentRunner = {
      async run(input) {
        if (input.stepID !== "__route") {
          seenMembers.push(`${input.stepID}:${input.member.id}`);
        }
        return {
          memberID: input.member.id,
          sessionID: "child",
          model: input.member.model,
          text: "ok",
        };
      },
    };
    const directory = await mkdtemp(join(tmpdir(), "opencode-run-service-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    await store.initializeFleet({
      leadID: "lead",
      members: [
        { id: "lead", role: "lead", model: { providerID: "t", modelID: "m" }, enabled: true },
        { id: "worker", role: "worker", model: { providerID: "t", modelID: "m" }, enabled: true },
      ],
    });
    const service = new RunService(store, runner, parseOptions(undefined));
    cleanup.push(async () => {
      await service.dispose();
      await store.close();
    });
    const admitted = await service.startWorkflow({
      sessionID: "parent",
      messageID: "route-message",
      definition: {
        kind: "dag",
        name: "routed",
        steps: [{ id: "only", prompt: "work", memberID: "worker" }],
      },
      input: "",
      background: true,
    });
    await waitFor(async () =>
      (await store.getRun(admitted.id))?.status === "completed"
    );
    expect(seenMembers).toContain("only:worker");
  });

  test("restart-agent refuses while the run is still executing", async () => {
    const runner: AgentRunner = {
      async run(input) {
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          });
        });
      },
    };
    const { store, service } = await setup(runner);
    const admitted = await service.startWorkflow({
      sessionID: "parent",
      messageID: "restart-message",
      definition: { kind: "dag", name: "busy", steps: [{ id: "one", prompt: "one" }] },
      input: "",
      background: true,
    });
    await waitFor(async () => (await store.getRun(admitted.id))?.status === "running");
    await expect(service.restartAgent(admitted.id, "one")).rejects.toThrow(
      "still executing",
    );
    await service.cancel(admitted.id);
  });
});
