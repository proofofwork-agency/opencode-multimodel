import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JSONObject,
  LanguageModelV3CallOptions,
} from "@ai-sdk/provider";
import type { Config, PluginInput, ToolContext } from "@opencode-ai/plugin";
import {
  DelegatorError,
  type ConnectInput,
  type CreateInput,
  type DelegateHandle,
  type DelegateInspection,
  type DelegateProbe,
  type DelegateTurnResult,
  type ResumeInput,
  type ReviewInput,
  type SteerInput,
  type TurnInput,
  type CloseInput,
  type DelegateAccountUsage,
} from "codex-delegator";
import { createCodexDelegatePlugin } from "../src/plugin.ts";
import { createCodexDelegateProvider } from "../src/provider.ts";
import { CodexProviderRuntime } from "../src/provider-runtime.ts";
import serverModule from "../src/server.ts";
import tuiModule from "../src/tui.ts";

class FakeDelegate {
  readonly creates: CreateInput[] = [];
  readonly resumes: ResumeInput[] = [];
  readonly turns: Array<{
    handle: DelegateHandle | string;
    input: TurnInput | string;
  }> = [];
  readonly reviews: Array<{
    handle: DelegateHandle | string;
    input?: ReviewInput;
  }> = [];
  readonly closes: Array<{
    handle: DelegateHandle | string;
    cleanup?: boolean;
  }> = [];
  closeAllCalls = 0;
  resultStatus: DelegateTurnResult["status"] = "completed";
  turnResult: DelegateTurnResult | null = null;
  inspectionLastTurn: DelegateTurnResult | null = null;

  async probe(_input?: ConnectInput): Promise<DelegateProbe> {
    return {
      ready: true,
      executable: "codex",
      version: "0.146.0",
      transport: "app-server",
      capabilities: {
        resume: true,
        steering: true,
        review: true,
        approvals: true,
        structuredEvents: true,
        persistentTransport: true,
        writes: true,
        cancellation: true,
      },
      account: {
        authenticated: true,
        authMethod: "chatgpt",
        planType: "pro",
        email: null,
        requiresOpenaiAuth: true,
      },
      models: [
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium", "high"],
          inputModalities: ["text", "image"],
        },
      ],
      reason: null,
      evidence: [],
    };
  }

  async resume(input: ResumeInput): Promise<DelegateHandle> {
    this.resumes.push(input);
    throw new DelegatorError("INVALID_REQUEST", "no stored seat");
  }

  async create(input: CreateInput): Promise<DelegateHandle> {
    this.creates.push(input);
    return {
      id: `delegate-${this.creates.length}`,
      seatId: input.seatId ?? "codex",
      transport: "app-server",
    };
  }

  async turn(handle: DelegateHandle | string, input: TurnInput | string) {
    this.turns.push({ handle, input });
    if (typeof input !== "string") {
      input.onEvent?.({
        sequence: 0,
        kind: "reasoning",
        method: "item/reasoning/summaryTextDelta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        text: "thinking",
        usage: null,
      });
      input.onEvent?.({
        sequence: 1,
        kind: "text",
        method: "item/agentMessage/delta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        text: "done",
        usage: null,
      });
    }
    return this.turnResult ?? result(this.resultStatus);
  }

  async review(handle: DelegateHandle | string, input?: ReviewInput) {
    this.reviews.push({ handle, input });
    return result(this.resultStatus);
  }

  async steer(_handle: DelegateHandle | string, _input: SteerInput | string) {
    return { turnId: "turn-active" };
  }

  async cancel(handle: DelegateHandle | string) {
    return inspection(
      typeof handle === "string"
        ? { id: handle, seatId: "codex", transport: "app-server" }
        : handle,
    );
  }

  async inspect(handle: DelegateHandle | string) {
    return {
      ...inspection(
        typeof handle === "string"
          ? { id: handle, seatId: "codex", transport: "app-server" }
          : handle,
      ),
      lastTurn: this.inspectionLastTurn,
    };
  }

  async usage(_handle: DelegateHandle | string): Promise<DelegateAccountUsage> {
    return {
      lifetimeTokens: 1_234_567,
      peakDailyTokens: 45_678,
      longestRunningTurnSec: 540,
      currentStreakDays: 8,
      longestStreakDays: 14,
      dailyUsageBuckets: [{ startDate: "2026-06-18", tokens: 12_345 }],
      primaryUsedPercent: 40,
      primaryResetsAt: 1_700_000_000,
      secondaryUsedPercent: 10,
      secondaryResetsAt: 1_700_001_000,
    };
  }

  async close(handle: DelegateHandle | string, input?: CloseInput) {
    this.closes.push({ handle, cleanup: input?.cleanup });
  }

  async closeAll() {
    this.closeAllCalls += 1;
    return this.creates.length;
  }
}

describe("OpenCode Codex delegate plugin", () => {
  test("publishes separate OpenCode server and TUI modules", () => {
    expect(serverModule.id).toBe("opencode-codex-delegate");
    expect(typeof serverModule.server).toBe("function");
    expect("tui" in serverModule).toBe(false);
    expect(tuiModule.id).toBe("opencode-codex-delegate");
    expect(typeof tuiModule.tui).toBe("function");
    expect("server" in tuiModule).toBe(false);
  });

  test("prefixes Codex delegate turns with the parent OpenCode goal", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-codex-delegate-"));
    await mkdir(join(root, ".opencode", "goals"), { recursive: true });
    await writeFile(
      join(root, ".opencode", "goals", "session-a.json"),
      JSON.stringify({
        version: 1,
        sessionID: "session-a",
        objective: "all tests pass",
        status: "active",
      }),
    );
    const delegate = new FakeDelegate();
    const plugin = createCodexDelegatePlugin({
      createDelegator() {
        return delegate;
      },
    });
    const hooks = await plugin(pluginInput(root), { stateDir: ".state" });
    await hooks.tool!.codex_delegate!.execute(
      { prompt: "implement the failing test" },
      toolContext(root, "session-a", []),
    );
    const prompt = typeof delegate.turns[0]?.input === "string"
      ? delegate.turns[0]?.input
      : delegate.turns[0]?.input.prompt;
    expect(prompt).toContain("all tests pass");
    expect(prompt).toContain("Do not invoke Codex CLI /goal");
    expect(prompt).toContain("implement the failing test");
  });

  test("keeps the main entrypoint limited to one deduplicated plugin function", async () => {
    const entrypoint = await import("../src/index.ts");
    expect(
      Object.values(entrypoint).every((value) => typeof value === "function"),
    ).toBe(true);
    expect(new Set(Object.values(entrypoint))).toEqual(
      new Set([entrypoint.default]),
    );
  });

  test("exposes tools, scopes seats by OpenCode session, and bridges approvals", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-codex-delegate-"));
    const delegate = new FakeDelegate();
    const options: unknown[] = [];
    const plugin = createCodexDelegatePlugin({
      createDelegator(input) {
        options.push(input);
        return delegate;
      },
    });
    const hooks = await plugin(pluginInput(root), {
      mode: "read-only",
      stateDir: ".state",
    });
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "codex_cancel",
      "codex_close",
      "codex_delegate",
      "codex_probe",
      "codex_review",
      "codex_status",
      "codex_steer",
      "codex_usage",
    ]);

    const asks: unknown[] = [];
    const contextA = toolContext(root, "session-a", asks);
    const first = await hooks.tool!.codex_delegate!.execute(
      { prompt: "inspect the parser" },
      contextA,
    );
    await hooks.tool!.codex_delegate!.execute(
      { prompt: "now add a test" },
      contextA,
    );
    await hooks.tool!.codex_delegate!.execute(
      { prompt: "independent session" },
      toolContext(root, "session-b", asks),
    );

    expect(options).toEqual([
      {
        executable: undefined,
        stateDir: join(root, ".state"),
        serviceName: "codex_opencode",
      },
    ]);
    expect(first).toMatchObject({
      title: "Codex delegate · codex",
      output: "done",
      metadata: {
        seatId: "codex",
        transport: "app-server",
        status: "completed",
      },
    });
    expect(delegate.resumes.map((input) => input.sessionID)).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(
      delegate.creates.map((input) => ({
        sessionID: input.sessionID,
        mode: input.mode,
      })),
    ).toEqual([
      { sessionID: "session-a", mode: "read-only" },
      { sessionID: "session-b", mode: "read-only" },
    ]);
    expect(delegate.turns).toHaveLength(3);

    const approval = delegate.creates[0]!.approval;
    expect(
      await approval!({
        id: 1,
        method: "item/commandExecution/requestApproval",
        threadId: "thread",
        turnId: "turn",
        itemId: "command",
        permission: "command",
        patterns: ["bun test"],
        reason: "run tests",
        metadata: {},
      }),
    ).toBe("once");
    expect(asks.slice(0, 3)).toEqual([
      {
        permission: "codex_delegate",
        patterns: ["codex"],
        always: ["codex"],
        metadata: { seatId: "codex", mode: "read-only" },
      },
      {
        permission: "codex_delegate",
        patterns: ["codex"],
        always: ["codex"],
        metadata: { seatId: "codex", mode: "read-only" },
      },
      {
        permission: "codex_delegate",
        patterns: ["codex"],
        always: ["codex"],
        metadata: { seatId: "codex", mode: "read-only" },
      },
    ]);
    expect(asks.at(-1)).toEqual({
      permission: "codex_command",
      patterns: ["bun test"],
      always: ["bun test"],
      metadata: {
        method: "item/commandExecution/requestApproval",
        reason: "run tests",
      },
    });

    await hooks.dispose!();
    expect(delegate.closeAllCalls).toBe(1);
  });

  test("maps native review targets and reconfigures the review seat read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-codex-review-"));
    const delegate = new FakeDelegate();
    const hooks = await createCodexDelegatePlugin({
      createDelegator: () => delegate,
    })(pluginInput(root));
    const output = await hooks.tool!.codex_review!.execute(
      { scope: "base", value: "dev", seatId: "reviewer" },
      toolContext(root, "session-a", []),
    );

    expect(delegate.creates[0]).toMatchObject({
      sessionID: "session-a",
      seatId: "reviewer",
      mode: "read-only",
      isolation: "worktree",
      approvalPolicy: "ask",
    });
    expect(delegate.reviews[0]?.input).toMatchObject({
      target: { type: "baseBranch", branch: "dev" },
      delivery: "inline",
    });
    expect(output).toMatchObject({
      title: "Codex review · reviewer",
      output: "done",
    });
    await hooks.dispose!();
  });

  test("reviews uncommitted changes in the current checkout and reuses a writer seat", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-codex-review-tree-"));
    const delegate = new FakeDelegate();
    const hooks = await createCodexDelegatePlugin({
      createDelegator: () => delegate,
    })(pluginInput(root));
    const context = toolContext(root, "session-a", []);
    await hooks.tool!.codex_delegate!.execute(
      { prompt: "write a test", seatId: "codex" },
      context,
    );
    await hooks.tool!.codex_review!.execute(
      { scope: "uncommitted", seatId: "codex" },
      context,
    );
    expect(delegate.creates).toHaveLength(1);
    expect(delegate.closes).toHaveLength(0);
    expect(delegate.reviews[0]?.input).toMatchObject({
      target: { type: "uncommittedChanges" },
    });

    await hooks.tool!.codex_review!.execute(
      { scope: "uncommitted" },
      context,
    );
    expect(delegate.creates[1]).toMatchObject({
      seatId: "codex-review",
      mode: "read-only",
      isolation: "current",
    });
    await hooks.dispose!();
  });

  test("reads usage and closes a seat with optional cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-codex-usage-"));
    const delegate = new FakeDelegate();
    const noisyTurn = {
      ...result("completed"),
      output: "large prior output",
      events: [
        {
          sequence: 0,
          kind: "text" as const,
          method: "item/agentMessage/delta",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-1",
          text: "event payload that status must omit",
          usage: null,
        },
      ],
      changes: {
        cwd: root,
        files: ["src/index.ts"],
        summary: "1 changed file",
        patch: "patch payload that status and metadata must omit",
        truncated: true,
      },
    } satisfies DelegateTurnResult;
    delegate.turnResult = noisyTurn;
    delegate.inspectionLastTurn = noisyTurn;
    const hooks = await createCodexDelegatePlugin({
      createDelegator: () => delegate,
    })(pluginInput(root));
    const context = toolContext(root, "session-a", []);
    const turn = await hooks.tool!.codex_delegate!.execute(
      { prompt: "write a test" },
      context,
    );
    if (typeof turn === "string") throw new Error("Expected structured turn output");
    expect(turn.metadata?.changes).toEqual({
      cwd: root,
      summary: "1 changed file",
      files: ["src/index.ts"],
      fileCount: 1,
      filesTruncated: false,
      patchTruncated: true,
    });
    expect(JSON.stringify(turn.metadata)).not.toContain("patch payload");
    const usage = await hooks.tool!.codex_usage!.execute({}, context);
    expect(usage).toMatchObject({
      title: "Codex usage · codex",
      metadata: { lifetimeTokens: 1_234_567, primaryUsedPercent: 40 },
    });
    const status = await hooks.tool!.codex_status!.execute({}, context);
    if (typeof status === "string")
      throw new Error("Expected structured status output");
    expect(status).toMatchObject({
      metadata: { activeKind: null, isolation: "current" },
    });
    expect(status.output).not.toContain("large prior output");
    expect(status.output).not.toContain("event payload");
    expect(status.output).not.toContain("patch payload");
    expect(JSON.parse(status.output).lastTurn).toMatchObject({
      status: "completed",
      changes: {
        files: ["src/index.ts"],
        fileCount: 1,
        patchTruncated: true,
      },
    });
    await hooks.tool!.codex_close!.execute({ cleanup: false }, context);
    expect(delegate.closes.at(-1)).toMatchObject({ cleanup: false });
    await hooks.dispose!();
  });

  test("evicts a closed provider seat so the next provider run opens a fresh handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-codex-provider-close-"));
    const delegate = new FakeDelegate();
    const runtime = new CodexProviderRuntime({
      directory: root,
      defaults: {
        mode: "write",
        isolation: "worktree",
        approvalPolicy: "ask",
        timeoutMs: 30_000,
        confirmedUnsafe: false,
      },
      delegate,
    });
    const input = {
      sessionID: "session-provider-close",
      agent: "build",
      model: "gpt-5.6-sol",
      fullPrompt: "Implement the parser.",
      latestPrompt: "Implement the parser.",
    };
    await runtime.run(input);
    const handle = await runtime.resolveHandle(input.sessionID, input.agent);
    expect(handle).not.toBeNull();
    expect(
      await runtime.closeHandle(input.sessionID, handle!, { cleanup: true }),
    ).toBe(true);

    await runtime.run({
      ...input,
      messageID: "message-2",
      latestPrompt: "Now add tests.",
    });
    expect(delegate.creates).toHaveLength(2);
    expect(delegate.turns.at(-1)?.handle).toMatchObject({ id: "delegate-2" });
    await runtime.dispose();
  });

  test("surfaces ambiguous delivery as a failed tool invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-codex-ambiguous-"));
    const delegate = new FakeDelegate();
    delegate.resultStatus = "ambiguous";
    const hooks = await createCodexDelegatePlugin({
      createDelegator: () => delegate,
    })(pluginInput(root));

    await expect(
      hooks.tool!.codex_delegate!.execute(
        { prompt: "write the change" },
        toolContext(root, "session-a", []),
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_DELIVERY" });
    await hooks.dispose!();
  });

  test("registers a selectable provider and streams through the shared Codex runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-codex-provider-"));
    const delegate = new FakeDelegate();
    const hooks = await createCodexDelegatePlugin({
      createDelegator: () => delegate,
    })(pluginInput(root), { tools: false });
    const config: Config = {};
    await hooks.config!(config);

    expect(hooks.tool).toBeUndefined();
    expect(config.provider?.["codex-delegate"]).toMatchObject({
      name: "Codex CLI Delegate",
      options: {
        directory: root,
        stateDir: join(root, ".codex-delegate"),
        mode: "write",
        isolation: "worktree",
        approvalPolicy: "ask",
      },
      models: {
        "gpt-5.6-sol": {
          name: "GPT-5.6 Sol",
          reasoning: true,
          tool_call: false,
          modalities: { input: ["text"], output: ["text"] },
          options: { reasoningEffort: "medium" },
        },
      },
    });
    expect(
      config.provider?.["codex-delegate"]?.npm?.endsWith("/provider.ts"),
    ).toBe(true);

    const params: {
      temperature: number;
      topP: number;
      topK: number;
      maxOutputTokens: number | undefined;
      options: JSONObject;
    } = {
      temperature: 1,
      topP: 1,
      topK: 1,
      maxOutputTokens: 1,
      options: { reasoningEffort: "high" },
    };
    await hooks["chat.params"]!(
      {
        sessionID: "session-provider",
        agent: "build",
        model: { providerID: "codex-delegate" },
        message: { id: "message-provider" },
      } as Parameters<NonNullable<typeof hooks["chat.params"]>>[0],
      params,
    );
    expect(params).toEqual({
      temperature: 1,
      topP: 1,
      topK: 1,
      maxOutputTokens: undefined,
      options: {
        reasoningEffort: "high",
        sessionID: "session-provider",
        messageID: "message-provider",
        agent: "build",
      },
    });

    const runtimeKey = config.provider?.["codex-delegate"]?.options?.runtimeKey;
    expect(typeof runtimeKey).toBe("string");
    const model = createCodexDelegateProvider({
      name: "codex-delegate",
      runtimeKey: String(runtimeKey),
    }).languageModel("gpt-5.6-sol");
    const call = {
      prompt: [
        { role: "system", content: "Follow the project instructions." },
        {
          role: "user",
          content: [{ type: "text", text: "Implement the parser." }],
        },
      ],
      providerOptions: { "codex-delegate": params.options },
    } satisfies LanguageModelV3CallOptions;
    const response = await model.doStream(call);
    const parts = [];
    for await (const part of response.stream) parts.push(part);

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "response-metadata",
      "reasoning-start",
      "reasoning-delta",
      "text-start",
      "text-delta",
      "reasoning-end",
      "text-end",
      "finish",
    ]);
    expect(delegate.creates[0]).toMatchObject({
      sessionID: "session-provider",
      seatId: "provider-build",
      model: "gpt-5.6-sol",
      cwd: root,
      isolation: "worktree",
    });
    expect(delegate.turns[0]?.input).toMatchObject({
      prompt:
        "System:\nFollow the project instructions.\n\nUser:\nImplement the parser.",
      reasoningEffort: "high",
    });
    await model.doGenerate(call);
    expect(delegate.turns).toHaveLength(1);

    await model.doGenerate({
      ...call,
      providerOptions: {
        "codex-delegate": {
          ...params.options,
          messageID: "message-provider-2",
        },
      },
      prompt: [
        ...call.prompt,
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        {
          role: "user",
          content: [{ type: "text", text: "Now add tests." }],
        },
      ],
    });
    expect(delegate.turns[1]?.input).toMatchObject({
      prompt: "User:\nNow add tests.",
    });
    expect(delegate.creates).toHaveLength(1);

    await hooks.dispose!();
    expect(delegate.closeAllCalls).toBe(1);
  });

  test("throws Codex usage-limit failures instead of returning empty text", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-delegate-limit-"));
    const delegate = new FakeDelegate();
    delegate.turnResult = {
      ...result("failed"),
      error: {
        code: "TURN_FAILED",
        message:
          "You've hit your usage limit. Try again at Aug 20th, 2026 5:28 AM.",
        retryable: false,
      },
    };
    const runtime = new CodexProviderRuntime({
      directory: root,
      defaults: {
        mode: "write",
        isolation: "worktree",
        approvalPolicy: "ask",
        timeoutMs: 1000,
        confirmedUnsafe: false,
      },
      delegate,
    });
    const model = createCodexDelegateProvider({
      name: "codex-delegate",
      runtime,
    }).languageModel("gpt-5.6-terra");
    const call = {
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Implement the parser." }],
        },
      ],
    } satisfies LanguageModelV3CallOptions;
    await expect(model.doGenerate(call)).rejects.toThrow("usage limit");
    const streamed = await model.doStream(call);
    const parts = [];
    for await (const part of streamed.stream) parts.push(part);
    expect(parts.some((part) => part.type === "error")).toBe(true);
  });
});

function pluginInput(directory: string) {
  return { directory, worktree: directory } as unknown as PluginInput;
}

function toolContext(directory: string, sessionID: string, asks: unknown[]) {
  return {
    sessionID,
    messageID: "message-1",
    agent: "lead",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    async ask(input: unknown) {
      asks.push(input);
    },
  } as unknown as ToolContext;
}

function result(status: DelegateTurnResult["status"]): DelegateTurnResult {
  return {
    id: "result-1",
    status,
    output: status === "completed" ? "done" : "",
    events: [],
    usage: {
      inputTokens: 4,
      outputTokens: 1,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: 5,
    },
    threadId: "thread-1",
    turnId: "turn-1",
    startedAt: 1,
    completedAt: 2,
    malformedEvents: 0,
    truncated: false,
    changes: null,
    error:
      status === "completed"
        ? null
        : {
            code:
              status === "ambiguous" ? "AMBIGUOUS_DELIVERY" : "TRANSPORT_ERROR",
            message: status,
            retryable: false,
          },
  };
}

function inspection(handle: DelegateHandle): DelegateInspection {
  return {
    handle,
    status: "idle",
    cwd: "/project",
    sourceCwd: "/project",
    worktree: null,
    isolation: "current",
    approvalPolicy: "ask",
    mode: "read-only",
    model: null,
    threadId: "thread-1",
    activeTurnId: null,
    capabilities: {
      resume: true,
      steering: true,
      review: true,
      approvals: true,
      structuredEvents: true,
      persistentTransport: true,
      writes: true,
      cancellation: true,
    },
    lastTurn: null,
    activeKind: null,
    createdAt: 1,
    updatedAt: 2,
  };
}
