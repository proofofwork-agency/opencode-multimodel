import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import serverModule from "../src/server.ts";
import tuiModule from "../src/tui.ts";

test("publishes separate server and TUI modules", () => {
  expect(serverModule.id).toBe("opencode-goal");
  expect(typeof serverModule.server).toBe("function");
  expect(tuiModule.id).toBe("opencode-goal");
  expect(typeof tuiModule.tui).toBe("function");
});

test("server plugin registers goal tools and handles /goal before the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const plugin = await serverModule.server({
    directory,
    client: {
      session: {
        async prompt() {
          return { data: { parts: [{ type: "text", text: "ok" }] } };
        },
      },
    },
  } as never, {
    databasePath: join(directory, "goal.sqlite"),
    snapshotDir: join(directory, "goals"),
  });

  const config: { command?: Record<string, { template: string }> } = {};
  await plugin.config?.(config);
  expect(config.command?.goal?.template).toBe("$ARGUMENTS");

  const output = {
    parts: [{ type: "text", text: "raw" }] as Array<{ type: string; text: string }>,
  };
  await plugin["command.execute.before"]?.({
    command: "goal",
    sessionID: "ses_1",
    arguments: `fix auth --check "npm test" --budget 20k`,
  }, output as never);
  expect(output.parts[0]?.type).toBe("text");
  expect(output.parts[0]?.text).toContain("<opencode_goal_receipt>");
  expect(output.parts[0]?.text).toContain("Persisted thread goal: set.");
  expect(output.parts[0]?.text).not.toContain(
    "A persisted thread goal is now active",
  );
  expect(output.parts[0]?.text).not.toContain("Codex");

  const system: string[] = [];
  await plugin["experimental.chat.system.transform"]?.({
    sessionID: "ses_1",
    model: { providerID: "test", modelID: "main" },
  } as never, { system } as never);
  expect(system.join("\n")).toContain("OpenCode goal mode policy");
  expect(system.join("\n")).toContain("PERSISTED THREAD GOAL");
  expect(system.join("\n")).toContain("get_goal");
  expect(system.join("\n")).toContain("fix auth");
  expect(plugin.tool?.goal_control).toBeUndefined();

  const created = await plugin.tool!.get_goal!.execute({}, {
    sessionID: "ses_1",
  } as never);
  expect(JSON.stringify(created)).toContain("fix auth");

  const complete = JSON.parse(String(
    await plugin.tool!.update_goal!.execute({
      status: "complete",
      evidence: "thin",
    }, { sessionID: "ses_1" } as never),
  ));
  expect(complete.approved).toBe(false);
});
