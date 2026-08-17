export type SnapshotPart =
  | { type: "text"; text: string; synthetic?: boolean }
  | { type: "tool"; tool: string; state: { status?: string } | string }
  | { type: string; [key: string]: unknown };

export type SnapshotMessage = {
  role: "user" | "assistant" | string;
  model?: { providerID: string; modelID: string };
  summary?: boolean;
  parts: SnapshotPart[];
};

export type SnapshotBudget = {
  maxMessages: number;
  maxChars: number;
};

export type Snapshot = {
  text: string;
  messageCount: number;
  truncatedMessages: number;
  truncatedChars: boolean;
  model?: { providerID: string; modelID: string };
};

const TOOL_STATE_RUNNING = new Set(["pending", "running"]);

/**
 * Normalizes real `session.messages` entries — `{ info, parts }` siblings,
 * where `info` itself has no `parts` field — into SnapshotMessages.
 */
export function toSnapshotMessages(entries: unknown): SnapshotMessage[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { info, parts } = entry as {
      info?: unknown;
      parts?: unknown;
    };
    if (!info || typeof info !== "object") return [];
    const details = info as {
      role?: unknown;
      model?: unknown;
      summary?: unknown;
      parts?: unknown;
    };
    const messageParts = Array.isArray(parts) && parts.length > 0
      ? parts
      : Array.isArray(details.parts)
        ? details.parts
        : [];
    const model = details.model as { providerID?: unknown; modelID?: unknown } | undefined;
    return [{
      role: typeof details.role === "string" ? details.role : "user",
      model:
        model &&
          typeof model.providerID === "string" &&
          typeof model.modelID === "string"
          ? { providerID: model.providerID, modelID: model.modelID }
          : undefined,
      summary: details.summary === true,
      parts: messageParts as SnapshotPart[],
    } satisfies SnapshotMessage];
  });
}

export function renderSnapshot(
  messages: SnapshotMessage[],
  budget: SnapshotBudget,
): Snapshot {
  const model = inheritModel(messages);
  const bounded = messages
    .filter((message) => message.parts.length > 0)
    .slice(-budget.maxMessages);
  const truncatedMessages = Math.max(0, messages.length - bounded.length);
  const blocks: string[] = [];
  let used = 0;
  let truncatedChars = false;

  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const block = renderMessage(bounded[index]!);
    if (!block) continue;
    if (used + block.length > budget.maxChars && blocks.length > 0) {
      truncatedChars = true;
      break;
    }
    blocks.unshift(block);
    used += block.length;
    if (used >= budget.maxChars) break;
  }

  const header = truncatedMessages > 0
    ? `[... ${truncatedMessages} earlier message${
      truncatedMessages === 1 ? "" : "s"
    } truncated ...]\n`
    : "";
  return {
    text: `${header}${blocks.join("\n\n")}`,
    messageCount: blocks.length,
    truncatedMessages,
    truncatedChars,
    model,
  };
}

export function inheritModel(
  messages: SnapshotMessage[],
): { providerID: string; modelID: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.model;
    if (model?.providerID && model?.modelID) return model;
  }
  return undefined;
}

function renderMessage(message: SnapshotMessage): string {
  const lines: string[] = [];
  for (const part of message.parts) {
    const line = renderPart(part);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return "";
  const role = message.summary
    ? "assistant (compaction summary)"
    : message.role === "user" ? "user" : message.role;
  return `[${role}]\n${lines.join("\n")}`;
}

function renderPart(part: SnapshotPart): string {
  const value = part as {
    type?: unknown;
    text?: unknown;
    synthetic?: unknown;
    tool?: unknown;
    state?: unknown;
  };
  if (value.type === "text") {
    if (value.synthetic === true) return "";
    return typeof value.text === "string" ? value.text.trim() : "";
  }
  if (value.type === "tool") {
    const status = typeof value.state === "string"
      ? value.state
      : typeof value.state === "object" && value.state !== null &&
          "status" in value.state &&
          typeof (value.state as { status?: unknown }).status === "string"
        ? (value.state as { status: string }).status
        : "unknown";
    const marker = TOOL_STATE_RUNNING.has(status) ? " (running)" : "";
    const name = typeof value.tool === "string" ? value.tool : "tool";
    return `[tool ${name}${marker}]`;
  }
  return "";
}
