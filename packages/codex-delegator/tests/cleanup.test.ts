import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexDelegator } from "../src/delegator.ts";
import type { JsonRpcTransportOptions, RpcTransport } from "../src/json-rpc.ts";

class CleanupTransport implements RpcTransport {
  readonly id = `cleanup-${crypto.randomUUID()}`;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private listeners = new Set<(message: Record<string, unknown>) => void>();

  constructor(
    private readonly options: JsonRpcTransportOptions,
    private readonly failDelete = false,
  ) {}

  async request(method: string, params: unknown = {}) {
    this.requests.push({ method, params });
    if (method === "thread/start" || method === "thread/resume")
      return { thread: { id: `thread-${this.id}` } };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method === "thread/delete") {
      if (this.failDelete) throw new Error("delete failed");
      return {};
    }
    return {};
  }

  subscribe(listener: (message: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {}
}

describe("managed worktree cleanup", () => {
  test("close removes the managed worktree and deletes the Codex thread", async () => {
    const root = await gitFixture();
    const transports: CleanupTransport[] = [];
    const delegate = new CodexDelegator({
      stateDir: join(root, "state"),
      openTransport: async (options) => {
        const transport = new CleanupTransport(options);
        transports.push(transport);
        return transport;
      },
    });
    const handle = await delegate.create({
      seatId: "codex-cleanup",
      cwd: root,
      isolation: "worktree",
    });
    const worktree = (await delegate.inspect(handle)).worktree;
    expect(worktree).toBeTruthy();
    expect(await Bun.file(join(worktree!, ".git")).exists()).toBe(true);
    await delegate.close(handle);
    expect((await delegate.inspect(handle)).status).toBe("closed");
    expect(await Bun.file(join(worktree!, ".git")).exists()).toBe(false);
    expect(
      transports[0]?.requests.map((request) => request.method),
    ).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/delete",
    ]);
    const listed = await git(root, ["worktree", "list", "--porcelain"]);
    expect(listed).not.toContain(worktree!);
  });

  test("explicit cleanup deletes a current-checkout thread without removing the checkout", async () => {
    const root = await gitFixture();
    const transports: CleanupTransport[] = [];
    const delegate = new CodexDelegator({
      stateDir: join(root, "state"),
      openTransport: async (options) => {
        const transport = new CleanupTransport(options);
        transports.push(transport);
        return transport;
      },
    });
    const handle = await delegate.create({
      seatId: "codex-current-cleanup",
      cwd: root,
      isolation: "current",
      mode: "read-only",
    });
    await delegate.close(handle, { cleanup: true });
    expect((await delegate.inspect(handle)).status).toBe("closed");
    expect(await Bun.file(join(root, ".git", "HEAD")).exists()).toBe(true);
    expect(
      transports[0]?.requests.map((request) => request.method),
    ).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/delete",
    ]);
  });

  test("surfaces thread deletion failures and keeps the seat retryable", async () => {
    const root = await gitFixture();
    const delegate = new CodexDelegator({
      stateDir: join(root, "state"),
      openTransport: async (options) => new CleanupTransport(options, true),
    });
    const handle = await delegate.create({
      seatId: "codex-delete-failure",
      cwd: root,
      isolation: "current",
      mode: "read-only",
    });
    await expect(
      delegate.close(handle, { cleanup: true }),
    ).rejects.toThrow("delete failed");
    expect(await delegate.inspect(handle)).toMatchObject({
      status: "idle",
      threadId: expect.any(String),
    });
    await delegate.close(handle, { cleanup: false });
    expect((await delegate.inspect(handle)).status).toBe("closed");
  });
});

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-delegator-cleanup-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "delegator@example.invalid"]);
  await git(root, ["config", "user.name", "Codex Delegator Test"]);
  await Bun.write(join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-qm", "fixture"]);
  return root;
}

async function git(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}
