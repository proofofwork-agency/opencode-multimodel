import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
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
} from "codex-delegator";
import { createCodexDelegatePlugin } from "../src/plugin.ts";
import { createCodexDelegateProvider } from "../src/provider.ts";

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
  readonly closes: Array<DelegateHandle | string> = [];
  closeAllCalls = 0;
  resultStatus: DelegateTurnResult["status"] = "completed";

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
    return result(this.resultStatus);
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
    return inspection(
      typeof handle === "string"
        ? { id: handle, seatId: "codex", transport: "app-server" }
        : handle,
    );
  }

  async close(handle: DelegateHandle | string) {
    this.closes.push(handle);
  }

  async closeAll() {
    this.closeAllCalls += 1;
    return this.creates.length;
  }
}

describe("OpenCode Codex delegate plugin", () => {
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
      "codex_delegate",
      "codex_probe",
      "codex_review",
      "codex_status",
      "codex_steer",
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
        serviceName: "opencode-codex-delegate",
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
    createdAt: 1,
    updatedAt: 2,
  };
}
