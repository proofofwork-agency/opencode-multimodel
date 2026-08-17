import type { BtwClient, ModelRef } from "./client.ts";
import { parseModelRef, type BtwOptions } from "./options.ts";
import {
  BTW_AGENT_ID,
  BTW_CHILD_TITLE_PREFIX,
  BTW_AGENT_PROMPT,
  btwSidePrompt,
  btwSnapshotPreamble,
} from "./prompts.ts";
import { inheritModel, renderSnapshot, toSnapshotMessages } from "./snapshot.ts";

export type SideExchange = {
  id: string;
  parentSessionID: string;
  question: string;
  answer: string;
  status: "answered" | "failed" | "cancelled";
  error?: string;
  model?: string;
  childSessionID?: string;
  createdAt: number;
  durationMs: number;
};

export type SideAskInput = {
  sessionID: string;
  question: string;
  signal?: AbortSignal;
  onUpdate?: (text: string) => void;
};

export type SideRunnerHooks = {
  smallModel?: () => string | undefined;
};

export type BtwErrorCode =
  | "EMPTY_QUESTION"
  | "BUSY"
  | "SNAPSHOT"
  | "CHILD_SESSION"
  | "MODEL"
  | "TIMEOUT"
  | "ABORTED"
  | "MODEL_ERROR"
  | "EMPTY_ANSWER";

export class BtwError extends Error {
  constructor(
    readonly code: BtwErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BtwError";
  }
}

export const BTW_DISABLED_TOOLS: Record<string, boolean> = {
  bash: false,
  edit: false,
  grep: false,
  glob: false,
  list: false,
  read: false,
  write: false,
  patch: false,
  applypatch: false,
  multiedit: false,
  deletefile: false,
  todowrite: false,
  todoread: false,
  webfetch: false,
  task: false,
  setmodel: false,
  btw: false,
  codex_delegate: false,
  codex_review: false,
  codex_status: false,
  codex_steer: false,
  codex_cancel: false,
  codex_usage: false,
  codex_close: false,
  codex_probe: false,
  multimodel_fleet: false,
  multimodel_collab: false,
  multimodel_run: false,
  multimodel_workflow: false,
};

type InFlight = {
  parentSessionID: string;
  childSessionID: string;
  streams: Map<string, string>;
  onUpdate?: (text: string) => void;
};

export class SideRunner {
  private readonly inFlight = new Map<string, InFlight>();
  private readonly children = new Set<string>();

  constructor(
    private readonly client: BtwClient,
    private readonly options: BtwOptions,
    private readonly hooks: SideRunnerHooks = {},
  ) {}

  isChild(sessionID: string): boolean {
    return this.children.has(sessionID);
  }

  async ask(input: SideAskInput): Promise<SideExchange> {
    const question = input.question.trim();
    if (!question) {
      throw new BtwError("EMPTY_QUESTION", "A /btw side question is required.");
    }
    input.signal?.throwIfAborted();
    const active = [...this.inFlight.values()].filter(
      (flight) => flight.parentSessionID === input.sessionID,
    ).length;
    if (active >= this.options.concurrency) {
      throw new BtwError(
        "BUSY",
        `Another side question is already running for this session (limit ${this.options.concurrency}).`,
      );
    }

    const startedAt = Date.now();
    const messagesResponse = await this.client.session.messages({
      sessionID: input.sessionID,
      limit: this.options.maxMessages,
    });
    if (messagesResponse.error) {
      throw new BtwError(
        "SNAPSHOT",
        `Could not read session ${input.sessionID}: ${describe(messagesResponse.error)}`,
      );
    }
    const messages = toSnapshotMessages(messagesResponse.data);
    const snapshot = renderSnapshot(messages, this.options);

    const model = this.resolveModel(snapshot.model);
    const childResponse = await this.client.session.create({
      parentID: input.sessionID,
      title: childTitle(question),
    });
    if (childResponse.error || !childResponse.data?.id) {
      throw new BtwError(
        "CHILD_SESSION",
        `Could not create the ephemeral side session: ${describe(childResponse.error ?? "missing session id")}`,
      );
    }
    const childSessionID = childResponse.data.id;
    this.children.add(childSessionID);
    const flight: InFlight = {
      parentSessionID: input.sessionID,
      childSessionID,
      streams: new Map(),
      onUpdate: input.onUpdate,
    };
    this.inFlight.set(childSessionID, flight);

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        void this.client.session.abort({ sessionID: childSessionID }).catch(
          () => undefined,
        );
        reject(
          new BtwError(
            "TIMEOUT",
            `The side question did not answer within ${this.options.timeoutMs}ms.`,
          ),
        );
      }, this.options.timeoutMs);
    });
    const signalAbort = new Promise<never>((_resolve, reject) => {
      if (!input.signal) return;
      if (input.signal.aborted) {
        reject(
          Object.assign(
            new BtwError("ABORTED", "The side question was cancelled."),
            { btwStatus: "cancelled" },
          ),
        );
        return;
      }
      input.signal.addEventListener(
        "abort",
        () =>
          reject(
            Object.assign(
              new BtwError("ABORTED", "The side question was cancelled."),
              { btwStatus: "cancelled" },
            ),
          ),
        { once: true },
      );
    });
    const abort = () => {
      void this.client.session.abort({ sessionID: childSessionID }).catch(
        () => undefined,
      );
    };
    input.signal?.addEventListener("abort", abort, { once: true });

    try {
      const promptPromise = this.client.session.prompt({
        sessionID: childSessionID,
        model,
        agent: BTW_AGENT_ID,
        system: BTW_AGENT_PROMPT,
        tools: BTW_DISABLED_TOOLS,
        parts: [
          {
            type: "text",
            text: `${btwSnapshotPreamble(
              snapshot.truncatedMessages,
              snapshot.messageCount,
            )}\n${snapshot.text}`,
          },
          { type: "text", text: btwSidePrompt(question) },
        ],
      });
      promptPromise.catch(() => undefined);
      const response = await Promise.race([
        promptPromise,
        timeout,
        signalAbort,
      ]);
      if (timedOut) {
        throw new BtwError(
          "TIMEOUT",
          `The side question did not answer within ${this.options.timeoutMs}ms.`,
        );
      }
      if (response.error) {
        throw new BtwError(
          "MODEL_ERROR",
          `Side question failed: ${describe(response.error)}`,
        );
      }
      if (response.data?.info?.error) {
        throw new BtwError(
          "MODEL_ERROR",
          `Side model failed: ${describe(response.data.info.error)}`,
        );
      }
      const answer = responseText(response.data?.parts);
      if (!answer) {
        throw new BtwError(
          "EMPTY_ANSWER",
          "The side model returned no text answer.",
        );
      }
      return {
        id: crypto.randomUUID(),
        parentSessionID: input.sessionID,
        question,
        answer,
        status: "answered",
        model: model ? `${model.providerID}/${model.modelID}` : undefined,
        childSessionID,
        createdAt: startedAt,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const status = input.signal?.aborted
        ? "cancelled"
        : timedOut
          ? "cancelled"
          : "failed";
      throw Object.assign(
        error instanceof Error ? error : new Error(describe(error)),
        { btwStatus: status },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      this.inFlight.delete(childSessionID);
      await this.client.session.delete({ sessionID: childSessionID }).catch(
        () => undefined,
      );
      this.children.delete(childSessionID);
    }
  }

  consumePartEvent(part: unknown): void {
    const value = part as {
      id?: unknown;
      sessionID?: unknown;
      type?: unknown;
      text?: unknown;
      synthetic?: unknown;
    } | null;
    if (!value || typeof value.sessionID !== "string") return;
    const flight = this.inFlight.get(value.sessionID);
    if (!flight || value.type !== "text" || typeof value.text !== "string") {
      return;
    }
    if (value.synthetic === true) return;
    const key = typeof value.id === "string"
      ? value.id
      : `stream-${flight.streams.size}`;
    flight.streams.set(key, value.text);
    flight.onUpdate?.([...flight.streams.values()].join(""));
  }

  async cancelFor(parentSessionID: string): Promise<void> {
    const flights = [...this.inFlight.values()].filter(
      (flight) => flight.parentSessionID === parentSessionID,
    );
    await Promise.all(
      flights.map((flight) =>
        this.client.session.abort({ sessionID: flight.childSessionID }).catch(
          () => undefined,
        ),
      ),
    );
  }

  async dispose(): Promise<void> {
    const ids = [...this.inFlight.keys()];
    await Promise.all(
      ids.map((sessionID) =>
        this.client.session.abort({ sessionID }).catch(() => undefined),
      ),
    );
    this.inFlight.clear();
    this.children.clear();
  }

  private resolveModel(inherited?: ModelRef): ModelRef | undefined {
    if (this.options.model === "small") {
      const raw = this.hooks.smallModel?.();
      const parsed = raw ? parseModelRef(raw) : undefined;
      if (parsed) return parsed;
    }
    if (typeof this.options.model === "object") return this.options.model;
    return inherited;
  }
}

function responseText(parts: unknown[] | undefined): string {
  return (parts ?? [])
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as { type?: unknown; text?: unknown };
  return part.type === "text" && typeof part.text === "string";
}

export function childTitle(question: string): string {
  const prefix = question.split(/\s+/).slice(0, 6).join(" ").slice(0, 48);
  return `${BTW_CHILD_TITLE_PREFIX} ${prefix}`;
}

export function describe(value: unknown) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
