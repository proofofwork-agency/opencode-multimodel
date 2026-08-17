import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "os";
import { join } from "path";
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
      dialog: { open: false, replace() {}, clear() {} },
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
