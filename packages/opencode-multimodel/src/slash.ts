import { COLLAB_MODES, type CollabMode } from "./types.ts";

export type WorkflowSlash =
  | { kind: "workflows" }
  | { kind: "workflow"; args: string };

export type PluginSlash =
  | WorkflowSlash
  | { kind: "collab"; args: string };

const PLUGIN_SLASH = /^\/(workflows?|collab)(?:\s+([\s\S]*))?$/i;

export function parsePluginSlash(text: string): PluginSlash | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(PLUGIN_SLASH);
  if (!match) return;
  const command = match[1]!.toLowerCase();
  const args = match[2]?.trim() ?? "";
  if (command === "workflows") return { kind: "workflows" };
  if (command === "workflow") return { kind: "workflow", args };
  if (command === "collab") return { kind: "collab", args };
}

export function parseWorkflowSlash(text: string): WorkflowSlash | undefined {
  const parsed = parsePluginSlash(text);
  if (parsed?.kind === "workflows" || parsed?.kind === "workflow") return parsed;
}

export function parseCollabSlash(text: string) {
  const parsed = parsePluginSlash(text);
  if (parsed?.kind === "collab") return parsed;
}

export function parseCollabCommand(raw: string, defaultMode: CollabMode) {
  const trimmed = raw.trim();
  if (!trimmed) return { mode: defaultMode, prompt: "" };
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const first = match?.[1] ?? "";
  const rest = (match?.[2] ?? "").trim();
  if ((COLLAB_MODES as readonly string[]).includes(first)) {
    return { mode: first as CollabMode, prompt: rest };
  }
  return { mode: defaultMode, prompt: trimmed };
}
