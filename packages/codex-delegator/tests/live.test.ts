import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexDelegator } from "../src/delegator.ts";

const live = process.env.CODEX_DELEGATOR_LIVE === "1" ? test : test.skip;
const liveReview =
  process.env.CODEX_DELEGATOR_LIVE_REVIEW === "1" ? test : test.skip;
const liveScale =
  process.env.CODEX_DELEGATOR_SCALE_LIVE === "1" ? test : test.skip;

live(
  "connects to the installed Codex CLI and completes a read-only turn",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-delegator-live-"));
    const delegate = liveDelegate(join(root, "state"));
    const probe = await delegate.probe({
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(probe).toMatchObject({
      ready: true,
      account: { authenticated: true },
    });
    const handle = await delegate.create({
      seatId: "codex-live",
      cwd: process.cwd(),
      mode: "read-only",
      isolation: "current",
      confirmedUnsafe: true,
    });
    const result = await delegate.turn(handle, {
      prompt: "Reply with exactly CODEX_DELEGATOR_OK and do not use tools.",
      timeoutMs: 120_000,
    });
    expect(result.status).toBe("completed");
    expect(result.output).toContain("CODEX_DELEGATOR_OK");
    await delegate.close(handle);
  },
  180_000,
);

live(
  "writes only in a disposable managed worktree and resumes after restart",
  async () => {
    const root = await gitFixture();
    const stateDir = await mkdtemp(
      join(tmpdir(), "codex-delegator-live-state-"),
    );
    const delegate = liveDelegate(stateDir);
    const handle = await delegate.create({
      seatId: "codex-live-write",
      cwd: root,
      mode: "write",
      approval: async () => "once",
    });
    const worktree = (await delegate.inspect(handle)).worktree;
    expect(worktree).not.toBeNull();
    const result = await delegate.turn(handle, {
      prompt:
        "Create a file named codex-delegate-live.txt containing exactly CODEX_WORKTREE_OK followed by one newline. Do not change any other file.",
      timeoutMs: 180_000,
    });
    expect(result.status).toBe("completed");
    expect(
      await Bun.file(join(worktree!, "codex-delegate-live.txt")).text(),
    ).toBe("CODEX_WORKTREE_OK\n");
    expect(await Bun.file(join(root, "codex-delegate-live.txt")).exists()).toBe(
      false,
    );
    expect(await git(root, ["status", "--porcelain"])).toBe("");
    const threadId = (await delegate.inspect(handle)).threadId;
    await delegate.close(handle);

    const restarted = liveDelegate(stateDir);
    const resumed = await restarted.resume({
      seatId: "codex-live-write",
      cwd: root,
    });
    expect((await restarted.inspect(resumed)).threadId).toBe(threadId);
    const followup = await restarted.turn(resumed, {
      prompt: "Reply with exactly CODEX_RESUME_OK and do not change files.",
      timeoutMs: 120_000,
    });
    expect(followup.status).toBe("completed");
    expect(followup.output).toContain("CODEX_RESUME_OK");
    await restarted.close(resumed);
  },
  300_000,
);

liveReview(
  "runs native review in a disposable read-only checkout",
  async () => {
    const root = await gitFixture();
    await Bun.write(join(root, "README.md"), "fixture changed for review\n");
    const stateDir = await mkdtemp(
      join(tmpdir(), "codex-delegator-live-review-"),
    );
    const delegate = liveDelegate(stateDir);
    const handle = await delegate.create({
      seatId: "codex-live-review",
      cwd: root,
      mode: "read-only",
      isolation: "current",
      confirmedUnsafe: true,
    });
    const review = await delegate.review(handle, {
      target: { type: "uncommittedChanges" },
      timeoutMs: 180_000,
    });
    expect(review.status).toBe("completed");
    expect(await git(root, ["status", "--porcelain"])).toBe(" M README.md\n");
    await delegate.close(handle);
  },
  240_000,
);

live(
  "steers, cancels, and isolates two concurrent Codex seats",
  async () => {
    const stateDir = await mkdtemp(
      join(tmpdir(), "codex-delegator-live-concurrent-"),
    );
    const delegate = liveDelegate(stateDir);
    const settings = {
      cwd: process.cwd(),
      mode: "read-only" as const,
      isolation: "current" as const,
      confirmedUnsafe: true,
    };
    const [first, second] = await Promise.all([
      delegate.create({ ...settings, seatId: "codex-live-a" }),
      delegate.create({ ...settings, seatId: "codex-live-b" }),
    ]);
    const concurrent = await Promise.all([
      delegate.turn(first, {
        prompt: "Reply with exactly CODEX_SEAT_A and do not use tools.",
        timeoutMs: 120_000,
      }),
      delegate.turn(second, {
        prompt: "Reply with exactly CODEX_SEAT_B and do not use tools.",
        timeoutMs: 120_000,
      }),
    ]);
    expect(concurrent[0]).toMatchObject({ status: "completed" });
    expect(concurrent[1]).toMatchObject({ status: "completed" });

    const hanging = delegate.turn(first, {
      prompt:
        "Run the shell command sleep 30, wait for it, then reply with SLEEP_FINISHED.",
      timeoutMs: 120_000,
    });
    await waitUntil(
      async () => Boolean((await delegate.inspect(first)).activeTurnId),
      10_000,
    );
    expect(
      await delegate.steer(
        first,
        "Stop waiting and reply with CODEX_STEERED instead.",
      ),
    ).toMatchObject({
      turnId: expect.any(String),
    });
    await delegate.cancel(first);
    expect((await hanging).status).toBe("cancelled");
    await Promise.all([delegate.close(first), delegate.close(second)]);
  },
  300_000,
);

liveScale(
  "holds ten Codex seats while running at most seven concurrent turns",
  async () => {
    const stateDir = await mkdtemp(
      join(tmpdir(), "codex-delegator-live-scale-"),
    );
    const delegate = liveDelegate(stateDir);
    const settings = {
      cwd: process.cwd(),
      mode: "read-only" as const,
      isolation: "current" as const,
      confirmedUnsafe: true,
    };
    const created = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        delegate.create({
          ...settings,
          seatId: `codex-live-scale-${index + 1}`,
        }),
      ),
    );
    const handles = created.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    try {
      expect(handles.length).toBe(10);
      const first = await Promise.all(
        handles.slice(0, 7).map((handle, index) =>
          delegate.turn(handle, {
            prompt: `Reply with exactly CODEX_SCALE_${index + 1} and do not use tools.`,
            timeoutMs: 180_000,
          }),
        ),
      );
      const second = await Promise.all(
        handles.slice(7).map((handle, index) =>
          delegate.turn(handle, {
            prompt: `Reply with exactly CODEX_SCALE_${index + 8} and do not use tools.`,
            timeoutMs: 180_000,
          }),
        ),
      );
      const results = [...first, ...second];
      expect(results.every((result) => result.status === "completed")).toBe(
        true,
      );
      results.forEach((result, index) =>
        expect(result.output).toContain(`CODEX_SCALE_${index + 1}`),
      );
      const transports = await Promise.all(
        handles.map((handle) => delegate.inspect(handle)),
      );
      expect(new Set(transports.map((status) => status.handle.id)).size).toBe(
        10,
      );
      expect(new Set(transports.map((status) => status.threadId)).size).toBe(
        10,
      );
      expect(
        transports.every((status) => status.handle.transport === "app-server"),
      ).toBe(true);
    } finally {
      await Promise.all(handles.map((handle) => delegate.close(handle)));
    }
  },
  300_000,
);

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-delegator-live-git-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "poly@example.invalid"]);
  await git(root, ["config", "user.name", "Codex Delegator Test"]);
  await Bun.write(join(root, "README.md"), "fixture\n");
  await Bun.write(join(root, ".gitignore"), ".contextrelay/\n");
  await git(root, ["add", "README.md", ".gitignore"]);
  await git(root, ["commit", "-qm", "fixture"]);
  return root;
}

function liveDelegate(stateDir: string) {
  return new CodexDelegator({
    stateDir,
    appServerArgv: [
      "codex",
      "app-server",
      "--listen",
      "stdio://",
      "--strict-config",
      "--disable",
      "plugins",
      "--disable",
      "apps",
      "--disable",
      "hooks",
      "-c",
      "mcp_servers={}",
      "-c",
      "mcp_servers.computer-use.enabled=false",
      "-c",
      "mcp_servers.contextrelay.enabled=false",
      "-c",
      "mcp_servers.headless.enabled=false",
      "-c",
      "mcp_servers.jira.enabled=false",
      "-c",
      "mcp_servers.node_repl.enabled=false",
      "-c",
      "mcp_servers.openaiDeveloperDocs.enabled=false",
      "-c",
      'model_reasoning_effort="medium"',
    ],
  });
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

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for live Codex state.");
}
