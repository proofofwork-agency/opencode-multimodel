import { join, resolve } from "node:path";
import { runCodexExec } from "./codex-exec.ts";
import { DelegatorError } from "./errors.ts";
import { DelegateEventCollector, EMPTY_USAGE } from "./events.ts";
import {
  JsonRpcTransport,
  type JsonRpcTransportOptions,
  type RpcTransport,
  type ServerRequest,
} from "./json-rpc.ts";
import { runBounded } from "./process.ts";
import { AttachmentStore, type StoredAttachment } from "./store.ts";
import type {
  ConnectInput,
  CreateInput,
  DelegateAccount,
  DelegateApprovalReply,
  DelegateApprovalRequest,
  DelegateCapabilities,
  DelegateConnection,
  DelegateHandle,
  DelegateInspection,
  DelegateModel,
  DelegateProbe,
  DelegateTurnResult,
  Delegator,
  ResumeInput,
  ReviewInput,
  SteerInput,
  TurnInput,
} from "./types.ts";
import { ensureManagedWorktree } from "./worktree.ts";

const APP_SERVER_CAPABILITIES: DelegateCapabilities = {
  resume: true,
  steering: true,
  review: true,
  approvals: true,
  structuredEvents: true,
  persistentTransport: true,
  writes: true,
  cancellation: true,
};

const EXEC_CAPABILITIES: DelegateCapabilities = {
  resume: true,
  steering: false,
  review: false,
  approvals: false,
  structuredEvents: true,
  persistentTransport: false,
  writes: true,
  cancellation: true,
};

const NO_CAPABILITIES: DelegateCapabilities = {
  resume: false,
  steering: false,
  review: false,
  approvals: false,
  structuredEvents: false,
  persistentTransport: false,
  writes: false,
  cancellation: false,
};

const EMPTY_ACCOUNT: DelegateAccount = {
  authenticated: false,
  authMethod: null,
  planType: null,
  email: null,
  requiresOpenaiAuth: null,
};

type Runtime = {
  handle: DelegateHandle;
  sessionID: string | null;
  /** FIFO tail for this delegate: one live turn at a time, seats stay independent. */
  lane: Promise<void>;
  status: DelegateInspection["status"];
  sourceCwd: string;
  cwd: string;
  worktree: string | null;
  isolation: CreateInput["isolation"] & {};
  approvalPolicy: CreateInput["approvalPolicy"] & {};
  mode: CreateInput["mode"] & {};
  model: string | null;
  serviceName: string;
  env: NodeJS.ProcessEnv;
  threadId: string | null;
  activeTurnId: string | null;
  activeController: AbortController | null;
  transport: RpcTransport | null;
  capabilities: DelegateCapabilities;
  approval?: CreateInput["approval"];
  onEvent?: CreateInput["onEvent"];
  lastTurn: DelegateTurnResult | null;
  delivery: StoredAttachment["delivery"];
  store: AttachmentStore;
  createdAt: number;
  updatedAt: number;
};

export type CodexDelegatorOptions = {
  executable?: string;
  stateDir?: string;
  serviceName?: string;
  appServerArgv?: string[];
  openTransport?: (
    options: JsonRpcTransportOptions,
    timeoutMs: number,
  ) => Promise<RpcTransport>;
  ensureWorktree?: typeof ensureManagedWorktree;
  runExec?: typeof runCodexExec;
  now?: () => number;
  runCommand?: typeof runBounded;
};

export class CodexDelegator implements Delegator {
  private sessions = new Map<string, Runtime>();
  private loginTransport: RpcTransport | null = null;
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly openTransport;
  private readonly worktree;
  private readonly exec;
  private readonly now;
  private readonly command;
  private readonly executable;

  constructor(private readonly options: CodexDelegatorOptions = {}) {
    this.openTransport =
      options.openTransport ??
      ((input, timeoutMs) => JsonRpcTransport.open(input, timeoutMs));
    this.worktree = options.ensureWorktree ?? ensureManagedWorktree;
    this.exec = options.runExec ?? runCodexExec;
    this.now = options.now ?? Date.now;
    this.command = options.runCommand ?? runBounded;
    this.executable = options.executable ?? "codex";
  }

  async probe(input: ConnectInput = {}): Promise<DelegateProbe> {
    const cwd = resolve(input.cwd ?? process.cwd());
    const env = { ...process.env, ...input.env };
    const timeoutMs = boundedTimeout(input.timeoutMs ?? 5_000);
    const version = await this.command({
      argv: [this.executable, "--version"],
      cwd,
      env,
      timeoutMs,
    });
    if (version.exitCode !== 0) {
      return {
        ready: false,
        executable: "codex",
        version: null,
        transport: null,
        capabilities: { ...NO_CAPABILITIES },
        account: { ...EMPTY_ACCOUNT },
        models: [],
        reason: "Codex CLI is not installed or could not be executed.",
        evidence: [version.stderr.slice(0, 2_048)],
      };
    }
    const parsedVersion = parseVersion(`${version.stdout}\n${version.stderr}`);
    let transport: RpcTransport | null = null;
    try {
      transport = this.loginTransport ?? (await this.open(cwd, env, timeoutMs));
      const account = accountFromResponse(
        await transport.request(
          "account/read",
          { refreshToken: false },
          { timeoutMs },
        ),
      );
      const models = modelsFromResponse(
        await transport
          .request(
            "model/list",
            { limit: 100, includeHidden: false },
            { timeoutMs },
          )
          .catch(() => null),
      );
      if (account.authenticated || account.requiresOpenaiAuth === false) {
        await this.closeLoginTransport();
      }
      return {
        ready: account.authenticated || account.requiresOpenaiAuth === false,
        executable: "codex",
        version: parsedVersion,
        transport: "app-server",
        capabilities: { ...APP_SERVER_CAPABILITIES },
        account,
        models,
        reason:
          account.authenticated || account.requiresOpenaiAuth === false
            ? null
            : "Codex is not authenticated.",
        evidence: [
          `initialize succeeded over ${transport.id}`,
          "account/read completed",
          ...(models.length
            ? [`model/list returned ${models.length} picker-visible models`]
            : []),
        ],
      };
    } catch (error) {
      if (transport === this.loginTransport) await this.closeLoginTransport();
      const help = await this.command({
        argv: [this.executable, "exec", "--help"],
        cwd,
        env,
        timeoutMs,
      });
      if (
        help.exitCode !== 0 ||
        !`${help.stdout}\n${help.stderr}`.includes("--json")
      ) {
        return {
          ready: false,
          executable: "codex",
          version: parsedVersion,
          transport: null,
          capabilities: { ...NO_CAPABILITIES },
          account: { ...EMPTY_ACCOUNT },
          models: [],
          reason: `Codex app-server and exec fallback are unavailable: ${message(error)}`,
          evidence: [help.stderr.slice(0, 2_048)],
        };
      }
      const auth = await this.command({
        argv: [this.executable, "login", "status"],
        cwd,
        env,
        timeoutMs,
      });
      return {
        ready: auth.exitCode === 0,
        executable: "codex",
        version: parsedVersion,
        transport: "exec",
        capabilities: { ...EXEC_CAPABILITIES },
        account: {
          ...EMPTY_ACCOUNT,
          authenticated: auth.exitCode === 0,
          authMethod: /chatgpt/i.test(`${auth.stdout}\n${auth.stderr}`)
            ? "chatgpt"
            : /api[ -]?key/i.test(`${auth.stdout}\n${auth.stderr}`)
              ? "apiKey"
              : auth.exitCode === 0
                ? "custom"
                : null,
        },
        models: [],
        reason:
          auth.exitCode === 0
            ? null
            : "Codex exec is available but not authenticated.",
        evidence: [
          `app-server unavailable: ${message(error)}`.slice(0, 2_048),
          "codex exec --json is available",
        ],
      };
    } finally {
      if (transport !== this.loginTransport)
        await transport?.close().catch(() => undefined);
    }
  }

  async connect(input: ConnectInput = {}): Promise<DelegateConnection> {
    const probe = await this.probe(input);
    if (!input.loginIfNeeded || probe.ready || probe.transport !== "app-server")
      return { ...probe, login: null };
    await this.closeLoginTransport();
    const cwd = resolve(input.cwd ?? process.cwd());
    const timeoutMs = boundedTimeout(input.timeoutMs ?? 30_000);
    this.loginTransport = await this.open(
      cwd,
      { ...process.env, ...input.env },
      timeoutMs,
    );
    const response =
      object(
        await this.loginTransport
          .request(
            "account/login/start",
            input.deviceCode
              ? { type: "chatgptDeviceCode" }
              : {
                  type: "chatgpt",
                  useHostedLoginSuccessPage: true,
                  appBrand: "chatgpt",
                },
            { timeoutMs },
          )
          .catch(async (error) => {
            await this.closeLoginTransport();
            throw error;
          }),
      ) ?? {};
    const loginId = text(response.loginId);
    const authUrl = text(response.authUrl) ?? text(response.verificationUrl);
    if (!loginId || !authUrl) {
      await this.closeLoginTransport();
      throw new DelegatorError(
        "TRANSPORT_ERROR",
        "Codex did not return a login URL.",
      );
    }
    this.loginTimer = setTimeout(
      () => void this.closeLoginTransport(),
      600_000,
    );
    this.loginTimer.unref?.();
    return {
      ...probe,
      login: {
        type: input.deviceCode ? "chatgptDeviceCode" : "chatgpt",
        loginId,
        authUrl,
        userCode: text(response.userCode),
      },
    };
  }

  async create(input: CreateInput): Promise<DelegateHandle> {
    const seatId = safeSeat(input.seatId ?? "codex");
    const isolation = input.isolation ?? "worktree";
    const approvalPolicy = input.approvalPolicy ?? "ask";
    const mode = input.mode ?? "write";
    requireUnsafeConfirmation(isolation, approvalPolicy, input.confirmedUnsafe);
    const env = { ...process.env, ...input.env };
    const sourceCwd = resolve(input.cwd);
    const placement =
      isolation === "worktree"
        ? await this.worktree(sourceCwd, seatId, env, input.sessionID)
        : { sourceRoot: sourceCwd, worktree: sourceCwd };
    const id = crypto.randomUUID();
    const createdAt = this.now();
    const store = new AttachmentStore(
      this.options.stateDir ?? join(placement.sourceRoot, ".codex-delegate"),
    );
    const runtime: Runtime = {
      handle: { id, seatId, transport: "app-server" },
      sessionID: input.sessionID ?? null,
      lane: Promise.resolve(),
      status: "idle",
      sourceCwd: placement.sourceRoot,
      cwd: placement.worktree,
      worktree: isolation === "worktree" ? placement.worktree : null,
      isolation,
      approvalPolicy,
      mode,
      model: normalizeModel(input.model),
      serviceName: this.options.serviceName?.trim() || "codex-delegator",
      env,
      threadId: null,
      activeTurnId: null,
      activeController: null,
      transport: null,
      capabilities: { ...APP_SERVER_CAPABILITIES },
      approval: input.approval,
      onEvent: input.onEvent,
      lastTurn: null,
      delivery: "none",
      store,
      createdAt,
      updatedAt: createdAt,
    };
    try {
      runtime.transport = await this.openForRuntime(
        runtime,
        boundedTimeout(input.timeoutMs ?? 10_000),
      );
      const started = object(
        await runtime.transport.request(
          "thread/start",
          threadParams(runtime, false),
          {
            timeoutMs: boundedTimeout(input.timeoutMs ?? 10_000),
          },
        ),
      );
      runtime.threadId = text(object(started?.thread)?.id);
      if (!runtime.threadId)
        throw new DelegatorError(
          "TRANSPORT_ERROR",
          "Codex did not return a thread identifier.",
        );
    } catch (error) {
      await runtime.transport?.close().catch(() => undefined);
      runtime.transport = null;
      const fallback = await this.probe({
        cwd: runtime.cwd,
        env,
        timeoutMs: input.timeoutMs,
      });
      if (!fallback.ready || fallback.transport !== "exec") throw error;
      runtime.handle.transport = "exec";
      runtime.capabilities = { ...EXEC_CAPABILITIES };
    }
    this.sessions.set(id, runtime);
    await this.persist(runtime);
    return { ...runtime.handle };
  }

  async resume(input: ResumeInput): Promise<DelegateHandle> {
    const sourceCwd = resolve(input.cwd);
    const store = new AttachmentStore(
      this.options.stateDir ?? join(sourceCwd, ".codex-delegate"),
    );
    const attachment = input.id
      ? await store.get(input.id)
      : await store.getSeat(safeSeat(input.seatId ?? "codex"), input.sessionID);
    const threadId = input.threadId ?? attachment?.threadId;
    if (!threadId)
      throw new DelegatorError(
        "INVALID_REQUEST",
        "A persisted or explicit Codex thread identifier is required to resume.",
      );
    const isolation = input.isolation ?? attachment?.isolation ?? "worktree";
    const approvalPolicy =
      input.approvalPolicy ?? attachment?.approvalPolicy ?? "ask";
    requireUnsafeConfirmation(isolation, approvalPolicy, input.confirmedUnsafe);
    const env = { ...process.env, ...input.env };
    const placement =
      attachment?.worktree &&
      (await Bun.file(`${attachment.worktree}/.git`).exists())
        ? { sourceRoot: attachment.sourceCwd, worktree: attachment.worktree }
        : isolation === "worktree"
          ? await this.worktree(
              sourceCwd,
              safeSeat(input.seatId ?? attachment?.seatId ?? "codex"),
              env,
              input.sessionID,
            )
          : { sourceRoot: sourceCwd, worktree: sourceCwd };
    const now = this.now();
    const sessionID = input.sessionID ?? null;
    // Adopting a record from another session (or a pre-session legacy record) keeps its
    // Codex thread but takes a fresh delegate id, so two sessions never share a runtime.
    const adopted =
      attachment && (attachment.sessionID ?? null) === sessionID
        ? attachment.id
        : null;
    const id = input.id ?? adopted ?? crypto.randomUUID();
    const runtime: Runtime = {
      handle: {
        id,
        seatId: safeSeat(input.seatId ?? attachment?.seatId ?? "codex"),
        transport: "app-server",
      },
      sessionID,
      lane: Promise.resolve(),
      status: "idle",
      sourceCwd: placement.sourceRoot,
      cwd: placement.worktree,
      worktree: isolation === "worktree" ? placement.worktree : null,
      isolation,
      approvalPolicy,
      mode: input.mode ?? attachment?.mode ?? "write",
      model: normalizeModel(input.model ?? attachment?.model),
      serviceName: this.options.serviceName?.trim() || "codex-delegator",
      env,
      threadId,
      activeTurnId: null,
      activeController: null,
      transport: null,
      capabilities: { ...APP_SERVER_CAPABILITIES },
      approval: input.approval,
      onEvent: input.onEvent,
      lastTurn: attachment?.lastTurn ?? null,
      delivery: attachment?.delivery ?? "none",
      store,
      createdAt: attachment?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      runtime.transport = await this.openForRuntime(
        runtime,
        boundedTimeout(input.timeoutMs ?? 10_000),
      );
      const resumed = object(
        await runtime.transport.request(
          "thread/resume",
          { ...threadParams(runtime, false), threadId },
          { timeoutMs: boundedTimeout(input.timeoutMs ?? 10_000) },
        ),
      );
      runtime.threadId = text(object(resumed?.thread)?.id) ?? threadId;
    } catch (error) {
      await runtime.transport?.close().catch(() => undefined);
      runtime.transport = null;
      const fallback = await this.probe({
        cwd: runtime.cwd,
        env,
        timeoutMs: input.timeoutMs,
      });
      if (!fallback.ready || fallback.transport !== "exec") throw error;
      runtime.handle.transport = "exec";
      runtime.capabilities = { ...EXEC_CAPABILITIES };
    }
    this.sessions.set(id, runtime);
    await this.persist(runtime);
    return { ...runtime.handle };
  }

  async turn(
    session: DelegateHandle | string,
    input: TurnInput | string,
  ): Promise<DelegateTurnResult> {
    const runtime = this.require(session);
    const request = typeof input === "string" ? { prompt: input } : input;
    const prompt = checkedPrompt(request.prompt);
    return this.lane(runtime, () => this.runTurn(runtime, request, prompt));
  }

  private async runTurn(
    runtime: Runtime,
    request: TurnInput,
    prompt: string,
  ): Promise<DelegateTurnResult> {
    this.requireIdle(runtime);
    if (runtime.handle.transport === "exec") {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", forwardAbort, { once: true });
      request.signal?.throwIfAborted();
      runtime.activeController = controller;
      runtime.status = "running";
      runtime.updatedAt = this.now();
      try {
        const result = await this.exec({
          executable: this.executable,
          cwd: runtime.cwd,
          env: runtime.env,
          prompt,
          model: runtime.model,
          reasoningEffort: normalizeReasoningEffort(request.reasoningEffort) ?? undefined,
          mode: runtime.mode,
          approvalPolicy: runtime.approvalPolicy,
          nativeThreadId: runtime.threadId,
          timeoutMs: boundedTimeout(request.timeoutMs ?? 300_000),
          signal: controller.signal,
          onEvent: request.onEvent ?? runtime.onEvent,
        });
        runtime.threadId = result.threadId ?? runtime.threadId;
        runtime.lastTurn = result;
        runtime.status = result.status === "failed" ? "failed" : "idle";
        runtime.delivery = result.status === "completed" ? "completed" : "none";
        runtime.updatedAt = this.now();
        await this.persist(runtime);
        return result;
      } catch (error) {
        runtime.status = "failed";
        runtime.updatedAt = this.now();
        await this.persist(runtime);
        throw error;
      } finally {
        request.signal?.removeEventListener("abort", forwardAbort);
        runtime.activeController = null;
      }
    }
    return this.stream(
      runtime,
      "turn/start",
      {
        threadId: runtime.threadId,
        input: userInput(prompt),
        model: runtime.model,
        effort: normalizeReasoningEffort(request.reasoningEffort),
        approvalPolicy: approvalPolicy(runtime),
      },
      request,
    );
  }

  async steer(session: DelegateHandle | string, input: SteerInput | string) {
    const runtime = this.require(session);
    if (!runtime.capabilities.steering || !runtime.transport) {
      throw new DelegatorError(
        "CAPABILITY_UNAVAILABLE",
        "The active Codex fallback does not support steering.",
      );
    }
    const request = typeof input === "string" ? { prompt: input } : input;
    const expectedTurnId = request.expectedTurnId ?? runtime.activeTurnId;
    if (!expectedTurnId || runtime.status !== "running") {
      throw new DelegatorError(
        "INVALID_REQUEST",
        "Codex steering requires an active turn identifier.",
      );
    }
    const result = object(
      await runtime.transport.request(
        "turn/steer",
        {
          threadId: runtime.threadId,
          expectedTurnId,
          input: userInput(checkedPrompt(request.prompt)),
        },
        { timeoutMs: boundedTimeout(request.timeoutMs ?? 10_000) },
      ),
    );
    return { turnId: text(result?.turnId) ?? expectedTurnId };
  }

  async review(session: DelegateHandle | string, input: ReviewInput = {}) {
    const runtime = this.require(session);
    return this.lane(runtime, async () => {
      this.requireIdle(runtime);
      if (!runtime.capabilities.review || !runtime.transport) {
        throw new DelegatorError(
          "CAPABILITY_UNAVAILABLE",
          "The active Codex exec fallback does not support native review.",
        );
      }
      return this.stream(
        runtime,
        "review/start",
        {
          threadId: runtime.threadId,
          delivery: input.delivery ?? "inline",
          target: input.target ?? { type: "uncommittedChanges" },
        },
        { prompt: "review", ...input },
      );
    });
  }

  async cancel(session: DelegateHandle | string) {
    const runtime = this.require(session);
    if (!runtime.activeController) return this.snapshot(runtime);
    if (runtime.transport && runtime.threadId && runtime.activeTurnId) {
      await runtime.transport
        .request(
          "turn/interrupt",
          { threadId: runtime.threadId, turnId: runtime.activeTurnId },
          { timeoutMs: 5_000 },
        )
        .catch(async () => {
          await runtime.transport?.close().catch(() => undefined);
          runtime.transport = null;
        });
    }
    runtime.activeController.abort("delegate cancelled");
    runtime.status = "idle";
    runtime.updatedAt = this.now();
    await this.persist(runtime);
    return this.snapshot(runtime);
  }

  async inspect(session: DelegateHandle | string) {
    return this.snapshot(this.require(session));
  }

  async close(session: DelegateHandle | string) {
    const runtime = this.require(session);
    if (runtime.status === "closed") return;
    await this.cancel(runtime.handle).catch(() => undefined);
    await runtime.transport?.close().catch(() => undefined);
    runtime.transport = null;
    runtime.status = "closed";
    runtime.updatedAt = this.now();
    await this.persist(runtime);
  }

  /**
   * Shut every delegate this instance owns down. Children are spawned detached, so
   * without this every `codex app-server` outlives the host process as an orphan.
   * Active turns are aborted and transports closed before the first `await` returns,
   * which keeps the teardown useful even from a handler that cannot await.
   */
  async closeAll(): Promise<number> {
    const runtimes = [...this.sessions.values()].filter(
      (runtime) => runtime.status !== "closed",
    );
    const closing = runtimes.map((runtime) => {
      runtime.activeController?.abort("delegate shutting down");
      runtime.activeController = null;
      runtime.activeTurnId = null;
      runtime.status = "closed";
      runtime.updatedAt = this.now();
      const transport = runtime.transport;
      runtime.transport = null;
      return Promise.all([
        transport?.close().catch(() => undefined),
        this.persist(runtime),
      ]);
    });
    await Promise.all([...closing, this.closeLoginTransport()]);
    return runtimes.length;
  }

  /**
   * Arrival-ordered admission for one delegate. The promise-chain mutex ensures
   * concurrent turns on one seat queue instead of hitting the
   * `SESSION_BUSY` invariant, while different seats stay fully concurrent — running many
   * vendors at once is the product. `steer` and `cancel` deliberately skip this lane.
   */
  private async lane<T>(runtime: Runtime, work: () => Promise<T>): Promise<T> {
    const previous = runtime.lane;
    const gate = Promise.withResolvers<void>();
    runtime.lane = previous.then(() => gate.promise);
    await previous;
    try {
      return await work();
    } finally {
      gate.resolve();
    }
  }

  private async stream(
    runtime: Runtime,
    method: "turn/start" | "review/start",
    params: unknown,
    input: TurnInput | ReviewInput,
  ) {
    if (!runtime.transport)
      throw new DelegatorError(
        "SESSION_CLOSED",
        "Codex app-server transport is unavailable.",
      );
    const startedAt = this.now();
    const timeoutMs = boundedTimeout(input.timeoutMs ?? 300_000);
    const deadlineAt = Date.now() + timeoutMs;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    runtime.activeController = controller;
    runtime.status = "running";
    runtime.delivery = "none";
    runtime.updatedAt = startedAt;
    const collector = new DelegateEventCollector({
      onEvent: input.onEvent ?? runtime.onEvent,
    });
    let accepted = false;
    let completed: Record<string, unknown> | null = null;
    let resultThreadId: string | null = null;
    let primaryTurnId: string | null = null;
    const completions = new Map<string, Record<string, unknown>>();
    let transportFailure: Error | null = null;
    const completion = Promise.withResolvers<void>();
    const unsubscribe = runtime.transport.subscribe((event) => {
      if (event.method === "delegate/transportFailure") {
        transportFailure = new Error(
          text(object(event.params)?.message) ??
            "Codex app-server transport failed.",
        );
        completion.resolve();
        return;
      }
      collector.push(event);
      const eventParams = object(event.params);
      const eventTurnId =
        text(object(eventParams?.turn)?.id) ?? text(eventParams?.turnId);
      if (
        event.method === "turn/started" &&
        eventTurnId &&
        !runtime.activeTurnId
      ) {
        runtime.activeTurnId = eventTurnId;
      }
      if (event.method !== "turn/completed") return;
      if (eventTurnId) completions.set(eventTurnId, event);
      if (!primaryTurnId || (eventTurnId && eventTurnId !== primaryTurnId))
        return;
      completed = event;
      completion.resolve();
    });
    const abort = () => {
      void this.cancel(runtime.handle).catch(() => undefined);
      completion.resolve();
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = object(
        await runtime.transport.request(method, params, {
          timeoutMs: remainingTurnMs(deadlineAt),
          signal: controller.signal,
        }),
      );
      const responseTurn = object(response?.turn);
      resultThreadId = text(response?.reviewThreadId);
      if (
        method === "review/start" &&
        "delivery" in input &&
        input.delivery === "detached" &&
        resultThreadId
      ) {
        runtime.threadId = resultThreadId;
      }
      primaryTurnId = text(responseTurn?.id) ?? runtime.activeTurnId;
      runtime.activeTurnId = primaryTurnId;
      if (primaryTurnId && completions.has(primaryTurnId)) {
        completed = completions.get(primaryTurnId) ?? null;
        completion.resolve();
      }
      accepted = true;
      runtime.delivery = "accepted";
      runtime.updatedAt = this.now();
      await this.persist(runtime);
      if (
        text(responseTurn?.status) &&
        text(responseTurn?.status) !== "inProgress"
      ) {
        collector.push({
          method: "turn/completed",
          params: { threadId: runtime.threadId, turn: responseTurn },
        });
        completed = { method: "turn/completed" };
      }
      await wait(
        completion.promise,
        remainingTurnMs(deadlineAt),
        controller.signal,
      );
      if (transportFailure) throw transportFailure;
      if (!completed && controller.signal.aborted)
        throw new DelegatorError("CANCELLED", "Codex turn was cancelled.");
      if (!completed)
        throw new DelegatorError(
          "TIMED_OUT",
          "Codex turn completion timed out.",
          true,
        );
      const snapshot = collector.snapshot();
      const status = snapshot.status ?? "completed";
      const result: DelegateTurnResult = {
        id: crypto.randomUUID(),
        status,
        output: snapshot.output,
        events: snapshot.events,
        usage: snapshot.usage,
        threadId: resultThreadId ?? snapshot.threadId ?? runtime.threadId,
        turnId: snapshot.turnId ?? runtime.activeTurnId,
        startedAt,
        completedAt: this.now(),
        malformedEvents: snapshot.malformed,
        truncated: snapshot.truncated,
        error: snapshot.error
          ? {
              code: status === "rate-limited" ? "RATE_LIMITED" : "TURN_FAILED",
              message: snapshot.error,
              retryable: status === "rate-limited",
            }
          : null,
      };
      runtime.lastTurn = result;
      runtime.delivery = "completed";
      runtime.status = status === "failed" ? "failed" : "idle";
      runtime.updatedAt = result.completedAt;
      await this.persist(runtime);
      return result;
    } catch (error) {
      const failure =
        error instanceof DelegatorError
          ? error
          : new DelegatorError(
              accepted ? "AMBIGUOUS_DELIVERY" : "TRANSPORT_ERROR",
              accepted
                ? `Codex transport failed after accepting the turn; delivery is ambiguous and will not be replayed: ${message(error)}`
                : message(error),
              !accepted,
            );
      if (failure.code === "TIMED_OUT" && accepted) {
        if (runtime.transport && runtime.threadId && runtime.activeTurnId) {
          await runtime.transport
            .request(
              "turn/interrupt",
              { threadId: runtime.threadId, turnId: runtime.activeTurnId },
              { timeoutMs: 5_000 },
            )
            .catch(async () => {
              await runtime.transport?.close().catch(() => undefined);
              runtime.transport = null;
            });
        } else {
          await runtime.transport?.close().catch(() => undefined);
          runtime.transport = null;
        }
      }
      const status =
        failure.code === "CANCELLED"
          ? "cancelled"
          : failure.code === "RATE_LIMITED"
            ? "rate-limited"
            : accepted
              ? "ambiguous"
              : "failed";
      const snapshot = collector.snapshot();
      const result: DelegateTurnResult = {
        id: crypto.randomUUID(),
        status,
        output: snapshot.output,
        events: snapshot.events,
        usage: snapshot.usage ?? { ...EMPTY_USAGE },
        threadId: resultThreadId ?? snapshot.threadId ?? runtime.threadId,
        turnId: snapshot.turnId ?? runtime.activeTurnId,
        startedAt,
        completedAt: this.now(),
        malformedEvents: snapshot.malformed,
        truncated: snapshot.truncated,
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
      };
      runtime.lastTurn = result;
      runtime.delivery = status === "ambiguous" ? "ambiguous" : "none";
      runtime.status =
        status === "ambiguous"
          ? "ambiguous"
          : status === "cancelled"
            ? "idle"
            : "failed";
      runtime.updatedAt = result.completedAt;
      await this.persist(runtime);
      return result;
    } finally {
      unsubscribe();
      controller.signal.removeEventListener("abort", abort);
      input.signal?.removeEventListener("abort", forwardAbort);
      runtime.activeController = null;
      runtime.activeTurnId = null;
    }
  }

  private open(
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    onServerRequest?: JsonRpcTransportOptions["onServerRequest"],
  ) {
    return this.openTransport(
      {
        argv: this.options.appServerArgv ?? [
          this.executable,
          "app-server",
          "--listen",
          "stdio://",
          "--strict-config",
        ],
        cwd,
        env,
        onServerRequest,
      },
      timeoutMs,
    );
  }

  private async closeLoginTransport() {
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null;
    const transport = this.loginTransport;
    this.loginTransport = null;
    await transport?.close().catch(() => undefined);
  }

  private openForRuntime(runtime: Runtime, timeoutMs: number) {
    return this.open(runtime.cwd, runtime.env, timeoutMs, (request) =>
      this.approve(runtime, request),
    );
  }

  private async approve(runtime: Runtime, request: ServerRequest) {
    const approval = approvalRequest(request);
    runtime.status = "awaiting-approval";
    runtime.updatedAt = this.now();
    runtime.onEvent?.({
      sequence: runtime.lastTurn?.events.length ?? 0,
      kind: "approval",
      method: request.method,
      threadId: approval.threadId,
      turnId: approval.turnId,
      itemId: approval.itemId,
      text: approval.reason ?? approval.patterns.join(" "),
      usage: null,
    });
    const reply: DelegateApprovalReply =
      runtime.approvalPolicy === "auto" || runtime.approvalPolicy === "bypass"
        ? "once"
        : runtime.approval
          ? await runtime.approval(approval)
          : "reject";
    runtime.status = "running";
    runtime.updatedAt = this.now();
    if (request.method === "item/permissions/requestApproval") {
      return reply === "once" || reply === "always"
        ? {
            permissions: object(request.params.permissions) ?? {},
            scope: reply === "always" ? "session" : "turn",
          }
        : { permissions: {}, scope: "turn" };
    }
    return {
      decision:
        reply === "once"
          ? "accept"
          : reply === "always"
            ? "acceptForSession"
            : reply === "cancel"
              ? "cancel"
              : "decline",
    };
  }

  private require(session: DelegateHandle | string) {
    const id = typeof session === "string" ? session : session.id;
    const runtime = this.sessions.get(id);
    if (!runtime)
      throw new DelegatorError(
        "INVALID_REQUEST",
        `Unknown Codex delegate session: ${id}`,
      );
    return runtime;
  }

  /**
   * Defensive invariant, not a control path: `turn` and `review` run inside the seat
   * lane, so an active controller here means something bypassed admission. Non-retryable
   * on purpose — nothing honours a retry flag, and a caller that reaches this state would
   * only spin. Reports the seat, never the internal delegate uuid.
   */
  private requireIdle(runtime: Runtime) {
    if (runtime.status === "closed")
      throw new DelegatorError(
        "SESSION_CLOSED",
        `Codex seat ${runtime.handle.seatId} is closed.`,
      );
    if (runtime.activeController)
      throw new DelegatorError(
        "SESSION_BUSY",
        `Codex seat ${runtime.handle.seatId} already has an active turn.`,
      );
  }

  private snapshot(runtime: Runtime): DelegateInspection {
    return structuredClone({
      handle: runtime.handle,
      status: runtime.status,
      cwd: runtime.cwd,
      sourceCwd: runtime.sourceCwd,
      worktree: runtime.worktree,
      isolation: runtime.isolation,
      approvalPolicy: runtime.approvalPolicy,
      mode: runtime.mode,
      model: runtime.model,
      threadId: runtime.threadId,
      activeTurnId: runtime.activeTurnId,
      capabilities: runtime.capabilities,
      lastTurn: runtime.lastTurn,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    });
  }

  private persist(runtime: Runtime) {
    return runtime.store.put({
      id: runtime.handle.id,
      seatId: runtime.handle.seatId,
      sessionID: runtime.sessionID,
      transport: runtime.handle.transport,
      sourceCwd: runtime.sourceCwd,
      cwd: runtime.cwd,
      worktree: runtime.worktree,
      isolation: runtime.isolation,
      approvalPolicy: runtime.approvalPolicy,
      mode: runtime.mode,
      model: runtime.model,
      threadId: runtime.threadId,
      delivery: runtime.delivery,
      lastTurn: runtime.lastTurn,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    });
  }
}

function threadParams(runtime: Runtime, ephemeral: boolean) {
  return {
    cwd: runtime.cwd,
    model: runtime.model,
    sandbox:
      runtime.mode === "read-only"
        ? "read-only"
        : runtime.approvalPolicy === "bypass"
          ? "danger-full-access"
          : runtime.mode === "write"
            ? "workspace-write"
            : "read-only",
    approvalPolicy: approvalPolicy(runtime),
    approvalsReviewer: "user",
    serviceName: runtime.serviceName,
    ephemeral,
  };
}

function approvalPolicy(runtime: Runtime) {
  if (runtime.approvalPolicy === "bypass" || runtime.mode === "read-only")
    return "never";
  return "on-request";
}

function approvalRequest(request: ServerRequest): DelegateApprovalRequest {
  const params = request.params;
  const command = text(params.command);
  const grantRoot = text(params.grantRoot);
  const patterns = command
    ? [command]
    : grantRoot
      ? [grantRoot]
      : [JSON.stringify(params.permissions ?? "*").slice(0, 2_000)];
  return {
    id: request.id,
    method: request.method,
    threadId: text(params.threadId),
    turnId: text(params.turnId),
    itemId: text(params.itemId),
    permission: request.method.includes("commandExecution")
      ? "command"
      : request.method.includes("fileChange")
        ? "file"
        : "permissions",
    patterns,
    reason: text(params.reason),
    metadata: params,
  };
}

function accountFromResponse(value: unknown): DelegateAccount {
  const response = object(value);
  const account = object(response?.account);
  const type = text(account?.type);
  return {
    authenticated:
      type === "chatgpt" ||
      type === "apiKey" ||
      response?.requiresOpenaiAuth === false,
    authMethod:
      type === "chatgpt"
        ? "chatgpt"
        : type === "apiKey"
          ? "apiKey"
          : response?.requiresOpenaiAuth === false
            ? "custom"
            : null,
    planType: text(account?.planType),
    email: text(account?.email),
    requiresOpenaiAuth:
      typeof response?.requiresOpenaiAuth === "boolean"
        ? response.requiresOpenaiAuth
        : null,
  };
}

function modelsFromResponse(value: unknown): DelegateModel[] {
  const data = object(value)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((value) => {
    const model = object(value);
    const id = text(model?.id) ?? text(model?.model);
    if (!id) return [];
    const efforts = Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap((value) => {
          const effort = object(value);
          const name = text(effort?.reasoningEffort);
          return name ? [name] : [];
        })
      : [];
    const modalities = Array.isArray(model?.inputModalities)
      ? model.inputModalities.filter(
          (value): value is string => typeof value === "string",
        )
      : ["text", "image"];
    return [
      {
        id,
        displayName: text(model?.displayName) ?? id,
        isDefault: model?.isDefault === true,
        defaultReasoningEffort: text(model?.defaultReasoningEffort),
        supportedReasoningEfforts: efforts,
        inputModalities: modalities,
      },
    ];
  });
}

function requireUnsafeConfirmation(
  isolation: string,
  approval: string,
  confirmed: boolean | undefined,
) {
  if (isolation === "worktree" && approval !== "bypass") return;
  if (confirmed) return;
  throw new DelegatorError(
    "INVALID_REQUEST",
    `${isolation === "current" ? "Current-checkout" : "Bypass"} delegate mode requires explicit confirmation for this run.`,
  );
}

function normalizeModel(value: string | null | undefined) {
  const model = value?.trim().replace(/^openai\//, "");
  return model || null;
}

function normalizeReasoningEffort(value: string | null | undefined) {
  return value?.trim() || null;
}

function checkedPrompt(value: string) {
  if (!value?.trim())
    throw new DelegatorError(
      "INVALID_REQUEST",
      "A non-empty Codex prompt is required.",
    );
  if (Buffer.byteLength(value) > 500_000)
    throw new DelegatorError(
      "INVALID_REQUEST",
      "Codex prompt exceeds 500000 UTF-8 bytes.",
    );
  return value;
}

function safeSeat(value: string) {
  const seat = value
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 64);
  if (!seat)
    throw new DelegatorError(
      "INVALID_REQUEST",
      "A delegate seat identifier is required.",
    );
  return seat;
}

function boundedTimeout(value: number) {
  if (!Number.isFinite(value) || value < 100 || value > 3_600_000) {
    throw new DelegatorError(
      "INVALID_REQUEST",
      "Delegate timeout must be between 100 and 3600000 milliseconds.",
    );
  }
  return Math.floor(value);
}

function remainingTurnMs(deadlineAt: number) {
  return Math.max(1, deadlineAt - Date.now());
}

function parseVersion(value: string) {
  return (
    value.match(
      /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i,
    )?.[1] ??
    (value.trim().slice(0, 128) || null)
  );
}

function userInput(prompt: string) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function wait(promise: Promise<void>, timeoutMs: number, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new DelegatorError("TIMED_OUT", "Codex turn timed out.", true)),
      timeoutMs,
    );
    timer.unref?.();
    abort = () =>
      reject(new DelegatorError("CANCELLED", "Codex turn was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([promise, boundary]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  });
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function message(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
