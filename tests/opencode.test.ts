import { describe, expect, test } from "bun:test";
import {
  asOpenCodeClient,
  discoverFleet,
  OpenCodeAgentRunner,
} from "../src/opencode.ts";
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
      multimodel_workflow: false,
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
              connected: ["anthropic", "codex-delegate"],
              default: { anthropic: "claude", "codex-delegate": "gpt-codex" },
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
              ],
            },
          };
        },
      },
    });

    const discovered = await discoverFleet(client);
    expect(discovered.members.map((item) => item.model.providerID)).toEqual([
      "anthropic",
      "codex-delegate",
    ]);
    expect(discovered.members[1]?.model.modelID).toBe("gpt-codex");
  });
});
