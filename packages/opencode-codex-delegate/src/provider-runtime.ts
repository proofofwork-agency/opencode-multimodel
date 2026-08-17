import { withGoalContext } from "./goal-bridge.ts";
import {
  CodexDelegator,
  DelegatorError,
  type CodexDelegatorOptions,
  type DelegateApprovalPolicy,
  type CloseInput,
  type DelegateEvent,
  type DelegateHandle,
  type DelegateIsolation,
  type DelegateMode,
  type DelegateTurnResult,
} from "codex-delegator";

export type DelegateClient = Pick<
  CodexDelegator,
  | "probe"
  | "create"
  | "resume"
  | "turn"
  | "review"
  | "steer"
  | "cancel"
  | "inspect"
  | "usage"
  | "close"
  | "closeAll"
>;

export type ProviderDefaults = {
  mode: DelegateMode;
  isolation: DelegateIsolation;
  approvalPolicy: DelegateApprovalPolicy;
  timeoutMs: number;
  confirmedUnsafe: boolean;
};

export type ProviderRuntimeOptions = {
  directory: string;
  executable?: string;
  stateDir?: string;
  defaults: ProviderDefaults;
  delegate?: DelegateClient;
};

export type ProviderRunInput = {
  sessionID: string;
  agent: string;
  messageID?: string;
  model: string;
  fullPrompt: string;
  latestPrompt: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
  onEvent?: (event: DelegateEvent) => void;
};

type ProviderSeat = {
  configuration: string;
  handle: DelegateHandle;
  continuing: boolean;
  lastMessageID?: string;
  lastResult?: DelegateTurnResult;
};

export class CodexProviderRuntime {
  private readonly delegate: DelegateClient;
  private readonly seats = new Map<string, ProviderSeat>();
  private readonly attaching = new Map<string, Promise<ProviderSeat>>();
  private readonly closing = new Map<string, Promise<void>>();

  constructor(private readonly options: ProviderRuntimeOptions) {
    this.delegate =
      options.delegate ??
      new CodexDelegator({
        executable: options.executable,
        stateDir: options.stateDir,
        serviceName: "codex_opencode",
      } satisfies CodexDelegatorOptions);
  }

  async run(input: ProviderRunInput): Promise<DelegateTurnResult> {
    const seat = await this.attach(input);
    if (
      input.messageID &&
      seat.lastMessageID === input.messageID &&
      seat.lastResult
    )
      return structuredClone(seat.lastResult);
    const prompt = seat.continuing ? input.latestPrompt : input.fullPrompt;
    const result = await this.delegate.turn(seat.handle, {
      prompt: withGoalContext(
        this.options.directory,
        input.sessionID,
        prompt,
      ),
      timeoutMs: this.options.defaults.timeoutMs,
      reasoningEffort: input.reasoningEffort,
      signal: input.signal,
      onEvent: input.onEvent,
    });
    if (result.status === "completed") {
      seat.continuing = true;
      seat.lastMessageID = input.messageID;
      seat.lastResult = structuredClone(result);
    }
    return result;
  }

  async resolveHandle(sessionID: string, seatId?: string) {
    const matching = [...this.seats.entries()].filter(([key]) =>
      key.startsWith(`${sessionID}\0`),
    );
    if (seatId) {
      const byAgent = this.seats.get(`${sessionID}\0${seatId}`);
      if (byAgent) return byAgent.handle;
      const bySeat = matching.find(
        ([, seat]) =>
          seat.handle.seatId === seatId ||
          seat.handle.seatId === `provider-${seatId}`,
      );
      if (bySeat) return bySeat[1].handle;
    }
    for (const [, seat] of matching) {
      const snapshot = await this.delegate.inspect(seat.handle).catch(() => null);
      if (
        snapshot?.status === "running" ||
        snapshot?.status === "awaiting-approval" ||
        snapshot?.activeTurnId
      )
        return seat.handle;
    }
    return matching.length === 1 ? matching[0]![1].handle : null;
  }

  async closeHandle(
    sessionID: string,
    handle: DelegateHandle | string,
    input: CloseInput,
  ) {
    const id = typeof handle === "string" ? handle : handle.id;
    const matching = [...this.seats.entries()].filter(
      ([key, seat]) =>
        key.startsWith(`${sessionID}\0`) && seat.handle.id === id,
    );
    if (!matching.length) return false;
    matching.forEach(([key]) => this.seats.delete(key));
    const closing = this.delegate.close(handle, input);
    matching.forEach(([key]) => this.closing.set(key, closing));
    try {
      await closing;
    } finally {
      matching.forEach(([key]) => {
        if (this.closing.get(key) === closing) this.closing.delete(key);
      });
    }
    return true;
  }

  async closeSession(sessionID: string) {
    await Promise.allSettled(
      [...this.attaching.entries(), ...this.closing.entries()]
        .filter(([key]) => key.startsWith(`${sessionID}\0`))
        .map(([, pending]) => pending),
    );
    const matching = [...this.seats.entries()].filter(([key]) =>
      key.startsWith(`${sessionID}\0`),
    );
    matching.forEach(([key]) => this.seats.delete(key));
    await Promise.allSettled(
      matching.map(([, seat]) =>
        this.delegate.close(seat.handle, { cleanup: false }),
      ),
    );
  }

  async dispose() {
    await Promise.allSettled([
      ...this.attaching.values(),
      ...this.closing.values(),
    ]);
    const handles = [...this.seats.values()].map((seat) => seat.handle);
    this.seats.clear();
    this.attaching.clear();
    await Promise.allSettled(
      handles.map((handle) => this.delegate.close(handle)),
    );
  }

  private async attach(input: ProviderRunInput): Promise<ProviderSeat> {
    const key = `${input.sessionID}\0${input.agent}`;
    const configuration = [
      this.options.directory,
      input.model,
      this.options.defaults.mode,
      this.options.defaults.isolation,
      this.options.defaults.approvalPolicy,
      String(this.options.defaults.confirmedUnsafe),
    ].join("\0");
    const pending = this.attaching.get(key);
    if (pending) {
      await pending;
      return this.attach(input);
    }
    const closing = this.closing.get(key);
    if (closing) {
      await closing;
      return this.attach(input);
    }
    const current = this.seats.get(key);
    if (current?.configuration === configuration) return current;
    this.seats.delete(key);
    const opening = this.open(current, input, configuration).finally(() => {
      if (this.attaching.get(key) === opening) this.attaching.delete(key);
    });
    this.attaching.set(key, opening);
    const seat = await opening;
    this.seats.set(key, seat);
    return seat;
  }

  private async open(
    current: ProviderSeat | undefined,
    input: ProviderRunInput,
    configuration: string,
  ) {
    if (current) await this.delegate.close(current.handle);
    const model = input.model === "default" ? undefined : input.model;
    const attachment = {
      sessionID: input.sessionID,
      seatId: `provider-${safeSeat(input.agent)}`,
      cwd: this.options.directory,
      model,
      mode: this.options.defaults.mode,
      isolation: this.options.defaults.isolation,
      approvalPolicy: this.options.defaults.approvalPolicy,
      timeoutMs: this.options.defaults.timeoutMs,
      confirmedUnsafe: this.options.defaults.confirmedUnsafe,
    };
    return this.delegate
      .resume(attachment)
      .then((handle) => ({ configuration, handle, continuing: true }))
      .catch((error: unknown) => {
        if (
          !(error instanceof DelegatorError) ||
          error.code !== "INVALID_REQUEST"
        )
          throw error;
        return this.delegate
          .create(attachment)
          .then((handle) => ({ configuration, handle, continuing: false }));
      });
  }
}

const installedRuntimes = new Map<string, CodexProviderRuntime>();

export function installProviderRuntime(runtime: CodexProviderRuntime) {
  const key = crypto.randomUUID();
  installedRuntimes.set(key, runtime);
  return key;
}

export function getInstalledProviderRuntime(key?: string) {
  if (key) return installedRuntimes.get(key);
  if (installedRuntimes.size !== 1) return;
  return installedRuntimes.values().next().value as
    | CodexProviderRuntime
    | undefined;
}

export function uninstallProviderRuntime(
  key: string,
  runtime: CodexProviderRuntime,
) {
  if (installedRuntimes.get(key) === runtime) installedRuntimes.delete(key);
}

function safeSeat(value: string) {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_.-]/g, "-")
      .slice(0, 48) || "agent"
  );
}
