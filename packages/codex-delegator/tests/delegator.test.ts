import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexDelegator } from "../src/delegator.ts";
import { codexExecArgv } from "../src/codex-exec.ts";
import { DelegatorError } from "../src/errors.ts";
import type {
  JsonRpcTransportOptions,
  RpcTransport,
  ServerRequest,
} from "../src/json-rpc.ts";

type FakeMode = "complete" | "hang" | "ambiguous" | "rate-limit" | "reject";

class FakeTransport implements RpcTransport {
  readonly id = `fake-${crypto.randomUUID()}`;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly approvalResults: unknown[] = [];
  private listeners = new Set<(message: Record<string, unknown>) => void>();
  private closed = false;
  private turn = 0;

  constructor(private readonly options: JsonRpcTransportOptions) {}

  async request(method: string, params: unknown = {}) {
    if (this.closed) throw new Error("closed");
    this.requests.push({ method, params });
    if (method === "account/read") {
      if (this.options.env?.CODEX_DELEGATOR_TEST_LOGGED_OUT === "1")
        return { account: null, requiresOpenaiAuth: true };
      return {
        account: {
          type: "chatgpt",
          planType: "pro",
          email: "person@example.com",
        },
        requiresOpenaiAuth: true,
      };
    }
    if (method === "model/list")
      return {
        data: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
            ],
            inputModalities: ["text", "image"],
          },
        ],
      };
    if (method === "account/login/start")
      return {
        loginId: "login-1",
        authUrl: "https://example.test/login",
        userCode: "ABCD",
      };
    if (method === "thread/start" || method === "thread/resume")
      return { thread: { id: object(params).threadId ?? `thread-${this.id}` } };
    if (method === "turn/steer")
      return { turnId: object(params).expectedTurnId };
    if (method === "turn/interrupt") return {};
    if (method !== "turn/start" && method !== "review/start") return {};
    const prompt =
      method === "review/start"
        ? "review"
        : String(
            (object(params).input as Array<{ text?: string }> | undefined)?.[0]
              ?.text ?? "",
          );
    const mode: FakeMode = prompt.includes("hang")
      ? "hang"
      : prompt.includes("ambiguous")
        ? "ambiguous"
        : prompt.includes("rate-limit")
          ? "rate-limit"
          : prompt.includes("reject")
            ? "reject"
            : "complete";
    if (mode === "reject")
      throw new DelegatorError("TRANSPORT_ERROR", "HTTP 400 invalid request");
    const turnId = `turn-${++this.turn}`;
    if (prompt.includes("approval") && this.options.onServerRequest) {
      this.approvalResults.push(
        await this.options.onServerRequest({
          id: 9,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread",
            turnId,
            itemId: "command",
            command: "bun test",
            reason: "run tests",
          },
        } satisfies ServerRequest),
      );
    }
    setTimeout(() => {
      this.emit({
        method: "turn/started",
        params: {
          threadId: "thread",
          turn: { id: turnId, status: "inProgress" },
        },
      });
      if (mode === "hang") return;
      if (mode === "ambiguous") {
        this.emit({
          method: "delegate/transportFailure",
          params: { message: "socket lost" },
        });
        return;
      }
      if (mode === "rate-limit") {
        this.emit({
          method: "account/rateLimits/updated",
          params: { rateLimits: { primary: { usedPercent: 100 } } },
        });
      } else if (method === "review/start") {
        this.emit({
          method: "item/completed",
          params: {
            threadId: "review-thread",
            turnId,
            item: {
              id: "review",
              type: "exitedReviewMode",
              review: "No findings.",
            },
          },
        });
        this.emit({
          method: "turn/started",
          params: {
            threadId: "review-thread",
            turn: { id: "nested-review-turn", status: "inProgress" },
          },
        });
        this.emit({
          method: "turn/completed",
          params: {
            threadId: "review-thread",
            turn: { id: "nested-review-turn", status: "completed" },
          },
        });
      } else {
        this.emit({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread",
            turnId,
            itemId: "message",
            delta: "done",
          },
        });
        this.emit({
          method: "item/completed",
          params: {
            threadId: "thread",
            turnId,
            item: { id: "message", type: "agentMessage", text: "done" },
          },
        });
      }
      this.emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread",
          turnId,
          tokenUsage: { inputTokens: 4, outputTokens: 1 },
        },
      });
      this.emit({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: {
            id: turnId,
            status: mode === "rate-limit" ? "failed" : "completed",
          },
        },
      });
    }, 0);
    return method === "review/start"
      ? {
          turn: { id: turnId, status: "inProgress" },
          reviewThreadId: "review-thread",
        }
      : { turn: { id: turnId, status: "inProgress" } };
  }

  subscribe(listener: (message: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close() {
    this.closed = true;
  }

  private emit(message: Record<string, unknown>) {
    this.listeners.forEach((listener) => listener(message));
  }
}

describe("Codex delegator", () => {
  test("probes account/read and reports local capabilities", async () => {
    const fixture = await setup();
    const result = await fixture.delegate.probe({ cwd: fixture.root });
    expect(result).toMatchObject({
      ready: true,
      version: "0.146.0",
      transport: "app-server",
      account: { authenticated: true, authMethod: "chatgpt", planType: "pro" },
      models: [
        { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true },
      ],
      capabilities: {
        resume: true,
        steering: true,
        review: true,
        approvals: true,
        persistentTransport: true,
      },
    });
  });

  test("starts the Codex-managed login flow without implementing OAuth", async () => {
    const fixture = await setup();
    const result = await fixture.delegate.connect({
      cwd: fixture.root,
      env: { CODEX_DELEGATOR_TEST_LOGGED_OUT: "1" },
      loginIfNeeded: true,
    });
    expect(result).toMatchObject({
      ready: false,
      login: {
        type: "chatgpt",
        loginId: "login-1",
        authUrl: "https://example.test/login",
        userCode: "ABCD",
      },
    });
  });

  test("runs persistent turns, maps approval replies, steering, review, and cancellation", async () => {
    const fixture = await setup();
    const handle = await fixture.delegate.create({
      seatId: "codex",
      cwd: fixture.root,
      approval: async () => "always",
    });
    const completed = await fixture.delegate.turn(handle, {
      prompt: "approval please",
      reasoningEffort: "high",
    });
    expect(completed).toMatchObject({
      status: "completed",
      output: "done",
      usage: { inputTokens: 4, outputTokens: 1 },
    });
    expect(fixture.transports[0]?.approvalResults).toEqual([
      { decision: "acceptForSession" },
    ]);
    expect(
      fixture.transports[0]?.requests.find(
        (request) => request.method === "thread/start",
      )?.params,
    ).toMatchObject({ serviceName: "codex-delegator" });
    expect(
      fixture.transports[0]?.requests.find(
        (request) => request.method === "turn/start",
      )?.params,
    ).toMatchObject({ effort: "high" });
    const sourceThread = (await fixture.delegate.inspect(handle)).threadId;
    const review = await fixture.delegate.review(handle, {
      target: { type: "uncommittedChanges" },
    });
    expect(review).toMatchObject({
      status: "completed",
      output: "No findings.",
      threadId: "review-thread",
      turnId: "turn-2",
    });
    expect((await fixture.delegate.inspect(handle)).threadId).toBe(
      sourceThread,
    );
    await fixture.delegate.review(handle, {
      delivery: "detached",
      target: { type: "baseBranch", branch: "dev" },
    });
    expect((await fixture.delegate.inspect(handle)).threadId).toBe(
      "review-thread",
    );

    const hanging = fixture.delegate.turn(handle, "hang");
    await Bun.sleep(10);
    const activeTurnId = (await fixture.delegate.inspect(handle)).activeTurnId;
    expect(
      await fixture.delegate.steer(handle, "focus on tests"),
    ).toMatchObject({ turnId: activeTurnId });
    await fixture.delegate.cancel(handle);
    expect(await hanging).toMatchObject({ status: "cancelled" });
    expect((await fixture.delegate.inspect(handle)).status).toBe("idle");
  });

  test("does not replay permanent errors or ambiguous accepted turns", async () => {
    const fixture = await setup();
    const handle = await fixture.delegate.create({ cwd: fixture.root });
    expect(await fixture.delegate.turn(handle, "reject request")).toMatchObject(
      {
        status: "failed",
        error: { code: "TRANSPORT_ERROR" },
      },
    );
    expect(
      await fixture.delegate.turn(handle, "ambiguous write"),
    ).toMatchObject({
      status: "ambiguous",
      error: { code: "AMBIGUOUS_DELIVERY" },
    });
    expect((await fixture.delegate.inspect(handle)).status).toBe("ambiguous");
  });

  test("surfaces rate limits and supports concurrent Codex seats", async () => {
    const fixture = await setup();
    const first = await fixture.delegate.create({
      seatId: "codex",
      cwd: fixture.root,
    });
    const second = await fixture.delegate.create({
      seatId: "codex-2",
      cwd: fixture.root,
    });
    const [limited, completed] = await Promise.all([
      fixture.delegate.turn(first, "rate-limit"),
      fixture.delegate.turn(second, "ordinary"),
    ]);
    expect(limited).toMatchObject({
      status: "rate-limited",
      error: { code: "RATE_LIMITED", retryable: true },
    });
    expect(completed).toMatchObject({ status: "completed", output: "done" });
    expect(fixture.transports).toHaveLength(2);
  });

  test("persists native thread attachments and resumes after restart", async () => {
    const fixture = await setup();
    const handle = await fixture.delegate.create({
      seatId: "codex",
      cwd: fixture.root,
    });
    const threadId = (await fixture.delegate.inspect(handle)).threadId;
    await fixture.delegate.close(handle);
    const restarted = fixture.makeDelegate();
    const resumed = await restarted.resume({
      seatId: "codex",
      cwd: fixture.root,
    });
    expect((await restarted.inspect(resumed)).threadId).toBe(threadId);
  });

  test("requires confirmation for current checkout and bypass modes", async () => {
    const fixture = await setup();
    await expect(
      fixture.delegate.create({ cwd: fixture.root, isolation: "current" }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      fixture.delegate.create({ cwd: fixture.root, approvalPolicy: "bypass" }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    const handle = await fixture.delegate.create({
      cwd: fixture.root,
      isolation: "current",
      confirmedUnsafe: true,
    });
    expect((await fixture.delegate.inspect(handle)).isolation).toBe("current");
  });

  test("keeps read-only sessions sandboxed even when bypass was explicitly confirmed", async () => {
    const fixture = await setup();
    await fixture.delegate.create({
      cwd: fixture.root,
      mode: "read-only",
      approvalPolicy: "bypass",
      confirmedUnsafe: true,
    });
    expect(
      fixture.transports[0]?.requests.find(
        (request) => request.method === "thread/start",
      )?.params,
    ).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const argv = codexExecArgv({
      cwd: fixture.root,
      model: null,
      reasoningEffort: "high",
      mode: "read-only",
      approvalPolicy: "bypass",
      nativeThreadId: null,
    });
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).toContain("read-only");
    expect(argv).toContain('approval_policy="never"');
    expect(argv).toContain('model_reasoning_effort="high"');
    expect(
      codexExecArgv({
        cwd: fixture.root,
        model: null,
        mode: "write",
        approvalPolicy: "ask",
        nativeThreadId: null,
      }),
    ).toContain('approval_policy="never"');
  });

  test("uses exec JSON fallback without advertising unsupported capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-delegator-exec-"));
    const result = {
      id: crypto.randomUUID(),
      status: "completed" as const,
      output: "fallback",
      events: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: 2,
      },
      threadId: "exec-thread",
      turnId: "exec-turn",
      startedAt: 1,
      completedAt: 2,
      malformedEvents: 0,
      truncated: false,
      error: null,
    };
    const delegate = new CodexDelegator({
      stateDir: join(root, "state"),
      openTransport: async () => {
        throw new Error("no app-server");
      },
      ensureWorktree: async () => ({ sourceRoot: root, worktree: root }),
      runCommand: async (input) =>
        commandResult(
          input.argv.includes("--help")
            ? "--json"
            : input.argv.includes("status")
              ? "Logged in with ChatGPT"
              : "codex-cli 0.146.0",
        ),
      runExec: async () => result,
    });
    const handle = await delegate.create({ cwd: root });
    expect(handle.transport).toBe("exec");
    expect((await delegate.inspect(handle)).capabilities).toMatchObject({
      steering: false,
      review: false,
      approvals: false,
      persistentTransport: false,
    });
    expect(await delegate.turn(handle, "fallback")).toEqual(result);
    await expect(delegate.steer(handle, "nope")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
  });

  test("cancels an active exec fallback turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-delegator-exec-cancel-"));
    let started: () => void = () => {};
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const delegate = new CodexDelegator({
      stateDir: join(root, "state"),
      openTransport: async () => {
        throw new Error("no app-server");
      },
      ensureWorktree: async () => ({ sourceRoot: root, worktree: root }),
      runCommand: async (input) =>
        commandResult(
          input.argv.includes("--help")
            ? "--json"
            : input.argv.includes("status")
              ? "Logged in with ChatGPT"
              : "codex-cli 0.146.0",
        ),
      runExec: async (input) => {
        started();
        return new Promise((resolve) =>
          input.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                id: crypto.randomUUID(),
                status: "cancelled" as const,
                output: "",
                events: [],
                usage: {
                  inputTokens: null,
                  outputTokens: null,
                  cachedInputTokens: null,
                  reasoningTokens: null,
                  totalTokens: null,
                },
                threadId: null,
                turnId: null,
                startedAt: 1,
                completedAt: 2,
                malformedEvents: 0,
                truncated: false,
                error: null,
              }),
            { once: true },
          ),
        );
      },
    });
    const handle = await delegate.create({ cwd: root });
    const turn = delegate.turn(handle, "wait");
    await active;
    await delegate.cancel(handle);
    expect(await turn).toMatchObject({ status: "cancelled" });
    expect((await delegate.inspect(handle)).status).toBe("idle");
  });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "codex-delegator-"));
  const transports: FakeTransport[] = [];
  const makeDelegate = () =>
    new CodexDelegator({
      stateDir: join(root, "state"),
      openTransport: async (options) => {
        const transport = new FakeTransport(options);
        transports.push(transport);
        return transport;
      },
      ensureWorktree: async () => ({ sourceRoot: root, worktree: root }),
      runCommand: async () => commandResult("codex-cli 0.146.0"),
    });
  return { root, transports, makeDelegate, delegate: makeDelegate() };
}

function commandResult(stdout: string) {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    cancelled: false,
    timedOut: false,
    overflowed: false,
  };
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
