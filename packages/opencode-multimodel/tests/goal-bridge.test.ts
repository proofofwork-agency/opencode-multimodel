import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActiveGoal, withGoalContext } from "../src/goal-bridge.ts";

test("injects an active parent goal into workflow child prompts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multimodel-goal-"));
  await mkdir(join(directory, ".opencode", "goals"), { recursive: true });
  await writeFile(
    join(directory, ".opencode", "goals", "ses_parent.json"),
    JSON.stringify({
      version: 1,
      sessionID: "ses_parent",
      objective: "all auth tests pass",
      status: "active",
      checks: ["npm test"],
    }),
  );
  expect(readActiveGoal(directory, "ses_parent")?.objective).toBe(
    "all auth tests pass",
  );
  const prompt = withGoalContext(directory, "ses_parent", "Implement the change.");
  expect(prompt).toContain("all auth tests pass");
  expect(prompt).toContain("Do not invoke Codex CLI /goal");
  expect(prompt).toContain("Implement the change.");
});
