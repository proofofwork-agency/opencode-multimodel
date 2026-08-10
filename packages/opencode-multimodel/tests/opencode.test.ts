import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asOpenCodeClient,
  discoverFleet,
  listAvailableFleetModels,
  OpenCodeAgentRunner,
} from "../src/opencode.ts";
import { StateStore } from "../src/state.ts";
import type { FleetMember } from "../src/types.ts";

const member: FleetMember = {
  id: "codex",
  role: "worker",
  model: { providerID: "codex-delegate", modelID: "gpt-5.6-codex" },
  agent: "plan",
  enabled: true,
};

describe("OpenCode child-session adapter", () => {
  test("reuses a child session per parent, member, model and agent", async () => {
    const created: unknown[] = [];
    const prompted: Array<Record<string, unknown>> = [];
    const client = asOpenCodeClient({
      session: {
        async create(input: unknown) {
          created.push(input);
          return { data: { id: "child" } };
        },
        async prompt(input: Record<string, unknown>) {
          prompted.push(input);
          return {
            data: { parts: [{ type: "text", text: "delegate answer" }] },
          };
        },
        async abort() {
          return { data: true };
        },
      },
    });
    const runner = new OpenCodeAgentRunner(client);

    const first = await runner.run({
      parentSessionID: "parent",
      member,
      prompt: "one",
    });
    const second = await runner.run({
      parentSessionID: "parent",
      member,
      prompt: "two",
    });

    expect(created).toHaveLength(1);
    expect(prompted).toHaveLength(2);
    expect(first.sessionID).toBe("child");
    expect(second.text).toBe("delegate answer");
    expect(prompted[0]?.tools).toEqual({
      multimodel_collab: false,
      multimodel_fleet: false,
      multimodel_run: false,
      multimodel_workflow: false,
      codex_delegate: false,
      codex_review: false,
      codex_status: false,
      codex_steer: false,
      codex_cancel: false,
      codex_probe: false,
    });
  });

  test("discovers connected providers, including a delegate provider", async () => {
    const client = asOpenCodeClient({
      session: {
        async create() {
          return { data: { id: "unused" } };
        },
        async prompt() {
          return { data: { parts: [] } };
        },
        async abort() {
          return { data: true };
        },
      },
      provider: {
        async list() {
          return {
            data: {
              connected: ["codex-delegate", "anthropic", "xai"],
              default: {
                anthropic: "claude",
                "codex-delegate": "gpt-codex",
                xai: "video",
              },
              all: [
                {
                  id: "anthropic",
                  name: "Anthropic",
                  models: { claude: { id: "claude", name: "Claude" } },
                },
                {
                  id: "codex-delegate",
                  name: "Codex Delegate",
                  models: { "gpt-codex": { id: "gpt-codex", name: "Codex" } },
                },
                {
                  id: "offline",
                  name: "Offline",
                  models: { model: { id: "model", name: "Model" } },
                },
                {
                  id: "xai",
                  name: "xAI",
                  models: {
                    video: {
                      id: "video",
                      name: "Video",
                      capabilities: { output: { text: false } },
                    },
                    grok: {
                      id: "grok",
                      name: "Grok",
                      capabilities: { output: { text: true } },
                    },
                  },
                },
              ],
            },
          };
        },
      },
    });

    const discovered = await discoverFleet(client);
    expect(discovered.members.map((item) => item.model.providerID)).toEqual([
      "codex-delegate",
      "anthropic",
      "xai",
    ]);
    expect(discovered.members[0]?.model.modelID).toBe("gpt-codex");
    expect(discovered.members[2]?.model.modelID).toBe("grok");

    const available = await listAvailableFleetModels(client);
    expect(available.map((item) =>
      `${item.providerID}/${item.modelID}`
    )).toEqual([
      "codex-delegate/gpt-codex",
      "anthropic/claude",
      "xai/grok",
    ]);
  });

  test("reuses persisted child sessions after a runner restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-child-restart-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    let creates = 0;
    const client = asOpenCodeClient({
      session: {
        async create() {
          creates += 1;
          return { data: { id: `child-${creates}` } };
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "answer" }] } };
        },
        async abort() {
          return { data: true };
        },
      },
    });
    const first = new OpenCodeAgentRunner(client, store);
    await first.run({ parentSessionID: "parent", member, prompt: "one" });
    await first.close();
    const second = new OpenCodeAgentRunner(client, store);
    const reply = await second.run({
      parentSessionID: "parent",
      member,
      prompt: "two",
    });

    expect(creates).toBe(1);
    expect(reply.sessionID).toBe("child-1");
    await second.close();
    await store.close();
  });

  test("never falls back to shared checkout when worktree creation fails", async () => {
    let creates = 0;
    const runner = new OpenCodeAgentRunner(asOpenCodeClient({
      experimental: {
        workspace: {
          async create() {
            return { error: "workspace unavailable" };
          },
          async remove() {
            return { data: true };
          },
        },
      },
      session: {
        async create() {
          creates += 1;
          return { data: { id: "child" } };
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "answer" }] } };
        },
        async abort() {
          return { data: true };
        },
      },
    }));

    await expect(runner.run({
      parentSessionID: "parent",
      member: { ...member, isolation: "worktree", model: { providerID: "test", modelID: "model" } },
      prompt: "write",
    })).rejects.toThrow("Shared-checkout fallback is forbidden");
    expect(creates).toBe(0);
  });

  test("preserves successful worktrees until explicit cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-workspace-cleanup-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    const removed: string[] = [];
    const runner = new OpenCodeAgentRunner(asOpenCodeClient({
      experimental: {
        workspace: {
          async create() {
            return { data: { id: "workspace-1", directory: "/tmp/workspace-1" } };
          },
          async remove(input: { id: string }) {
            removed.push(input.id);
            return { data: true };
          },
        },
      },
      session: {
        async create() {
          return { data: { id: "child" } };
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "answer" }] } };
        },
        async abort() {
          return { data: true };
        },
      },
    }), store);
    await runner.run({
      parentSessionID: "parent",
      runID: "run",
      member: { ...member, isolation: "worktree", model: { providerID: "test", modelID: "model" } },
      prompt: "write",
    });

    expect((await store.listWorkspaces("run"))[0]?.status).toBe("preserved");
    expect(removed).toEqual([]);
    expect(await runner.cleanupWorkspaces("run")).toBe(1);
    expect(removed).toEqual(["workspace-1"]);
    await store.close();
  });

  test("separates worktrees by run and invalidates child reuse after cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-workspace-runs-"));
    const store = new StateStore(join(directory, "state.sqlite"));
    let workspaces = 0;
    let sessions = 0;
    const runner = new OpenCodeAgentRunner(asOpenCodeClient({
      experimental: {
        workspace: {
          async create() {
            workspaces += 1;
            return { data: { id: `workspace-${workspaces}` } };
          },
          async remove() {
            return { data: true };
          },
        },
      },
      session: {
        async create() {
          sessions += 1;
          return { data: { id: `child-${sessions}` } };
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "answer" }] } };
        },
        async abort() {
          return { data: true };
        },
      },
    }), store);
    const isolated = {
      ...member,
      isolation: "worktree" as const,
      model: { providerID: "test", modelID: "model" },
    };

    await runner.run({
      parentSessionID: "parent",
      runID: "run-a",
      member: isolated,
      prompt: "one",
    });
    await runner.run({
      parentSessionID: "parent",
      runID: "run-b",
      member: isolated,
      prompt: "two",
    });
    expect(workspaces).toBe(2);
    expect(sessions).toBe(2);

    await runner.cleanupWorkspaces("run-a");
    await runner.run({
      parentSessionID: "parent",
      runID: "run-a",
      member: isolated,
      prompt: "three",
    });
    expect(workspaces).toBe(3);
    expect(sessions).toBe(3);
    expect((await store.listWorkspaces("run-a")).map((item) => item.status))
      .toEqual(["removed", "preserved"]);
    await store.close();
  });
});
