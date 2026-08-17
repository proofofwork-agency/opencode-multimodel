import type { PluginOptions } from "@opencode-ai/plugin";

export type BtwModelSelection = "inherit" | "small" | { providerID: string; modelID: string };

export type BtwOptions = {
  model: BtwModelSelection;
  maxMessages: number;
  maxChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  history: number;
  concurrency: number;
  tool: boolean;
  notify: boolean;
};

export const BTW_MODEL_INHERIT: BtwModelSelection = "inherit";

export function parseOptions(
  rawOptions: PluginOptions | undefined,
): BtwOptions {
  const options = rawOptions ?? {};
  return {
    model: modelOption(options.model),
    maxMessages: integerOption(options.maxMessages, 40, 5, 200),
    maxChars: integerOption(options.maxChars, 48_000, 5_000, 200_000),
    maxOutputTokens: integerOption(options.maxOutputTokens, 2_048, 256, 8_192),
    timeoutMs: integerOption(options.timeoutMs, 60_000, 1_000, 300_000),
    history: integerOption(options.history, 10, 0, 50),
    concurrency: integerOption(options.concurrency, 1, 1, 3),
    tool: options.tool === true,
    notify: options.notify === true,
  };
}

export function parseModelRef(value: string): { providerID: string; modelID: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

function modelOption(value: unknown): BtwModelSelection {
  if (typeof value !== "string") return "inherit";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "inherit") return "inherit";
  if (trimmed === "small") return "small";
  return parseModelRef(trimmed) ?? "inherit";
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
