import { expect, test } from "bun:test";
import serverModule from "../src/server.ts";
import tuiModule from "../src/tui.tsx";

test("publishes separate valid OpenCode server and TUI modules", () => {
  expect(serverModule.id).toBe("opencode-btw");
  expect(typeof serverModule.server).toBe("function");
  expect("tui" in serverModule).toBe(false);
  expect(tuiModule.id).toBe("opencode-btw");
  expect(typeof tuiModule.tui).toBe("function");
  expect("server" in tuiModule).toBe(false);
});
