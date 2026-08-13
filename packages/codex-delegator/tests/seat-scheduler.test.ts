import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexDelegator } from "../src/delegator.ts";
import { AttachmentStore, type StoredAttachment } from "../src/store.ts";
import type { JsonRpcTransportOptions, RpcTransport } from "../src/json-rpc.ts";

type Tracker = {
  live: number;
  peak: number;
  opened: number;
  closed: number;
  starts: number;
};

class LaneTransport implements RpcTransport {
  readonly id = `lane-${crypto.randomUUID()}`;
  private listeners = new Set<(message: Record<string, unknown>) => void>();
  private closed = false;
  private turn = 0;

  constructor(
    private readonly options: JsonRpcTransportOptions,
    private readonly tracker: Tracker,
  ) {
    tracker.opened += 1;
  }

  async request(method: string, params: unknown = {}) {
    if (this.closed) throw new Error("closed");
    if (method === "thread/start" || method === "thread/resume") {
      const requested =
        params && typeof params === "object"
          ? (params as Record<string, unknown>).threadId
          : null;
      return {
        thread: {
          id: typeof requested === "string" ? requested : `thread-${this.id}`,
        },
      };
    }
    if (method === "turn/interrupt") return {};
    if (method !== "turn/start") return {};
    const prompt = String(
      (
        (params as Record<string, unknown>)?.input as
          | Array<{ text?: string }>
          | undefined
      )?.[0]?.text ?? "",
    );
    const turnId = `turn-${++this.turn}`;
    this.tracker.starts += 1;
    this.tracker.live += 1;
    this.tracker.peak = Math.max(this.tracker.peak, this.tracker.live);
    if (!prompt.includes("hang")) {
      setTimeout(() => {
        this.tracker.live -= 1;
        this.emit({
          method: "item/completed",
          params: {
            threadId: "t",
            turnId,
            item: { id: "m", type: "agentMessage", text: prompt },
          },
        });
        this.emit({
          method: "turn/completed",
          params: { threadId: "t", turn: { id: turnId, status: "completed" } },
        });
      }, 20);
    }
    return { turn: { id: turnId, status: "inProgress" } };
  }

  subscribe(listener: (message: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    if (!this.closed) this.tracker.closed += 1;
    this.closed = true;
  }

  private emit(message: Record<string, unknown>) {
    this.listeners.forEach((listener) => listener(message));
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-delegator-lane-"));
  const tracker: Tracker = {
    live: 0,
    peak: 0,
    opened: 0,
    closed: 0,
    starts: 0,
  };
  const delegate = new CodexDelegator({
    stateDir: join(root, "state"),
    openTransport: async (options) => new LaneTransport(options, tracker),
    ensureWorktree: async () => ({ sourceRoot: root, worktree: root }),
    runCommand: async (input) => ({
      stdout: input.argv[0] === "git" ? "" : "codex-cli 0.146.0",
      stderr: "",
      exitCode: 0,
      signal: null,
      cancelled: false,
      timedOut: false,
      overflowed: false,
    }),
  });
  return { root, tracker, delegate };
}

describe("delegate seat scheduling", () => {
  test("queues a second turn on one seat instead of raising SESSION_BUSY", async () => {
    const { root, tracker, delegate } = await fixture();
    const handle = await delegate.create({ seatId: "codex", cwd: root });
    const results = await Promise.all([
      delegate.turn(handle, "first"),
      delegate.turn(handle, "second"),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(
      results.flatMap((result) => (result.error ? [result.error.code] : [])),
    ).toEqual([]);
    expect(tracker.starts).toBe(2);
    // Serialization is the point: the app-server never sees two overlapping turns.
    expect(tracker.peak).toBe(1);
    await delegate.close(handle);
  });

  test("keeps different seats concurrent", async () => {
    const { root, tracker, delegate } = await fixture();
    const first = await delegate.create({ seatId: "codex-a", cwd: root });
    const second = await delegate.create({ seatId: "codex-b", cwd: root });
    const results = await Promise.all([
      delegate.turn(first, "a"),
      delegate.turn(second, "b"),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(tracker.peak).toBe(2);
    await delegate.closeAll();
  });

  test("cancel drains the running turn and admits the queued one", async () => {
    const { root, delegate } = await fixture();
    const handle = await delegate.create({ seatId: "codex", cwd: root });
    const hanging = delegate.turn(handle, "hang here");
    const queued = delegate.turn(handle, "queued work");
    await Bun.sleep(20);
    // The queued turn must not have started while the first one still holds the seat.
    expect((await delegate.inspect(handle)).status).toBe("running");
    await delegate.cancel(handle);
    expect((await hanging).status).toBe("cancelled");
    expect((await queued).status).toBe("completed");
  });

  test("closeAll reaps every app-server this delegator opened", async () => {
    const { root, tracker, delegate } = await fixture();
    const handles = await Promise.all(
      ["one", "two", "three"].map((seat) =>
        delegate.create({ seatId: `codex-${seat}`, cwd: root }),
      ),
    );
    expect(tracker.opened).toBe(3);
    expect(await delegate.closeAll()).toBe(3);
    expect(tracker.closed).toBe(3);
    // Idempotent: nothing left to reap on a second pass.
    expect(await delegate.closeAll()).toBe(0);
    expect((await delegate.inspect(handles[0]!)).status).toBe("closed");
  });

  test("closeAll aborts an in-flight turn without leaving the seat running", async () => {
    const { root, tracker, delegate } = await fixture();
    const handle = await delegate.create({ seatId: "codex", cwd: root });
    const hanging = delegate.turn(handle, "hang forever");
    await Bun.sleep(20);
    await delegate.closeAll();
    expect((await hanging).status).toBe("cancelled");
    expect(tracker.closed).toBe(1);
  });

  test("close cancels the active turn and rejects queued work before teardown", async () => {
    const { root, tracker, delegate } = await fixture();
    const handle = await delegate.create({ seatId: "codex", cwd: root });
    const hanging = delegate.turn(handle, "hang forever");
    const queued = delegate.turn(handle, "must not start").catch((error) => error);
    await Bun.sleep(20);
    await delegate.close(handle);
    expect((await hanging).status).toBe("cancelled");
    expect(await queued).toMatchObject({ code: "SESSION_CLOSED" });
    expect(tracker.starts).toBe(1);
    expect((await delegate.inspect(handle)).status).toBe("closed");
  });
});

describe("session-scoped attachments", () => {
  test("passes the host session into managed worktree placement", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "codex-delegator-session-worktree-"),
    );
    const placements: Array<{ seatId: string; sessionID?: string | null }> = [];
    const delegate = new CodexDelegator({
      stateDir: join(root, "state"),
      openTransport: async (options) =>
        new LaneTransport(options, {
          live: 0,
          peak: 0,
          opened: 0,
          closed: 0,
          starts: 0,
        }),
      ensureWorktree: async (_cwd, seatId, _env, sessionID) => {
        placements.push({ seatId, sessionID });
        return { sourceRoot: root, worktree: root };
      },
    });

    await delegate.create({ seatId: "codex", cwd: root, sessionID: "ses_a" });
    await delegate.create({ seatId: "codex", cwd: root, sessionID: "ses_b" });
    expect(placements).toEqual([
      { seatId: "codex", sessionID: "ses_a" },
      { seatId: "codex", sessionID: "ses_b" },
    ]);
    await delegate.closeAll();
  });

  test("resumes per (session, seat) and still adopts pre-session records", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "codex-delegator-session-store-"),
    );
    const store = new AttachmentStore(root);
    const legacy: StoredAttachment = {
      id: "legacy",
      seatId: "codex",
      transport: "app-server",
      sourceCwd: root,
      cwd: root,
      worktree: null,
      isolation: "current",
      approvalPolicy: "ask",
      mode: "read-only",
      model: null,
      threadId: "thread-legacy",
      delivery: "completed",
      lastTurn: null,
      createdAt: 1,
      updatedAt: 1,
    };
    await store.put(legacy);
    // An upgrade must not orphan a live thread: no sessionID means "anybody's".
    expect(await store.getSeat("codex", "ses_a")).toMatchObject({
      id: "legacy",
    });
    expect(await store.getSeat("codex")).toMatchObject({ id: "legacy" });

    await store.put({
      ...legacy,
      id: "a",
      sessionID: "ses_a",
      threadId: "thread-a",
      updatedAt: 2,
    });
    await store.put({
      ...legacy,
      id: "b",
      sessionID: "ses_b",
      threadId: "thread-b",
      updatedAt: 3,
    });
    expect(await store.getSeat("codex", "ses_a")).toMatchObject({
      id: "a",
      threadId: "thread-a",
    });
    expect(await store.getSeat("codex", "ses_b")).toMatchObject({
      id: "b",
      threadId: "thread-b",
    });
    // Unknown session falls back to the legacy record, never to another session's thread.
    expect(await store.getSeat("codex", "ses_c")).toMatchObject({
      id: "legacy",
    });
  });

  test("two sessions on one seat resume their own thread", async () => {
    const { root, delegate } = await fixture();
    const createdA = await delegate.create({
      seatId: "codex",
      cwd: root,
      sessionID: "ses_a",
    });
    const createdB = await delegate.create({
      seatId: "codex",
      cwd: root,
      sessionID: "ses_b",
    });
    const threadA = (await delegate.inspect(createdA)).threadId;
    const threadB = (await delegate.inspect(createdB)).threadId;
    expect(threadA).not.toBe(threadB);
    await delegate.closeAll();

    const restarted = new CodexDelegator({
      stateDir: join(root, "state"),
      openTransport: async (options) =>
        new LaneTransport(options, {
          live: 0,
          peak: 0,
          opened: 0,
          closed: 0,
          starts: 0,
        }),
      ensureWorktree: async () => ({ sourceRoot: root, worktree: root }),
    });
    const a = await restarted.resume({
      seatId: "codex",
      cwd: root,
      sessionID: "ses_a",
    });
    const b = await restarted.resume({
      seatId: "codex",
      cwd: root,
      sessionID: "ses_b",
    });
    // Seat-only lookup handed every session the same record, so the second resume
    // reused the first delegate id and clobbered its runtime.
    expect(a.id).toBe(createdA.id);
    expect(b.id).toBe(createdB.id);
    expect((await restarted.inspect(a)).threadId).toBe(threadA);
    expect((await restarted.inspect(b)).threadId).toBe(threadB);
    await restarted.closeAll();
  });

  test("a session with no record of its own creates rather than stealing another session's thread", async () => {
    const { root, delegate } = await fixture();
    const owned = await delegate.create({
      seatId: "codex",
      cwd: root,
      sessionID: "ses_a",
    });
    await delegate.close(owned);
    await expect(
      delegate.resume({ seatId: "codex", cwd: root, sessionID: "ses_b" }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await delegate.closeAll();
  });
});
