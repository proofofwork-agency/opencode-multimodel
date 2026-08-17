import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { GoalStore, LOCK_TTL_MS } from "../src/store.ts";

async function tempStore() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  return new GoalStore(join(directory, "goal.sqlite"));
}

test("a live foreign owner blocks locking until released", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const path = join(directory, "goal.sqlite");
  const owner = new GoalStore(path);
  expect(owner.tryLock("ses")).toBe(true);
  const intruder = new GoalStore(path);
  expect(intruder.tryLock("ses")).toBe(false);
  expect(intruder.foreignOwnerLive("ses")).toBe(true);
  owner.unlock("ses");
  expect(intruder.tryLock("ses")).toBe(true);
  owner.close();
  intruder.close();
});

test("a dead foreign owner's stale lock is taken over", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const path = join(directory, "goal.sqlite");
  const owner = new GoalStore(path);
  owner.tryLock("ses");
  const intruder = new GoalStore(path);
  const raw = new Database(path);
  raw.query(
    "UPDATE goal_locks SET updated_at = ?, pid = 99999999 WHERE session_id = 'ses'",
  ).run(Date.now() - LOCK_TTL_MS - 1_000);
  raw.close();
  expect(intruder.foreignOwnerLive("ses")).toBe(false);
  expect(intruder.tryLock("ses")).toBe(true);
  owner.close();
  intruder.close();
});

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

test("imports a missing snapshot row and lists crash-recoverable goals", async () => {
  const store = await tempStore();
  store.replace({ sessionID: "user", objective: "stay paused" });
  const paused = store.get("user")!;
  store.update("user", paused.goalID, { status: "paused", pauseReason: "user" });
  store.replace({ sessionID: "live", objective: "keep going" });
  store.importMissing({
    ...store.get("live")!,
    sessionID: "orphan",
    goalID: "g-orphan",
    objective: "from snapshot",
    status: "active",
  });
  const ids = store.listContinuable().map((goal) => goal.sessionID).sort();
  expect(ids).toEqual(["live", "orphan"]);
  store.clearForeignLocks();
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
