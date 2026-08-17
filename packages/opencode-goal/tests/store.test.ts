import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "../src/store.ts";

async function tempStore() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  return new GoalStore(join(directory, "goal.sqlite"));
}

test("replaces a goal and resets usage", async () => {
  const store = await tempStore();
  const first = store.replace({ sessionID: "ses", objective: "one" });
  store.account("ses", first.goalID, { tokens: 50, turn: true });
  const second = store.replace({ sessionID: "ses", objective: "two" });
  expect(second.goalID).not.toBe(first.goalID);
  expect(store.get("ses")?.tokensUsed).toBe(0);
  expect(store.get("ses")?.objective).toBe("two");
  store.close();
});

test("ignores stale goal_id updates", async () => {
  const store = await tempStore();
  const first = store.replace({ sessionID: "ses", objective: "one" });
  store.replace({ sessionID: "ses", objective: "two" });
  expect(store.update("ses", first.goalID, { status: "complete" })).toBeUndefined();
  expect(store.get("ses")?.status).toBe("active");
  store.close();
});

test("atomically flips to budget_limited when usage crosses the cap", async () => {
  const store = await tempStore();
  const goal = store.replace({
    sessionID: "ses",
    objective: "one",
    tokenBudget: 100,
  });
  const next = store.account("ses", goal.goalID, { tokens: 120, turn: true });
  expect(next?.status).toBe("budget_limited");
  expect(next?.tokensUsed).toBe(120);
  store.close();
});
