import { DelegatorError } from "./errors.ts";
import { terminateProcess } from "./process.ts";
import { redactText, redactValue } from "./redaction.ts";

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type ServerRequest = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
};

export type JsonRpcTransportOptions = {
  argv?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  maxFrameBytes?: number;
  onServerRequest?: (request: ServerRequest) => Promise<unknown>;
};

export interface RpcTransport {
  readonly id: string;
  request(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  subscribe(
    listener: (message: Record<string, unknown>) => void,
  ): () => boolean | void;
  close(): Promise<void>;
}

export class JsonRpcTransport implements RpcTransport {
  readonly id = `codex-${crypto.randomUUID()}`;
  readonly argv: string[];
  readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private pending = new Map<number, Pending>();
  private notifications = new Set<(message: Record<string, unknown>) => void>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private retainedBytes = 0;
  private failure: Error | null = null;
  private closing: Promise<void> | null = null;
  private malformed = 0;
  private readonly maxBytes: number;
  private readonly maxFrameBytes: number;

  private constructor(private readonly options: JsonRpcTransportOptions) {
    this.argv = options.argv ?? [
      "codex",
      "app-server",
      "--listen",
      "stdio://",
      "--strict-config",
    ];
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.maxFrameBytes = options.maxFrameBytes ?? 1_000_000;
    this.child = Bun.spawn(this.argv, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    void this.readStdout();
    void this.readStderr();
    void this.child.exited.then((code) => {
      if (!this.closing && code !== 0)
        this.fail(new Error(`Codex app-server exited ${code}.`));
      if (!this.closing)
        this.fail(new Error("Codex app-server transport closed."));
    });
  }

  static async open(options: JsonRpcTransportOptions, timeoutMs = 5_000) {
    const transport = new JsonRpcTransport(options);
    try {
      await transport.request(
        "initialize",
        {
          clientInfo: {
            name: "codex-delegator",
            title: "Codex Delegator",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: false },
        },
        { timeoutMs },
      );
      transport.notify("initialized", {});
      return transport;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  request(
    method: string,
    params: unknown = {},
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) {
    if (this.failure) throw this.failure;
    if (this.closing)
      throw new DelegatorError(
        "SESSION_CLOSED",
        "Codex app-server transport is closed.",
      );
    options?.signal?.throwIfAborted();
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ id, method, params });
    });
    return withBoundary(
      response,
      options?.timeoutMs ?? 300_000,
      options?.signal,
      () => {
        this.pending.delete(id);
      },
    );
  }

  notify(method: string, params: unknown = {}) {
    if (this.failure || this.closing) return;
    this.write({ method, params });
  }

  subscribe(listener: (message: Record<string, unknown>) => void) {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  inspect() {
    return {
      id: this.id,
      pid: this.child.pid,
      closed: Boolean(this.closing),
      pendingRequests: this.pending.size,
      retainedBytes: this.retainedBytes,
      malformedFrames: this.malformed,
      stderr: redactText(this.stderr, 4_096),
      failure: this.failure?.message ?? null,
    };
  }

  close() {
    this.closing ??= this.closeInternal();
    return this.closing;
  }

  private async closeInternal() {
    this.fail(new Error("Codex app-server transport closed."));
    this.child.stdin.end();
    await terminateProcess(this.child);
  }

  private async readStdout() {
    const decoder = new TextDecoder();
    const reader = this.child.stdout.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        this.buffer += decoder.decode(chunk.value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        lines.forEach((line) => this.acceptBoundedLine(line));
        if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
          throw new DelegatorError(
            "OUTPUT_OVERFLOW",
            "Codex app-server JSON-RPC frame exceeded its bound.",
          );
        }
      }
      this.buffer += decoder.decode();
      if (this.buffer.trim()) this.acceptBoundedLine(this.buffer);
    } catch (error) {
      this.fail(asError(error));
      await this.close().catch(() => undefined);
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr() {
    const decoder = new TextDecoder();
    const reader = this.child.stderr.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      const remaining = Math.max(
        0,
        this.maxBytes - Buffer.byteLength(this.stderr),
      );
      if (remaining === 0) continue;
      this.stderr += Buffer.from(text).subarray(0, remaining).toString("utf8");
    }
    this.stderr += decoder.decode();
    reader.releaseLock();
  }

  private acceptBoundedLine(line: string) {
    if (Buffer.byteLength(line) > this.maxFrameBytes) {
      throw new DelegatorError(
        "OUTPUT_OVERFLOW",
        "Codex app-server JSON-RPC frame exceeded its bound.",
      );
    }
    this.acceptLine(line);
  }

  private acceptLine(line: string) {
    if (!line.trim()) return;
    this.retainedBytes = Math.min(this.maxBytes, Buffer.byteLength(line));
    const parsed = parseFrame(line);
    if (!parsed) {
      this.malformed += 1;
      this.emit({
        method: "delegate/diagnostic",
        params: { message: "Malformed JSON-RPC frame." },
      });
      return;
    }
    if (typeof parsed.id === "number" && !parsed.method) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.error) {
        const detail = object(parsed.error);
        const message =
          string(detail?.message) ??
          `Codex app-server ${pending.method} failed.`;
        const error = new DelegatorError(
          /rate|429|too many requests/i.test(message)
            ? "RATE_LIMITED"
            : "TRANSPORT_ERROR",
          redactText(message, 2_048),
          /rate|429|temporar|busy/i.test(message),
        );
        Object.assign(error, {
          rpcCode: detail?.code,
          data: redactValue(detail?.data),
        });
        pending.reject(error);
        return;
      }
      pending.resolve(parsed.result ?? {});
      return;
    }
    if (
      (typeof parsed.id === "number" || typeof parsed.id === "string") &&
      typeof parsed.method === "string"
    ) {
      void this.handleServerRequest({
        id: parsed.id,
        method: parsed.method,
        params: object(parsed.params) ?? {},
      });
      return;
    }
    this.emit(parsed);
  }

  private async handleServerRequest(request: ServerRequest) {
    try {
      const result = this.options.onServerRequest
        ? await this.options.onServerRequest(request)
        : unsupportedRequest(request.method);
      this.write({ id: request.id, result });
    } catch (error) {
      this.write({
        id: request.id,
        error: {
          code: -32000,
          message: redactText(asError(error).message, 2_048),
        },
      });
    }
  }

  private emit(message: Record<string, unknown>) {
    this.notifications.forEach((listener) => listener(message));
  }

  private write(message: unknown) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    // A frame is only useful once it reaches the app-server. Bun's stdin is a FileSink, which
    // buffers, so writing alone does not promise delivery — and on Windows it does not deliver: the
    // handshake got through and then every request timed out with the frame still in the buffer.
    // That is a hang in the real Codex delegate transport, not only in its tests. Nothing here ever
    // batches frames, so flushing each one costs nothing and is what makes this a stream.
    const flushed = this.child.stdin.flush();
    // A rejected flush surfaces on the next read as a closed transport; it must not go unhandled.
    if (flushed instanceof Promise) void flushed.catch(() => undefined);
  }

  private fail(error: Error) {
    if (!this.failure)
      this.emit({
        method: "delegate/transportFailure",
        params: { message: error.message },
      });
    this.failure ??= error;
    this.pending.forEach((pending) => pending.reject(this.failure!));
    this.pending.clear();
  }
}

function parseFrame(line: string) {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function withBoundary<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  cleanup: () => void,
) {
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DelegatorError(
            "TIMED_OUT",
            "Codex app-server request timed out.",
            true,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
    abort = () =>
      reject(
        new DelegatorError(
          "CANCELLED",
          "Codex app-server request was cancelled.",
        ),
      );
    signal?.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([promise, boundary]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    cleanup();
  });
}

function unsupportedRequest(method: string) {
  throw new DelegatorError(
    "CAPABILITY_UNAVAILABLE",
    `Unsupported Codex server request: ${method}`,
  );
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
