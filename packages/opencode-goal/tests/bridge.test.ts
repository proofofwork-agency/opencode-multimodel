import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCodexDelegateModel, multimodelRunGate } from "../src/bridge.ts";
import { formatGoalInjection, GoalSnapshotStore } from "../src/snapshot.ts";

test("detects an in-flight multimodel run for the same session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  await mkdir(join(directory, ".opencode"), { recursive: true });
  const path = join(directory, ".opencode", "multimodel.sqlite");
  const database = new Database(path, { create: true });
  database.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  database.query(
    "INSERT INTO runs (id, kind, session_id, status, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("workflow_1", "workflow", "ses", "running", Date.now());
  database.close();

  expect(multimodelRunGate(directory, "ses", ".opencode/multimodel.sqlite")).toEqual({
    active: true,
    runID: "workflow_1",
    kind: "workflow",
    status: "running",
  });
  expect(multimodelRunGate(directory, "other", ".opencode/multimodel.sqlite").active)
    .toBe(false);
});

test("identifies Codex delegate models and writes snapshots other plugins can read", async () => {
  expect(isCodexDelegateModel("codex-delegate", "gpt-5.6-sol")).toBe(true);
  expect(isCodexDelegateModel("anthropic", "claude")).toBe(false);

  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const snapshots = new GoalSnapshotStore(join(directory, "goals"));
  snapshots.write({
    sessionID: "ses",
    goalID: "g1",
    objective: "migrate auth",
    status: "active",
    checks: ["npm test"],
    tokensUsed: 10,
    timeUsedSeconds: 4,
    turns: 1,
    lastHadTools: true,
    continuationSuppressed: false,
    noToolStreak: 0,
    createdAt: 1,
    updatedAt: 2,
  });
  const injection = formatGoalInjection(snapshots.read("ses")!);
  expect(injection).toContain("migrate auth");
  expect(injection).toContain("Do not invoke Codex CLI /goal");
});
