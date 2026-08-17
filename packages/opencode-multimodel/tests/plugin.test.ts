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
  let serverRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      serverRequests += 1;
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/session") {
        return Response.json({ id: "child" });
      }
      if (request.method === "POST" && path === "/session/child/message") {
        return Response.json({ parts: [{ type: "text", text: "answer" }] });
      }
      if (request.method === "POST" && path === "/session/child/abort") {
        return Response.json(true);
      }
      return new Response("not found", { status: 404 });
    },
  });
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
  const legacyCalls: unknown[] = [];
  const plugin = await serverModule.server(
    {
      directory,
      client: {
        session: {
          async create(input: unknown) {
            legacyCalls.push(input);
            return { data: { id: "child" } };
          },
          async prompt(input: unknown) {
            legacyCalls.push(input);
            return { data: { parts: [{ type: "text", text: "answer" }] } };
          },
          async abort(input: unknown) {
            legacyCalls.push(input);
            return { data: true };
          },
        },
        provider: {
          async list() {
            return { data: { all: [] } };
          },
        },
      },
      serverUrl: new URL(server.url),
    } as never,
    { statePath: `${directory}/state.json`, fleet },
  );
  const config: {
    small_model?: string;
    command?: Record<string, { template: string; model?: string }>;
  } = { small_model: "test/tool-model" };
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
  expect(config.command?.collab?.template).toContain(
    "copy every character after the following whitespace into prompt",
  );
  expect(config.command?.collab?.template).toContain(
    "MUST NOT be empty",
  );
  expect(config.command?.collab?.model).toBe("test/tool-model");
  expect(config.command?.workflow?.model).toBeUndefined();
  expect(config.command?.workflow?.template).toContain("omit name");
  expect(config.command?.workflow?.template).toContain("dynamic workflow");
  expect(config.command?.fleet?.model).toBe("test/tool-model");
  expect(config.command?.mode).toBeUndefined();
  expect(config.command?.runs).toBeUndefined();
  expect(config.command?.graph).toBeUndefined();
  expect(Object.keys(plugin.tool ?? {})).toEqual([
    "multimodel_fleet",
    "multimodel_collab",
    "multimodel_run",
    "multimodel_workflow",
  ]);
  const output = await plugin.tool?.multimodel_fleet?.execute(
    { action: "list" },
    {} as never,
  );
  expect(output).toContain("Lead: lead");
  await plugin.tool?.multimodel_fleet?.execute(
    { action: "set-lead", memberID: "lead" },
    {
      async ask(input: { permission: string }) {
        asked.push(input.permission);
      },
    } as never,
  );
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
    title: "lead: completed",
    output: "answer",
  });
  expect(serverRequests).toBe(0);
  expect(legacyCalls).toEqual([
    {
      body: {
        parentID: "parent",
        title: "Fleet: lead (test/model)",
      },
    },
    {
      path: { id: "child" },
      body: {
        model: { providerID: "test", modelID: "model" },
        agent: undefined,
        system: expect.any(String),
        tools: {
          multimodel_collab: false,
          multimodel_fleet: false,
          multimodel_run: false,
          multimodel_workflow: false,
          goal_control: false,
          create_goal: false,
          update_goal: false,
          codex_delegate: false,
          codex_review: false,
          codex_status: false,
          codex_steer: false,
          codex_cancel: false,
          codex_probe: false,
        },
        parts: [{ type: "text", text: expect.any(String) }],
      },
    },
  ]);
  expect(asked).toEqual(["multimodel.fleet", "multimodel.collab"]);

  const prompted: Array<{ body?: { model?: { providerID: string; modelID: string } } }> = [];
  const dynamicPlugin = await serverModule.server(
    {
      directory,
      client: {
        session: {
          async create() {
            return { data: { id: "child" } };
          },
          async prompt(input: { body?: { model?: { providerID: string; modelID: string } } }) {
            prompted.push(input);
            return { data: { parts: [{ type: "text", text: "phase done" }] } };
          },
          async abort() {
            return { data: true };
          },
          async get() {
            return {
              data: {
                id: "parent",
                agent: "build",
                model: { providerID: "xai", id: "grok-4.6" },
              },
            };
          },
        },
        provider: {
          async list() {
            return { data: { all: [] } };
          },
        },
      },
    } as never,
    { statePath: `${directory}/dynamic-state.json`, fleet },
  );
  const dynamic = await dynamicPlugin.tool?.multimodel_workflow?.execute(
    { action: "run", input: "audit the routes" },
    {
      sessionID: "parent",
      agent: "build",
      abort: new AbortController().signal,
      async ask() {},
      metadata() {},
    } as never,
  );
  expect(dynamic).toMatchObject({
    title: "dynamic: completed",
    metadata: { status: "completed" },
  });
  expect(prompted.map((item) =>
    `${item.body?.model?.providerID}/${item.body?.model?.modelID}`
  )).toEqual([
    "xai/grok-4.6",
    "xai/grok-4.6",
    "test/model",
    "xai/grok-4.6",
    "xai/grok-4.6",
  ]);
  await dynamicPlugin.dispose?.();

  await plugin.dispose?.();
  server.stop(true);
});

test("defers provider discovery until the server is fully bootstrapped", async () => {
  const directory = `${process.env.TMPDIR ?? "/tmp"}/opencode-multimodel-discovery-${crypto.randomUUID()}`;
  let providerRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/provider") {
        return new Response("not found", { status: 404 });
      }
      providerRequests += 1;
      return Response.json({
        connected: ["openai"],
        default: { openai: "gpt-test" },
        all: [{
          id: "openai",
          name: "OpenAI",
          models: { "gpt-test": { id: "gpt-test", name: "GPT Test" } },
        }],
      });
    },
  });
  const plugin = await serverModule.server(
    {
      directory,
      serverUrl: new URL(server.url),
    } as never,
  );

  expect(providerRequests).toBe(0);
  const output = await plugin.tool?.multimodel_fleet?.execute(
    { action: "list" },
    {} as never,
  );
  expect(providerRequests).toBe(1);
  expect(output).toContain("openai/gpt-test");

  await plugin.dispose?.();
  server.stop(true);
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
    "multimodel.runs",
    "multimodel.run",
    "multimodel.graph",
  ]);
  expect(slash).toEqual([
    "fleet",
    "workflow-fleet",
    "lead",
    "collab",
    "workflow",
    "workflows",
    "mode",
    "runs",
    "graph",
  ]);
  await Promise.all(dispose.map((fn) => fn()));
});
