import { isAbsolute, resolve } from "node:path";
import {
  tool,
  type Config,
  type Plugin,
  type PluginInput,
  type PluginOptions,
  type ToolContext,
} from "@opencode-ai/plugin";
import {
  CodexDelegator,
  DelegatorError,
  type CodexDelegatorOptions,
  type DelegateApprovalPolicy,
  type DelegateHandle,
  type DelegateInspection,
  type DelegateIsolation,
  type DelegateMode,
  type DelegateProbe,
  type DelegateTurnResult,
  type DelegateModel,
  type DelegateAccountUsage,
  type ReviewTarget,
} from "codex-delegator";
import {
  CodexProviderRuntime,
  installProviderRuntime,
  uninstallProviderRuntime,
  type DelegateClient,
  type ProviderDefaults,
} from "./provider-runtime.js";

type Defaults = ProviderDefaults & {
  model: string | undefined;
};

type Seat = {
  configuration: string;
  handle: DelegateHandle;
};

const MAX_REPORTED_CHANGE_FILES = 100;

export type CodexDelegatePluginOptions = PluginOptions & {
  executable?: string;
  stateDir?: string;
  model?: string;
  mode?: DelegateMode;
  isolation?: DelegateIsolation;
  approvalPolicy?: DelegateApprovalPolicy;
  timeoutMs?: number;
  confirmedUnsafe?: boolean;
  provider?: boolean;
  tools?: boolean;
  providerId?: string;
  providerName?: string;
  providerModels?: string[];
  providerProbeTimeoutMs?: number;
  contextWindow?: number;
  outputTokens?: number;
};

export type CodexDelegatePluginFactoryOptions = {
  createDelegator?: (options: CodexDelegatorOptions) => DelegateClient;
};

export function createCodexDelegatePlugin(
  factory: CodexDelegatePluginFactoryOptions = {},
): Plugin {
  return async (input, rawOptions) => {
    const options = parseOptions(input, rawOptions);
    const delegate = (
      factory.createDelegator ?? ((value) => new CodexDelegator(value))
    )({
      executable: options.executable,
      stateDir: options.stateDir,
      serviceName: "codex_opencode",
    });
    const seats = new Map<string, Seat>();
    const attaching = new Map<string, Promise<Seat>>();
    const providerRuntime = new CodexProviderRuntime({
      directory: input.directory,
      executable: options.executable,
      stateDir: options.stateDir,
      defaults: options.defaults,
      delegate,
    });
    const providerRuntimeKey = installProviderRuntime(providerRuntime);

    const attach = async (
      args: {
        seatId?: string;
        model?: string;
        mode?: DelegateMode;
        isolation?: DelegateIsolation;
        approvalPolicy?: DelegateApprovalPolicy;
        timeoutMs?: number;
        confirmedUnsafe?: boolean;
      },
      context: ToolContext,
    ) => {
      const seatId = safeSeat(args.seatId);
      const key = seatKey(context.sessionID, seatId);
      const configuration = seatConfiguration(
        args,
        options.defaults,
        context.directory,
      );
      const pending = attaching.get(key);
      if (pending) {
        await pending;
        return attach(args, context);
      }
      const current = seats.get(key);
      if (current?.configuration === configuration) return current;
      seats.delete(key);
      const opening = openSeat(
        delegate,
        current,
        seatId,
        args,
        options.defaults,
        context,
      )
        .then((handle) => ({ configuration, handle }))
        .then((seat) => {
          seats.set(key, seat);
          return seat;
        })
        .finally(() => {
          if (attaching.get(key) === opening) attaching.delete(key);
        });
      attaching.set(key, opening);
      return opening;
    };

    return {
      async config(config) {
        if (!options.provider.enabled) return;
        const probe = await delegate
          .probe({
            cwd: input.directory,
            timeoutMs: options.provider.probeTimeoutMs,
          })
          .catch(() => null);
        registerProvider(
          config,
          options,
          probe?.models ?? [],
          providerRuntimeKey,
        );
      },
      async "chat.params"(request, output) {
        if (request.model.providerID !== options.provider.id) return;
        output.maxOutputTokens = undefined;
        output.options.sessionID = request.sessionID;
        output.options.messageID = request.message.id;
        output.options.agent = request.agent;
      },
      async event(event) {
        if (event.event.type !== "session.deleted") return;
        const sessionID = event.event.properties.info.id;
        await Promise.allSettled(
          [...attaching.entries()]
            .filter(([key]) => key.startsWith(`${sessionID}\0`))
            .map(([, pending]) => pending),
        );
        const matching = [...seats.entries()].filter(([key]) =>
          key.startsWith(`${sessionID}\0`),
        );
        matching.forEach(([key]) => seats.delete(key));
        await Promise.allSettled([
          ...matching.map(([, seat]) =>
            delegate.close(seat.handle, { cleanup: false }),
          ),
          providerRuntime.closeSession(sessionID),
        ]);
      },
      async dispose() {
        await Promise.allSettled(attaching.values());
        seats.clear();
        attaching.clear();
        uninstallProviderRuntime(providerRuntimeKey, providerRuntime);
        await providerRuntime.dispose();
        await delegate.closeAll();
      },
      tool: options.tools
        ? {
        codex_delegate: tool({
          description:
            "Delegate a bounded task to the local OpenAI Codex CLI. The delegate keeps a persistent thread per OpenCode session and seat, uses an isolated git worktree by default, and can edit files when mode is write.",
          args: {
            prompt: tool.schema
              .string()
              .min(1)
              .describe("Concrete task for the Codex delegate"),
            seatId: tool.schema
              .string()
              .optional()
              .describe("Persistent delegate seat name; defaults to codex"),
            model: tool.schema
              .string()
              .optional()
              .describe("Codex model override, for example gpt-5.6-sol"),
            mode: tool.schema
              .enum(["read-only", "write"])
              .optional()
              .describe("Filesystem mode; defaults to write"),
            isolation: tool.schema
              .enum(["worktree", "current"])
              .optional()
              .describe(
                "Use a managed detached worktree or the current checkout; defaults to worktree",
              ),
            approvalPolicy: tool.schema
              .enum(["ask", "auto", "bypass"])
              .optional()
              .describe("Codex escalation policy; defaults to ask"),
            timeoutMs: tool.schema
              .number()
              .int()
              .min(100)
              .max(3_600_000)
              .optional(),
            confirmedUnsafe: tool.schema
              .boolean()
              .optional()
              .describe(
                "Required for current-checkout isolation or bypass approval",
              ),
          },
          async execute(args, context) {
            const seatId = safeSeat(args.seatId);
            await context.ask({
              permission: "codex_delegate",
              patterns: [seatId],
              always: [seatId],
              metadata: { seatId, mode: args.mode ?? options.defaults.mode },
            });
            const seat = await attach(args, context);
            const result = requireCompleted(
              await delegate.turn(seat.handle, {
                prompt: args.prompt,
                timeoutMs: args.timeoutMs ?? options.defaults.timeoutMs,
                signal: context.abort,
              }),
              "turn",
            );
            return turnOutput("Codex delegate", seat.handle, result);
          },
        }),
        codex_review: tool({
          description:
            "Run Codex CLI's native read-only review. Uncommitted reviews use the current checkout so Codex sees dirty files. Pass the writer seatId to review that seat's worktree without reopening it.",
          args: {
            scope: tool.schema
              .enum(["uncommitted", "base", "commit", "custom"])
              .optional()
              .describe("Review target; defaults to uncommitted"),
            value: tool.schema
              .string()
              .optional()
              .describe(
                "Branch for base, SHA for commit, or instructions for custom",
              ),
            title: tool.schema
              .string()
              .optional()
              .describe("Optional commit title"),
            delivery: tool.schema
              .enum(["inline", "detached"])
              .optional()
              .describe("Defaults to inline"),
            seatId: tool.schema
              .string()
              .optional()
              .describe(
                "Persistent delegate seat name; defaults to codex-review",
              ),
            model: tool.schema
              .string()
              .optional()
              .describe("Codex model override"),
            isolation: tool.schema.enum(["worktree", "current"]).optional(),
            timeoutMs: tool.schema
              .number()
              .int()
              .min(100)
              .max(3_600_000)
              .optional(),
            confirmedUnsafe: tool.schema.boolean().optional(),
          },
          async execute(args, context) {
            const seatId = safeSeat(args.seatId ?? "codex-review");
            await context.ask({
              permission: "codex_review",
              patterns: [seatId],
              always: [seatId],
              metadata: { seatId, scope: args.scope ?? "uncommitted" },
            });
            const existing = seats.get(seatKey(context.sessionID, seatId));
            const seat =
              existing ??
              (await attach(
                {
                  ...args,
                  seatId,
                  mode: "read-only",
                  approvalPolicy: "ask",
                  isolation:
                    args.isolation ??
                    ((args.scope ?? "uncommitted") === "uncommitted" ||
                    (args.scope ?? "uncommitted") === "custom"
                      ? "current"
                      : "worktree"),
                },
                context,
              ));
            const result = requireCompleted(
              await delegate.review(seat.handle, {
                target: reviewTarget(args.scope, args.value, args.title),
                delivery: args.delivery ?? "inline",
                timeoutMs: args.timeoutMs ?? options.defaults.timeoutMs,
                signal: context.abort,
              }),
              "review",
            );
            return turnOutput("Codex review", seat.handle, result);
          },
        }),
        codex_status: tool({
          description:
            "Inspect a Codex delegate seat attached to the current OpenCode session.",
          args: {
            seatId: tool.schema
              .string()
              .optional()
              .describe("Delegate seat name; defaults to codex"),
          },
          async execute(args, context) {
            const seatId = safeSeat(args.seatId);
            const handle = await resolveLiveHandle(
              seats,
              providerRuntime,
              context.sessionID,
              seatId,
            ).catch(() => null);
            if (!handle)
              return `Codex seat ${seatId} is not attached in this OpenCode process.`;
            return inspectionOutput(await delegate.inspect(handle));
          },
        }),
        codex_steer: tool({
          description:
            "Steer the active turn on a Codex delegate seat without waiting behind it.",
          args: {
            prompt: tool.schema
              .string()
              .min(1)
              .describe("New instruction for the active Codex turn"),
            seatId: tool.schema
              .string()
              .optional()
              .describe("Delegate seat name; defaults to codex"),
            timeoutMs: tool.schema
              .number()
              .int()
              .min(100)
              .max(3_600_000)
              .optional(),
          },
          async execute(args, context) {
            const seatId = safeSeat(args.seatId);
            const handle = await resolveLiveHandle(
              seats,
              providerRuntime,
              context.sessionID,
              seatId,
            );
            const result = await delegate.steer(handle, {
              prompt: args.prompt,
              timeoutMs: args.timeoutMs ?? 10_000,
            });
            return {
              title: `Steered Codex seat ${seatId}`,
              output: `Steered active Codex turn ${result.turnId}.`,
              metadata: { seatId, turnId: result.turnId },
            };
          },
        }),
        codex_cancel: tool({
          description:
            "Cancel the active turn on a Codex delegate seat in the current OpenCode session.",
          args: {
            seatId: tool.schema
              .string()
              .optional()
              .describe("Delegate seat name; defaults to codex"),
          },
          async execute(args, context) {
            const seatId = safeSeat(args.seatId);
            const handle = await resolveLiveHandle(
              seats,
              providerRuntime,
              context.sessionID,
              seatId,
            );
            return inspectionOutput(
              await delegate.cancel(handle),
              `Cancelled Codex seat ${seatId}`,
            );
          },
        }),
        codex_usage: tool({
          description:
            "Read Codex account usage and rate-limit buckets for an attached seat without starting a turn.",
          args: {
            seatId: tool.schema
              .string()
              .optional()
              .describe("Delegate seat name; defaults to codex"),
          },
          async execute(args, context) {
            const seatId = safeSeat(args.seatId);
            const handle = await resolveLiveHandle(
              seats,
              providerRuntime,
              context.sessionID,
              seatId,
            );
            const summary = await delegate.usage(handle);
            return usageOutput(seatId, summary);
          },
        }),
        codex_close: tool({
          description:
            "Close an attached Codex seat. Cleanup (default true) removes a managed worktree and deletes the Codex thread.",
          args: {
            seatId: tool.schema
              .string()
              .optional()
              .describe("Delegate seat name; defaults to codex"),
            cleanup: tool.schema
              .boolean()
              .optional()
              .describe(
                "Drop the managed worktree and delete the thread; defaults to true",
              ),
          },
          async execute(args, context) {
            const seatId = safeSeat(args.seatId);
            const handle = await resolveLiveHandle(
              seats,
              providerRuntime,
              context.sessionID,
              seatId,
            );
            const cleanup = args.cleanup !== false;
            const providerClosed = await providerRuntime.closeHandle(
              context.sessionID,
              handle,
              { cleanup },
            );
            if (!providerClosed) await delegate.close(handle, { cleanup });
            seats.delete(seatKey(context.sessionID, seatId));
            return {
              title: `Closed Codex seat ${seatId}`,
              output: cleanup
                ? `Closed ${seatId} and requested worktree/thread cleanup.`
                : `Closed ${seatId} and left the worktree and thread in place.`,
              metadata: { seatId, cleanup },
            };
          },
        }),
        codex_probe: tool({
          description:
            "Check the local Codex CLI version, authentication, transport, capabilities, and models.",
          args: {
            timeoutMs: tool.schema
              .number()
              .int()
              .min(100)
              .max(3_600_000)
              .optional(),
          },
          async execute(args, context) {
            return probeOutput(
              await delegate.probe({
                cwd: context.directory,
                timeoutMs:
                  args.timeoutMs ??
                  Math.min(options.defaults.timeoutMs, 30_000),
              }),
            );
          },
        }),
          }
        : undefined,
    };
  };
}

async function openSeat(
  delegate: DelegateClient,
  current: Seat | undefined,
  seatId: string,
  args: {
    model?: string;
    mode?: DelegateMode;
    isolation?: DelegateIsolation;
    approvalPolicy?: DelegateApprovalPolicy;
    timeoutMs?: number;
    confirmedUnsafe?: boolean;
  },
  defaults: Defaults,
  context: ToolContext,
) {
  if (current) await delegate.close(current.handle, { cleanup: false });
  const input = {
    sessionID: context.sessionID,
    seatId,
    cwd: context.directory,
    model: args.model ?? defaults.model,
    mode: args.mode ?? defaults.mode,
    isolation: args.isolation ?? defaults.isolation,
    approvalPolicy: args.approvalPolicy ?? defaults.approvalPolicy,
    timeoutMs: args.timeoutMs ?? defaults.timeoutMs,
    confirmedUnsafe: args.confirmedUnsafe ?? defaults.confirmedUnsafe,
    approval: (request: {
      permission: "command" | "file" | "permissions";
      patterns: string[];
      method: string;
      reason: string | null;
      metadata: Record<string, unknown>;
    }) =>
      context
        .ask({
          permission: `codex_${request.permission}`,
          patterns: request.patterns.length ? request.patterns : ["*"],
          always: request.patterns.length ? request.patterns : ["*"],
          metadata: {
            ...request.metadata,
            method: request.method,
            reason: request.reason,
          },
        })
        .then(
          () => "once" as const,
          () =>
            context.abort.aborted ? ("cancel" as const) : ("reject" as const),
        ),
  };
  return delegate.resume(input).catch((error: unknown) => {
    if (!(error instanceof DelegatorError) || error.code !== "INVALID_REQUEST")
      throw error;
    return delegate.create(input);
  });
}

function parseOptions(
  input: PluginInput,
  rawOptions: PluginOptions | undefined,
) {
  const options = rawOptions ?? {};
  const stateDir = stringOption(options.stateDir);
  const providerModels = Array.isArray(options.providerModels)
    ? options.providerModels.flatMap((value) => {
        const model = stringOption(value);
        return model ? [model] : [];
      })
    : [];
  return {
    directory: input.directory,
    executable: stringOption(options.executable),
    stateDir: stateDir
      ? isAbsolute(stateDir)
        ? stateDir
        : resolve(input.directory, stateDir)
      : resolve(input.directory, ".codex-delegate"),
    defaults: {
      model: stringOption(options.model),
      mode: options.mode === "read-only" ? "read-only" : "write",
      isolation: options.isolation === "current" ? "current" : "worktree",
      approvalPolicy:
        options.approvalPolicy === "auto" || options.approvalPolicy === "bypass"
          ? options.approvalPolicy
          : "ask",
      timeoutMs: timeoutOption(options.timeoutMs),
      confirmedUnsafe: options.confirmedUnsafe === true,
    } satisfies Defaults,
    tools: options.tools !== false,
    provider: {
      enabled: options.provider !== false,
      id: stringOption(options.providerId) ?? "codex-delegate",
      name: stringOption(options.providerName) ?? "Codex CLI Delegate",
      models: providerModels,
      probeTimeoutMs: integerOption(
        options.providerProbeTimeoutMs,
        5_000,
        100,
        60_000,
      ),
      contextWindow: integerOption(
        options.contextWindow,
        400_000,
        1_000,
        10_000_000,
      ),
      outputTokens: integerOption(
        options.outputTokens,
        128_000,
        1_000,
        1_000_000,
      ),
    },
  };
}

function registerProvider(
  config: Config,
  options: ReturnType<typeof parseOptions>,
  discovered: DelegateModel[],
  runtimeKey: string,
) {
  const existing = config.provider?.[options.provider.id];
  const models = [
    ...discovered,
    ...options.provider.models
      .filter((id) => !discovered.some((model) => model.id === id))
      .map(
        (id): DelegateModel => ({
          id,
          displayName: id,
          isDefault: false,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          inputModalities: ["text"],
        }),
      ),
  ];
  const available = models.length
    ? models
    : [
        {
          id: options.defaults.model ?? "default",
          displayName: options.defaults.model ?? "Codex CLI default",
          isDefault: true,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          inputModalities: ["text"],
        } satisfies DelegateModel,
      ];
  config.provider = {
    ...config.provider,
    [options.provider.id]: {
      ...existing,
      name: existing?.name ?? options.provider.name,
      npm: providerEntrypoint(),
      options: {
        directory: options.directory,
        stateDir: options.stateDir,
        mode: options.defaults.mode,
        isolation: options.defaults.isolation,
        approvalPolicy: options.defaults.approvalPolicy,
        timeoutMs: options.defaults.timeoutMs,
        confirmedUnsafe: options.defaults.confirmedUnsafe,
        runtimeKey,
        ...(options.executable ? { executable: options.executable } : {}),
        ...existing?.options,
      },
      models: {
        ...Object.fromEntries(
          available.map((model) => [
            model.id,
            {
              name: model.displayName,
              attachment: false,
              reasoning: model.supportedReasoningEfforts.length > 0,
              temperature: false,
              tool_call: false,
              cost: { input: 0, output: 0 },
              limit: {
                context: options.provider.contextWindow,
                output: options.provider.outputTokens,
              },
              modalities: { input: ["text" as const], output: ["text" as const] },
              options: model.defaultReasoningEffort
                ? { reasoningEffort: model.defaultReasoningEffort }
                : {},
            },
          ]),
        ),
        ...existing?.models,
      },
    },
  };
}

function providerEntrypoint() {
  return new URL(
    import.meta.url.endsWith(".ts") ? "./provider.ts" : "./provider.js",
    import.meta.url,
  ).href;
}

function stringOption(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timeoutOption(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 3_600_000
    ? value
    : 300_000;
}

function integerOption(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function seatConfiguration(
  args: {
    model?: string;
    mode?: DelegateMode;
    isolation?: DelegateIsolation;
    approvalPolicy?: DelegateApprovalPolicy;
    confirmedUnsafe?: boolean;
  },
  defaults: Defaults,
  directory: string,
) {
  return [
    directory,
    args.model ?? defaults.model ?? "",
    args.mode ?? defaults.mode,
    args.isolation ?? defaults.isolation,
    args.approvalPolicy ?? defaults.approvalPolicy,
    String(args.confirmedUnsafe ?? defaults.confirmedUnsafe),
  ].join("\0");
}

function seatKey(sessionID: string, seatId: string) {
  return `${sessionID}\0${seatId}`;
}

function safeSeat(value: string | undefined) {
  const seat = (value ?? "codex")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 64);
  if (!seat)
    throw new DelegatorError(
      "INVALID_REQUEST",
      "A non-empty Codex seat identifier is required.",
    );
  return seat;
}

async function resolveLiveHandle(
  seats: Map<string, Seat>,
  providerRuntime: CodexProviderRuntime,
  sessionID: string,
  seatId: string,
) {
  const tool = seats.get(seatKey(sessionID, seatId));
  if (tool) return tool.handle;
  const provider = await providerRuntime.resolveHandle(
    sessionID,
    seatId === "codex" ? undefined : seatId,
  );
  if (provider) return provider;
  throw new DelegatorError(
    "INVALID_REQUEST",
    `Codex seat ${seatId} is not attached in this session.`,
  );
}

function reviewTarget(
  scope: "uncommitted" | "base" | "commit" | "custom" | undefined,
  value?: string,
  title?: string,
): ReviewTarget {
  if (!scope || scope === "uncommitted") return { type: "uncommittedChanges" };
  const required = value?.trim();
  if (!required)
    throw new DelegatorError(
      "INVALID_REQUEST",
      `Codex ${scope} review requires a value.`,
    );
  if (scope === "base") return { type: "baseBranch", branch: required };
  if (scope === "commit")
    return { type: "commit", sha: required, title: title?.trim() || null };
  return { type: "custom", instructions: required };
}

function requireCompleted(
  result: DelegateTurnResult,
  operation: "turn" | "review",
) {
  if (result.status === "completed") return result;
  throw new DelegatorError(
    result.status === "rate-limited"
      ? "RATE_LIMITED"
      : result.status === "ambiguous"
        ? "AMBIGUOUS_DELIVERY"
        : result.status === "cancelled"
          ? "CANCELLED"
          : "TRANSPORT_ERROR",
    result.error?.message ?? `Codex delegate ${operation} ${result.status}.`,
    result.error?.retryable ?? false,
  );
}

function turnOutput(
  title: string,
  handle: DelegateHandle,
  result: DelegateTurnResult,
) {
  const changes = compactChanges(result.changes);
  const files = changes?.files ?? [];
  const body = result.output || "Codex completed without text output.";
  const changeBlock = files.length
    ? `\n\n${changes?.summary} in ${changes?.cwd}:\n${files
        .map((file) => `- ${file}`)
        .join("\n")}${
        changes?.filesTruncated
          ? `\n- ... ${changes.fileCount - files.length} more files`
          : ""
      }`
    : "";
  return {
    title: `${title} · ${handle.seatId}`,
    output: `${body}${changeBlock}`,
    metadata: {
      delegateId: handle.id,
      seatId: handle.seatId,
      transport: handle.transport,
      status: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      usage: result.usage,
      truncated: result.truncated,
      malformedEvents: result.malformedEvents,
      changes,
    },
  };
}

function inspectionOutput(
  inspection: DelegateInspection,
  title = `Codex seat ${inspection.handle.seatId}`,
) {
  const lastTurn = inspection.lastTurn
    ? {
        id: inspection.lastTurn.id,
        status: inspection.lastTurn.status,
        usage: inspection.lastTurn.usage,
        threadId: inspection.lastTurn.threadId,
        turnId: inspection.lastTurn.turnId,
        startedAt: inspection.lastTurn.startedAt,
        completedAt: inspection.lastTurn.completedAt,
        malformedEvents: inspection.lastTurn.malformedEvents,
        truncated: inspection.lastTurn.truncated,
        changes: compactChanges(inspection.lastTurn.changes),
        error: inspection.lastTurn.error,
      }
    : null;
  return {
    title,
    output: JSON.stringify({ ...inspection, lastTurn }, null, 2),
    metadata: {
      seatId: inspection.handle.seatId,
      status: inspection.status,
      transport: inspection.handle.transport,
      threadId: inspection.threadId,
      activeTurnId: inspection.activeTurnId,
      activeKind: inspection.activeKind,
      worktree: inspection.worktree,
      isolation: inspection.isolation,
    },
  };
}

function compactChanges(changes: DelegateTurnResult["changes"]) {
  if (!changes) return null;
  return {
    cwd: changes.cwd,
    summary: changes.summary,
    files: changes.files.slice(0, MAX_REPORTED_CHANGE_FILES),
    fileCount: changes.files.length,
    filesTruncated: changes.files.length > MAX_REPORTED_CHANGE_FILES,
    patchTruncated: changes.truncated,
  };
}

function usageOutput(seatId: string, summary: DelegateAccountUsage) {
  return {
    title: `Codex usage · ${seatId}`,
    output: JSON.stringify(summary, null, 2),
    metadata: {
      seatId,
      lifetimeTokens: summary.lifetimeTokens,
      peakDailyTokens: summary.peakDailyTokens,
      primaryUsedPercent: summary.primaryUsedPercent,
      secondaryUsedPercent: summary.secondaryUsedPercent,
    },
  };
}

function probeOutput(probe: DelegateProbe) {
  return {
    title: "Codex CLI probe",
    output: JSON.stringify(probe, null, 2),
    metadata: {
      ready: probe.ready,
      version: probe.version,
      transport: probe.transport,
      authenticated: probe.account.authenticated,
      models: probe.models.map((model) => model.id),
    },
  };
}
