import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { StateStore } from "../src/state.ts";
import type { CollaborationRun, Fleet } from "../src/types.ts";

const stores: StateStore[] = [];

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
});

describe("SQLite orchestration state", () => {
  test("uses WAL, mode 0600, and accepts concurrent writers", async () => {
    const path = await databasePath();
    const first = opened(path);
    const second = opened(path);
    await first.initializeFleet(fleet());
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? first : second).upsertMember({
          id: `worker-${index}`,
          role: "worker",
          model: { providerID: "test", modelID: `model-${index}` },
          enabled: true,
          isolation: "shared",
        })
      ),
    );

    expect((await first.read()).fleet.members).toHaveLength(21);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-shm`)).mode & 0o777).toBe(0o600);
    const database = new Database(path);
    expect(database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    database.close();
  });

  test("imports legacy JSON once without removing it", async () => {
    const path = await databasePath();
    const legacyPath = path.replace(/\.sqlite$/, ".json");
    await Bun.write(legacyPath, JSON.stringify({
      version: 1,
      fleet: fleet(),
      workflows: [{
        name: "legacy",
        steps: [{ id: "one", prompt: "Do it" }],
      }],
      runs: [],
    }));
    const store = opened(path, { legacyPath });
    const state = await store.read();

    expect(state.workflows[0]).toMatchObject({ name: "legacy", kind: "dag" });
    expect(await Bun.file(legacyPath).exists()).toBe(true);
    await Bun.write(legacyPath, "{}");
    const concurrent = opened(path, { legacyPath });
    expect((await concurrent.read()).workflows).toHaveLength(1);
  });

  test("deduplicates exact tool retries by session, message, and tool", async () => {
    const store = opened(await databasePath());
    const first = run("one", "session", "message");
    const second = run("two", "session", "message");

    expect((await store.createRun(first, "multimodel_collab")).id).toBe("one");
    expect((await store.createRun(second, "multimodel_collab")).id).toBe("one");
    expect(await store.listRuns()).toHaveLength(1);
    expect((await store.createRun(
      run("three", "session", "message"),
      "multimodel_workflow",
    )).id).toBe("three");
  });

  test("marks expired in-flight leases interrupted and retains active runs", async () => {
    const path = await databasePath();
    const store = opened(path, { retention: { runs: 2, events: 20 } });
    await store.createRun(run("active", "session-a", "message-a"), "tool");
    for (const id of ["done-1", "done-2", "done-3"]) {
      const completed = run(id, `session-${id}`, `message-${id}`);
      await store.createRun(completed, "tool");
      completed.status = "completed";
      completed.updatedAt += 1;
      await store.saveRun(completed);
    }
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const database = new Database(path);
    database.query("UPDATE leases SET expires_at = 0 WHERE run_id = 'active'").run();
    database.close();

    const recovered = opened(path, { retention: { runs: 2, events: 20 } });
    const runs = await recovered.listRuns();
    expect(runs.find((item) => item.id === "active")?.status).toBe("interrupted");
    expect(runs.filter((item) => item.status === "completed")).toHaveLength(2);
  });

  test("prevents a second process from stealing an unexpired run lease", async () => {
    const path = await databasePath();
    const first = opened(path);
    const second = opened(path);
    await first.createRun(run("leased", "session", "message"), "tool");

    expect(await second.claimLease("leased")).toBe(false);
    const competing = (await second.getRun("leased"))!;
    competing.status = "completed";
    await expect(second.saveRun(competing)).rejects.toThrow(
      "leased by another plugin process",
    );
    const database = new Database(path);
    database.query("UPDATE leases SET expires_at = 0 WHERE run_id = 'leased'").run();
    database.close();
    expect(await second.claimLease("leased")).toBe(true);
  });

  test("caps the event ledger independently from active runs", async () => {
    const store = opened(await databasePath(), {
      retention: { runs: 2, events: 5 },
    });
    await store.createRun(run("active", "session", "message"), "tool");
    for (let index = 0; index < 12; index += 1) {
      await store.appendEvent("active", `event.${index}`, { index });
    }
    const state = await store.read();
    expect(state.events).toHaveLength(5);
    expect(state.runs.find((item) => item.id === "active")).toBeDefined();
  });

  test("lists agent calls with model, prompt, and output for the board", async () => {
    const store = opened(await databasePath());
    await store.createRun(run("workflow_board", "session", "message"), "tool");
    await store.saveAgentCall({
      runID: "workflow_board",
      stepID: "understand",
      callIndex: 0,
      memberID: "session",
      prompt: "Explore the repository",
      options: {
        model: { providerID: "xai", modelID: "grok-4.6" },
        agent: "build",
      },
      status: "completed",
      sessionID: "child",
      output: "Look at src/tui.tsx",
    });
    const calls = await store.listAgentCalls("workflow_board");
    expect(calls).toEqual([{
      stepID: "understand",
      memberID: "session",
      prompt: "Explore the repository",
      status: "completed",
      output: "Look at src/tui.tsx",
      error: undefined,
      model: "xai/grok-4.6",
    }]);
    expect(await store.listAgentCalls("missing")).toEqual([]);
  });
});

function opened(
  path: string,
  options?: ConstructorParameters<typeof StateStore>[1],
) {
  const store = new StateStore(path, options);
  stores.push(store);
  return store;
}

async function databasePath() {
  return join(
    await mkdtemp(join(tmpdir(), "opencode-multimodel-state-")),
    "state.sqlite",
  );
}

function fleet(): Fleet {
  return {
    leadID: "lead",
    members: [{
      id: "lead",
      role: "lead",
      model: { providerID: "test", modelID: "model" },
      enabled: true,
      isolation: "shared",
    }],
  };
}

function run(
  id: string,
  sessionID: string,
  messageID: string,
): CollaborationRun {
  const now = Date.now();
  return {
    id,
    kind: "collaboration",
    definition: "lead",
    sessionID,
    messageID,
    input: "Question",
    status: "pending",
    mode: "lead",
    participants: ["lead"],
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
}
