import { expect, test } from "bun:test";
import serverModule from "../src/server.ts";
import tuiModule from "../src/tui.tsx";
import type { Fleet } from "../src/types.ts";

test("publishes separate valid OpenCode server and TUI modules", () => {
  expect(serverModule.id).toBe("opencode-multimodel");
  expect(typeof serverModule.server).toBe("function");
  expect("tui" in serverModule).toBe(false);
  expect(tuiModule.id).toBe("opencode-multimodel");
  expect(typeof tuiModule.tui).toBe("function");
  expect("server" in tuiModule).toBe(false);
});

test("server plugin registers fleet, collaboration and workflow surfaces", async () => {
  const directory = `${process.env.TMPDIR ?? "/tmp"}/opencode-multimodel-${crypto.randomUUID()}`;
  const fleet: Fleet = {
    leadID: "lead",
    members: [
      {
        id: "lead",
        role: "lead",
        model: { providerID: "test", modelID: "model" },
        enabled: true,
      },
    ],
  };
  const asked: string[] = [];
  const plugin = await serverModule.server(
    {
      directory,
      client: {
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
      },
    } as never,
    { statePath: `${directory}/state.json`, fleet },
  );
  const config: { command?: Record<string, { template: string }> } = {};
  await plugin.config?.(config);

  expect(Object.keys(config.command ?? {})).toEqual(
    expect.arrayContaining([
      "lead",
      "fleet",
      "collab",
      "workflow",
      "workflows",
    ]),
  );
  expect(Object.keys(plugin.tool ?? {})).toEqual([
    "multimodel_fleet",
    "multimodel_collab",
    "multimodel_workflow",
  ]);
  const output = await plugin.tool?.multimodel_fleet?.execute(
    { action: "list" },
    {} as never,
  );
  expect(output).toContain("Lead: lead");
  const collaboration = await plugin.tool?.multimodel_collab?.execute(
    { prompt: "Question", mode: "lead" },
    {
      sessionID: "parent",
      abort: new AbortController().signal,
      async ask(input: { permission: string }) {
        asked.push(input.permission);
      },
      metadata() {},
    } as never,
  );
  expect(collaboration).toMatchObject({
    title: "lead: lead",
    output: "answer",
  });
  expect(asked).toEqual(["multimodel.collab"]);
  await plugin.dispose?.();
});

test("TUI plugin registers slash commands and dedicated routes", async () => {
  const directory = `${process.env.TMPDIR ?? "/tmp"}/opencode-multimodel-tui-${crypto.randomUUID()}`;
  const routes: string[] = [];
  const slash: string[] = [];
  const dispose: Array<() => void | Promise<void>> = [];
  const api = {
    state: { path: { directory } },
    client: {
      session: {
        async create() {
          return { data: { id: "parent" } };
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "answer" }] } };
        },
        async abort() {
          return { data: true };
        },
      },
      provider: {
        async list() {
          return {
            data: {
              connected: ["test"],
              default: { test: "model" },
              all: [
                {
                  id: "test",
                  name: "Test",
                  models: { model: { id: "model", name: "Model" } },
                },
              ],
            },
          };
        },
      },
    },
    route: {
      current: { name: "home" },
      register(input: Array<{ name: string }>) {
        routes.push(...input.map((item) => item.name));
        return () => {};
      },
      navigate() {},
    },
    keymap: {
      registerLayer(layer: { commands?: Array<{ slashName?: string }> }) {
        slash.push(
          ...(layer.commands ?? []).flatMap((command) =>
            command.slashName ? [command.slashName] : [],
          ),
        );
        return () => {};
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(fn: () => void | Promise<void>) {
        dispose.push(fn);
        return () => {};
      },
    },
  };

  await tuiModule.tui(
    api as never,
    { statePath: `${directory}/state.json` } as never,
    {} as never,
  );
  expect(routes).toEqual([
    "multimodel.fleet",
    "multimodel.collab",
    "multimodel.workflows",
    "multimodel.workflow",
  ]);
  expect(slash).toEqual(["fleet", "lead", "collab", "workflow", "workflows"]);
  await Promise.all(dispose.map((fn) => fn()));
});
