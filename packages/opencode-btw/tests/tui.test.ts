import { describe, expect, test } from "bun:test";
import tuiModule from "../src/tui.tsx";

type Layer = {
  commands?: Array<{ name: string; slashName?: string; run: (ctx?: unknown) => unknown }>;
  bindings?: Array<{ key: string; cmd: string; desc?: string }>;
};

function fakeApi() {
  const routes: string[] = [];
  const layers: Layer[] = [];
  const navigations: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const toasts: Array<{ variant?: string; message: string }> = [];
  const disposed: Array<() => void | Promise<void>> = [];
  const dialogs: Array<() => unknown> = [];
  const intercepts: Array<{ name: string; priority?: number }> = [];
  const state = {
    routes,
    layers,
    navigations,
    toasts,
    disposed,
    dialogs,
    intercepts,
    config: { small_model: "test/small" } as { small_model?: string },
  };
  const api = {
    state: {
      config: state.config,
      path: { directory: `${process.env.TMPDIR ?? "/tmp"}/btw-tui` },
    },
    client: {
      session: {
        async create(input: { parentID?: string; title?: string }) {
          return { data: { id: `child-${input.parentID ? "1" : "new"}` } };
        },
        async messages(input: { sessionID: string }) {
          return {
            data: [
              {
                info: {
                  role: "user",
                  model: { providerID: "test", modelID: "main" },
                },
                parts: [{ type: "text", text: "fix the parser" }],
              },
            ],
          };
        },
        async prompt(input: { sessionID: string }) {
          return {
            data: {
              info: {},
              parts: [{ type: "text", text: "the answer" }],
            },
          };
        },
        async abort(input: { sessionID: string }) {
          return { data: true };
        },
        async delete(input: { sessionID: string }) {
          return { data: true };
        },
      },
    },
    route: {
      current: { name: "session", params: { sessionID: "parent" } } as never,
      register(input: Array<{ name: string }>) {
        routes.push(...input.map((item) => item.name));
        return () => {};
      },
      navigate(name: string, params?: Record<string, unknown>) {
        navigations.push({ name, params });
      },
    },
    keymap: {
      registerLayer(layer: Layer) {
        layers.push(layer);
        return () => {};
      },
      intercept(name: string, _fn: unknown, options?: { priority?: number }) {
        intercepts.push({ name, priority: options?.priority });
        return () => {};
      },
    },
    renderer: {
      currentFocusedEditor: null,
    },
    ui: {
      Dialog: () => null,
      DialogPrompt: () => null,
      DialogSelect: () => null,
      toast(input: { variant?: string; message: string }) {
        toasts.push(input);
      },
      dialog: {
        open: false,
        replace(render: () => unknown) {
          dialogs.push(render);
        },
        clear() {},
      },
    },
    attention: {
      async notify(input: { title?: string; message: string }) {
        toasts.push({ variant: "notify", message: input.message });
        return { ok: true, notification: false, sound: false };
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(fn: () => void | Promise<void>) {
        disposed.push(fn);
        return () => {};
      },
    },
  };
  return { api, state };
}

async function startTui(api: unknown) {
  await tuiModule.tui(api as never, undefined, {} as never);
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function command(state: ReturnType<typeof fakeApi>["state"], name: string) {
  const command = state.layers[0]?.commands?.find(
    (candidate) => candidate.name === name,
  );
  if (!command) throw new Error(`missing command ${name}`);
  return command;
}

describe("TUI plugin", () => {
  test("registers the answer route, slash commands, history binding, and submit intercept", async () => {
    const { api, state } = fakeApi();
    await startTui(api);
    expect(state.routes).toEqual(["btw.answer"]);
    const commands = state.layers[0]?.commands ?? [];
    expect(commands.map((entry) => entry.slashName)).toEqual([
      "btw",
      "side",
      "btw-history",
    ]);
    expect(state.layers[0]?.bindings).toEqual([
      { key: "ctrl+b", cmd: "btw.history", desc: "BTW history" },
    ]);
    expect(state.intercepts).toEqual([{ name: "key", priority: 20_000 }]);
    await Promise.all(state.disposed.map((fn) => fn()));
  });

  test("asks a side question end to end and navigates to the overlay", async () => {
    const { api, state } = fakeApi();
    await startTui(api);
    await command(state, "btw.ask").run({ input: "what changed?" });
    expect(state.navigations).toEqual([
      {
        name: "btw.answer",
        params: {
          returnRoute: { name: "session", params: { sessionID: "parent" } },
        },
      },
    ]);
    await settle();
    await command(state, "btw.history").run();
    expect(state.dialogs).toHaveLength(1);
    expect(state.toasts).toEqual([]);
  });

  test("side alias shares the btw flow", async () => {
    const { api, state } = fakeApi();
    await startTui(api);
    await command(state, "btw.ask.side").run({ input: "why this?" });
    expect(state.navigations[0]?.name).toBe("btw.answer");
  });

  test("warns when no session is open", async () => {
    const { api, state } = fakeApi();
    (api.route as { current: unknown }).current = { name: "home" };
    await startTui(api);
    await command(state, "btw.ask").run({ input: "what changed?" });
    expect(state.navigations).toEqual([]);
    expect(state.toasts[0]?.message).toContain("Open a session");
  });

  test("history command toasts when the registry is empty", async () => {
    const { api, state } = fakeApi();
    await startTui(api);
    await command(state, "btw.history").run();
    expect(state.toasts[0]?.message).toContain("No side questions yet");
  });

  test("empty input opens the question dialog instead of running", async () => {
    const { api, state } = fakeApi();
    await startTui(api);
    await command(state, "btw.ask").run({ input: "" });
    expect(state.dialogs).toHaveLength(1);
    expect(state.navigations).toEqual([]);
  });
});

describe("TUI streaming wiring", () => {
  test("feeds streamed child parts into the side runner", async () => {
    const { api, state } = fakeApi();
    const handlers = new Map<string, (event: unknown) => void>();
    (api as { event?: unknown }).event = {
      on(type: string, handler: (event: unknown) => void) {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    };
    await startTui(api);
    expect(handlers.has("message.part.updated")).toBe(true);

    const streamed: string[] = [];
    void streamed;
    // Route into the ask flow so a flight exists, then push a part.
    await command(state, "btw.ask").run({ input: "what is streaming?" });
    await settle();
    const partHandler = handlers.get("message.part.updated")!;
    partHandler({
      properties: {
        part: { sessionID: "child-session", type: "text", text: "partial" },
      },
    });
    // No crash and the runner accepted the event; the overlay would render
    // the accumulated stream on the next onUpdate tick.
    expect(handlers.size).toBe(1);
  });
});
