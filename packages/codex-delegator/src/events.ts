import { redactText } from "./redaction.ts";
import type { DelegateEvent, DelegateUsage } from "./types.ts";

const EMPTY_USAGE: DelegateUsage = {
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
};

export class DelegateEventCollector {
  private events: DelegateEvent[] = [];
  private bytes = 0;
  private sequence = 0;
  private malformed = 0;
  private truncated = false;
  private output = "";
  private outputItems = new Map<string, string>();
  private usage: DelegateUsage = { ...EMPTY_USAGE };
  private threadId: string | null = null;
  private turnId: string | null = null;
  private status: "completed" | "failed" | "cancelled" | "rate-limited" | null =
    null;
  private error: string | null = null;

  constructor(
    private readonly options: {
      maxEvents?: number;
      maxBytes?: number;
      maxOutputBytes?: number;
      onEvent?: (event: DelegateEvent) => void;
    } = {},
  ) {}

  push(value: unknown) {
    const decoded = decodeEvent(value, this.sequence);
    if (!decoded.length && value !== undefined) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        this.malformed += 1;
      return;
    }
    decoded.forEach((event) => this.retain(event));
  }

  markMalformed(message = "Malformed structured Codex event.") {
    this.malformed += 1;
    this.retain({
      sequence: this.sequence,
      kind: "diagnostic",
      method: "delegate/diagnostic",
      threadId: this.threadId,
      turnId: this.turnId,
      itemId: null,
      text: message,
      usage: null,
    });
  }

  snapshot() {
    return {
      events: structuredClone(this.events),
      output: this.output,
      usage: { ...this.usage },
      threadId: this.threadId,
      turnId: this.turnId,
      status: this.status,
      error: this.error,
      malformed: this.malformed,
      truncated: this.truncated,
    };
  }

  private retain(event: DelegateEvent) {
    event.sequence = this.sequence++;
    if (event.threadId) this.threadId = event.threadId;
    if (event.turnId) this.turnId = event.turnId;
    if (event.usage) this.usage = mergeUsage(this.usage, event.usage);
    if (event.kind === "text" && event.text) {
      const completedSnapshot =
        event.method === "item/completed" || event.method === "item.completed";
      if (completedSnapshot && event.itemId) {
        const previous = this.outputItems.get(event.itemId) ?? "";
        this.outputItems.set(event.itemId, event.text);
        this.output = replaceTrailingOutput(
          this.output,
          previous,
          event.text,
          this.options.maxOutputBytes,
        );
      } else {
        if (event.itemId)
          this.outputItems.set(
            event.itemId,
            `${this.outputItems.get(event.itemId) ?? ""}${event.text}`,
          );
        this.output = appendOutput(
          this.output,
          event.text,
          this.options.maxOutputBytes,
        );
      }
    }
    if (event.kind === "error") {
      this.error = event.text;
      if (/rate|429|too many requests/i.test(event.text ?? ""))
        this.status = "rate-limited";
      else this.status = "failed";
    }
    if (event.kind === "rate-limit") this.status = "rate-limited";
    if (event.kind === "rate-limit")
      this.error = event.text ?? "Codex rate limit reached.";
    if (event.kind === "completion") {
      if (/cancel|interrupt/i.test(event.text ?? "")) this.status = "cancelled";
      else if (this.status !== "rate-limited")
        this.status = /fail|error/i.test(event.text ?? "")
          ? "failed"
          : "completed";
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    const maxEvents = this.options.maxEvents ?? 2_048;
    const maxBytes = this.options.maxBytes ?? 1_000_000;
    if (this.events.length >= maxEvents || this.bytes + bytes > maxBytes) {
      this.truncated = true;
      return;
    }
    this.events.push(event);
    this.bytes += bytes;
    this.options.onEvent?.(structuredClone(event));
  }
}

export function decodeEvent(value: unknown, sequence = 0): DelegateEvent[] {
  const message = object(value);
  if (!message) return [];
  const method = text(message.method) ?? text(message.type) ?? "unknown";
  const params = object(message.params) ?? message;
  const thread = object(params.thread);
  const turn = object(params.turn);
  const item = object(params.item);
  const threadId = firstText(params.threadId, params.thread_id, thread?.id);
  const turnId = firstText(params.turnId, params.turn_id, turn?.id);
  const itemId = firstText(params.itemId, params.item_id, item?.id);
  const base = { sequence, method, threadId, turnId, itemId };

  if (method === "thread/started" || method === "thread.started")
    return [event("thread", base, null)];
  if (method === "turn/started" || method === "turn.started")
    return [event("turn", base, null)];
  if (
    method === "item/agentMessage/delta" ||
    method === "response.output_text.delta"
  ) {
    const delta = firstText(params.delta, message.delta);
    return delta ? [event("text", base, delta)] : [];
  }
  if (
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta"
  ) {
    const delta = firstText(params.delta, message.delta);
    return delta ? [event("reasoning", base, delta)] : [];
  }
  if (
    method === "item/started" ||
    method === "item/completed" ||
    method === "item.completed"
  ) {
    const itemType = firstText(item?.type, params.item_type) ?? "item";
    if (["agentMessage", "agent_message", "message"].includes(itemType)) {
      if (method === "item/started") return [];
      const body = firstText(item?.text, params.text);
      return body ? [event("text", base, body)] : [];
    }
    if (itemType === "exitedReviewMode") {
      const review = firstText(item?.review, params.review);
      return review ? [event("text", base, review)] : [];
    }
    if (itemType === "fileChange") {
      return [event("file", base, describeItem(item, itemType, method))];
    }
    return [event("tool", base, describeItem(item, itemType, method))];
  }
  if (
    method === "thread/tokenUsage/updated" ||
    method === "account/rateLimits/updated"
  ) {
    if (method === "account/rateLimits/updated") {
      return [
        event(
          rateLimitExhausted(params) ? "rate-limit" : "diagnostic",
          base,
          describeRateLimit(params),
        ),
      ];
    }
    const usage = object(params.tokenUsage) ?? object(params.usage) ?? {};
    return [{ ...event("usage", base, null), usage: decodeUsage(usage) }];
  }
  if (method === "turn/completed" || method === "turn.completed") {
    const status = firstText(turn?.status, params.status) ?? "completed";
    const usage = object(turn?.usage) ?? object(params.usage);
    return [
      ...(usage
        ? [{ ...event("usage", base, null), usage: decodeUsage(usage) }]
        : []),
      event("completion", base, status),
    ];
  }
  if (method === "error") {
    const error = object(params.error);
    const body =
      firstText(error?.message, params.message, message.message) ??
      "Codex reported an error.";
    return [
      event(
        /rate|429|too many requests/i.test(body) ? "rate-limit" : "error",
        base,
        body,
      ),
    ];
  }
  if (method === "delegate/diagnostic")
    return [
      event("diagnostic", base, firstText(params.message) ?? "Diagnostic"),
    ];
  if (method.includes("requestApproval"))
    return [event("approval", base, firstText(params.reason) ?? method)];
  return [];
}

function event(
  kind: DelegateEvent["kind"],
  base: Pick<
    DelegateEvent,
    "sequence" | "method" | "threadId" | "turnId" | "itemId"
  >,
  body: string | null,
): DelegateEvent {
  return {
    ...base,
    kind,
    text: body ? redactText(body, 64_000) : null,
    usage: null,
  };
}

function decodeUsage(value: Record<string, unknown>): DelegateUsage {
  const total = object(value.total) ?? value;
  const input = number(
    total.inputTokens,
    total.input_tokens,
    value.inputTokens,
    value.input_tokens,
  );
  const output = number(
    total.outputTokens,
    total.output_tokens,
    value.outputTokens,
    value.output_tokens,
  );
  const cached = number(
    total.cachedInputTokens,
    total.cached_input_tokens,
    value.cachedInputTokens,
  );
  const reasoning = number(
    total.reasoningTokens,
    total.reasoning_tokens,
    value.reasoningTokens,
  );
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens:
      number(total.totalTokens, total.total_tokens, value.totalTokens) ??
      nullableSum(input, output),
  };
}

function mergeUsage(
  current: DelegateUsage,
  next: DelegateUsage,
): DelegateUsage {
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
    cachedInputTokens: next.cachedInputTokens ?? current.cachedInputTokens,
    reasoningTokens: next.reasoningTokens ?? current.reasoningTokens,
    totalTokens: next.totalTokens ?? current.totalTokens,
  };
}

function appendOutput(current: string, incoming: string, maxBytes = 262_144) {
  const next = `${current}${incoming}`;
  if (Buffer.byteLength(next) <= maxBytes) return next;
  return Buffer.from(next).subarray(0, maxBytes).toString("utf8");
}

function replaceTrailingOutput(
  current: string,
  previous: string,
  incoming: string,
  maxBytes = 262_144,
) {
  if (!previous || !current.endsWith(previous))
    return current.endsWith(incoming)
      ? current
      : appendOutput(current, incoming, maxBytes);
  return appendOutput(current.slice(0, -previous.length), incoming, maxBytes);
}

function describeItem(
  item: Record<string, unknown> | null,
  type: string,
  lifecycle: string,
) {
  if (!item)
    return `${type} ${lifecycle.endsWith("started") ? "started" : "completed"}`;
  const command = firstText(item.command, item.cmd);
  if (command) return command;
  const changes = Array.isArray(item.changes)
    ? item.changes
        .flatMap((change) => firstText(object(change)?.path) ?? [])
        .join(", ")
    : "";
  return (
    changes ||
    `${type} ${lifecycle.endsWith("started") ? "started" : "completed"}`
  );
}

function describeRateLimit(params: Record<string, unknown>) {
  const rateLimits = object(params.rateLimits) ?? params;
  const primary = object(rateLimits.primary);
  const used = number(primary?.usedPercent, primary?.used_percent);
  const reset = number(primary?.resetsAt, primary?.resets_at);
  return `Codex rate limit${used === null ? "" : ` ${used}% used`}${reset === null ? "" : `; resets ${reset}`}`;
}

function rateLimitExhausted(params: Record<string, unknown>) {
  const rateLimits = object(params.rateLimits) ?? params;
  return [object(rateLimits.primary), object(rateLimits.secondary)]
    .filter((limit): limit is Record<string, unknown> => limit !== null)
    .some(
      (limit) => (number(limit.usedPercent, limit.used_percent) ?? 0) >= 100,
    );
}

function nullableSum(a: number | null, b: number | null) {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function firstText(...values: unknown[]) {
  return values.map(text).find((value) => value !== null) ?? null;
}

function number(...values: unknown[]) {
  return (
    values.find(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    ) ?? null
  );
}

export { EMPTY_USAGE };
