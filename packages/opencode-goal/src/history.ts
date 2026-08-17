import type { Goal, GoalCheckpoint, GoalHistoryEntry, GoalHistoryType } from "./types.ts";

export const MAX_HISTORY_ENTRIES = 50;
export const MAX_CHECKPOINTS = 8;
const CHECKPOINT_CHAR_LIMIT = 280;

export function pushHistory(
  goal: Goal,
  type: GoalHistoryType,
  detail: string,
  timestamp = Date.now(),
): Goal {
  const entry: GoalHistoryEntry = {
    type,
    detail: detail.trim().slice(0, 500),
    timestamp,
  };
  return {
    ...goal,
    history: [...goal.history, entry].slice(-MAX_HISTORY_ENTRIES),
    updatedAt: timestamp,
  };
}

export function recordCheckpoint(goal: Goal, text: string, timestamp = Date.now()) {
  const summary = text.trim().replace(/\s+/g, " ").slice(0, CHECKPOINT_CHAR_LIMIT);
  if (!summary || goal.lastCheckpoint?.summary === summary) return goal;
  const checkpoint: GoalCheckpoint = { summary, timestamp };
  return pushHistory({
    ...goal,
    lastCheckpoint: checkpoint,
    checkpoints: [...goal.checkpoints, checkpoint].slice(-MAX_CHECKPOINTS),
  }, "checkpoint", summary, timestamp);
}

export function formatHistory(goal: Goal | undefined) {
  if (!goal) return "No goal history is available for this session.";
  if (goal.history.length === 0) return "No goal history recorded yet.";
  return goal.history.map((entry) =>
    `- [${new Date(entry.timestamp).toISOString()}] ${entry.type}: ${entry.detail}`
  ).join("\n");
}

export function parseHistory(raw: string | null | undefined): GoalHistoryEntry[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const type = (item as { type?: unknown }).type;
      const detail = (item as { detail?: unknown }).detail;
      const timestamp = (item as { timestamp?: unknown }).timestamp;
      if (typeof type !== "string" || typeof detail !== "string") return [];
      if (typeof timestamp !== "number") return [];
      return [{ type: type as GoalHistoryType, detail, timestamp }];
    });
  } catch {
    return [];
  }
}

export function parseCheckpoints(raw: string | null | undefined): GoalCheckpoint[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const summary = (item as { summary?: unknown }).summary;
      const timestamp = (item as { timestamp?: unknown }).timestamp;
      if (typeof summary !== "string" || typeof timestamp !== "number") return [];
      return [{ summary, timestamp }];
    });
  } catch {
    return [];
  }
}
