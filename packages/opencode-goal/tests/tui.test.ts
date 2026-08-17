import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { GoalStore } from "../src/store.ts";
import { isLongResult } from "../src/tui.ts";
import tuiModule from "../src/tui.ts";

test("registers /goal as a TUI command and intercepts submit so it is not queued", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-tui-"));
  const intercepts: Array<{ name: string; priority?: number }> = [];
  const layers: Array<{ commands?: Array<{ slashName?: string }> }> = [];
  let interceptFn:
    | ((ctx: { event: { name: string }; consume: () => void }) => void)
    | undefined;
  const editor = {
    plainText: "/goal pause",
    cleared: false,
    clear() {
      this.cleared = true;
      this.plainText = "";
    },
  };
  const toasts: string[] = [];
  const api = {
    state: {
      path: { directory },
      session: {
        status() {
          return { type: "busy" };
        },
      },
    },
    client: {},
    route: {
      current: { name: "session", params: { sessionID: "ses_1" } },
    },
    keymap: {
      registerLayer(layer: { commands?: Array<{ slashName?: string }> }) {
        layers.push(layer);
        return () => {};
      },
      intercept(
        name: string,
        fn: (ctx: { event: { name: string }; consume: () => void }) => void,
        options?: { priority?: number },
      ) {
        intercepts.push({ name, priority: options?.priority });
        interceptFn = fn;
        return () => {};
      },
    },
    renderer: {
      currentFocusedEditor: editor,
    },
    ui: {
      toast(input: { message: string }) {
        toasts.push(input.message);
      },
      dialog: {
        open: false,
        replaced: 0,
        sizes: [] as string[],
        replace() {
          this.replaced += 1;
        },
        setSize(size: string) {
          this.sizes.push(size);
        },
        clear() {},
      },
    },
    attention: {
      async notify() {
        return { ok: true, notification: false, sound: false };
      },
    },
    lifecycle: {
      onDispose() {
        return () => {};
      },
    },
  };

  await tuiModule.tui(api as never, {
    databasePath: join(directory, "goal.sqlite"),
    snapshotDir: join(directory, "goals"),
  }, {} as never);

  expect(layers[0]?.commands?.map((command) => command.slashName)).toContain(
    "goal",
  );
  expect(intercepts).toEqual([{ name: "key", priority: 50_000 }]);

  const consumed: boolean[] = [];
  interceptFn?.({
    event: { name: "return" },
    consume() {
      consumed.push(true);
    },
  });
  expect(consumed).toEqual([true]);
  expect(editor.cleared).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(toasts.some((message) => /goal/i.test(message))).toBe(true);
});

test("long goal results open a scrollable dialog instead of one giant toast", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-tui-"));
  const layers: Array<{ commands?: Array<{ run?: (ctx: unknown) => void }> }> =
    [];
  const toasts: string[] = [];
  const dialog = {
    open: false,
    replaced: 0,
    sizes: [] as string[],
    replace() {
      this.replaced += 1;
    },
    setSize(size: string) {
      this.sizes.push(size);
    },
    clear() {},
  };
  const api = {
    state: {
      path: { directory },
      session: { status() { return { type: "idle" }; } },
    },
    client: {},
    route: { current: { name: "session", params: { sessionID: "ses_2" } } },
    keymap: {
      registerLayer(layer: { commands?: Array<{ run?: (ctx: unknown) => void }> }) {
        layers.push(layer);
        return () => {};
      },
      intercept() {
        return () => {};
      },
    },
    renderer: {},
    theme: {
      current: {
        text: "#fff",
        textMuted: "#aaa",
        warning: "#ff0",
      },
    },
    ui: {
      toast(input: { message: string }) {
        toasts.push(input.message);
      },
      dialog,
    },
    attention: { async notify() { return { ok: true }; } },
    lifecycle: { onDispose() { return () => {}; } },
  };

  await tuiModule.tui(api as never, {
    databasePath: join(directory, "goal.sqlite"),
    snapshotDir: join(directory, "goals"),
  }, {} as never);

  expect(isLongResult("short message")).toBe(false);
  const longHistory = Array.from({ length: 60 }, (_, index) => ({
    type: "checkpoint" as const,
    detail: `step ${index} completed with notes`,
    timestamp: 1_787_000_000_000,
  }));
  expect(isLongResult(longHistory.map((e) => e.detail).join("\n"))).toBe(true);

  const store = new GoalStore(join(directory, "goal.sqlite"));
  const seeded = store.replace({ sessionID: "ses_2", objective: "ship it" });
  store.update("ses_2", seeded.goalID, { history: longHistory });
  store.close();

  const historyCommand = layers[0]?.commands?.find(
    (command) => (command as { name?: string }).name === "goal.history",
  );
  historyCommand?.run?.({});
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(toasts.some((message) => message.includes("dialog"))).toBe(true);
  expect(dialog.replaced).toBe(1);
  expect(dialog.sizes).toContain("xlarge");
});
