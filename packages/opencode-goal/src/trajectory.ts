import type { SessionTurn } from "./opencode.ts";

export const MAX_TOOL_TRACE = 12;
const ARG_SNIPPET_LENGTH = 80;

export type LoopPattern =
  | { kind: "repeat"; fingerprint: string; count: number }
  | { kind: "cycle"; fingerprints: string[]; count: number }
  ;

export type LoopDetection = {
  pattern: LoopPattern;
  description: string;
};

/**
 * Deterministic trajectory detector for repeated tool usage.
 *
 * Two layers:
 * 1. Pure cycle detection over the tool-fingerprint trace (repeat,
 *    period-2 ping-pong, period-3 cycles).
 * 2. Progress exemption: a repeating tool cycle only counts as a loop when
 *    the worker's recorded checkpoints stopped evolving. Legitimate
 *    iteration cycles (build -> test -> fix with changing output) produce
 *    evolving checkpoints and are exempt.
 */
export function detectToolLoop(input: {
  toolTrace: string[];
  checkpoints: string[];
  currentTranscript?: string;
}): LoopDetection | undefined {
  const pure = detectPureCycle(input.toolTrace);
  if (!pure) return undefined;
  if (checkpointsEvolving(input.checkpoints, input.currentTranscript)) {
    return undefined;
  }
  return {
    pattern: pure,
    description: describePattern(pure),
  };
}

export function detectPureCycle(trace: string[]): LoopPattern | undefined {
  const tail = trace.slice(-MAX_TOOL_TRACE);
  for (const period of [1, 2, 3] as const) {
    const pattern = cycleAtPeriod(tail, period);
    if (pattern) return pattern;
  }
  return undefined;
}

function cycleAtPeriod(
  trace: string[],
  period: 1 | 2 | 3,
): LoopPattern | undefined {
  const minRepeats = period === 1 ? 3 : period === 2 ? 3 : 2;
  const minEntries = period * minRepeats;
  if (trace.length < minEntries) return undefined;
  const tail = trace.slice(-minEntries);
  const base = tail.slice(0, period);
  for (let index = period; index < tail.length; index += 1) {
    if (tail[index] !== base[index % period]) return undefined;
  }
  if (period === 1) {
    return { kind: "repeat", fingerprint: base[0]!, count: tail.length };
  }
  if (new Set(base).size < period) return undefined;
  return { kind: "cycle", fingerprints: base, count: tail.length };
}

function checkpointsEvolving(
  checkpoints: string[],
  currentTranscript?: string,
): boolean {
  const recent = checkpoints.slice(-3).map((value) => normalize(value));
  // Distinct recent checkpoints are positive evidence of progress.
  if (recent.length >= 2 && new Set(recent).size >= 2) return true;
  const last = recent.at(-1);
  if (last !== undefined && currentTranscript !== undefined) {
    // Otherwise compare the current output with the last checkpoint:
    // identical output on a repeating tool cycle is stagnation.
    return last !== normalize(currentTranscript);
  }
  // No checkpoint evidence yet: not positive proof of stagnation, keep
  // working (the judge gate will produce checkpoints soon).
  return true;
}

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 160);
}

function describePattern(pattern: LoopPattern): string {
  if (pattern.kind === "repeat") {
    return `Repeated the same tool call ${pattern.count} times in a row (${pattern.fingerprint}).`;
  }
  return `Repeated tool cycle ${pattern.count} times (${pattern.fingerprints.join(" -> ")}).`;
}

/**
 * Extracts one fingerprint per tool invocation from a turn's parts:
 * `toolname:arg-snippet`. Non-tool turns produce no fingerprints.
 */
export function toolFingerprints(turn: SessionTurn): string[] {
  const fingerprints: string[] = [];
  for (const part of turn.parts) {
    const fingerprint = fingerprintPart(part);
    if (fingerprint) fingerprints.push(fingerprint);
  }
  return fingerprints;
}

function fingerprintPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const record = part as Record<string, unknown>;
  const type = String(record.type ?? "");
  if (type !== "tool" && type !== "tool-call" && type !== "tool-result" &&
    !("tool" in record) && !("toolName" in record)
  ) return undefined;
  const name = String(
    record.tool ?? record.toolName ?? record.name ?? "tool",
  );
  const args = toolArgs(record);
  if (args === undefined) return name;
  const snippet = String(args).replace(/\s+/g, " ").trim()
    .slice(0, ARG_SNIPPET_LENGTH);
  return snippet ? `${name}: ${snippet}` : name;
}

function toolArgs(record: Record<string, unknown>): unknown {
  const args = record.args ?? record.input ?? record.arguments ??
    record.command ?? record.state;
  if (args === null || args === undefined) return undefined;
  if (typeof args === "string") return args;
  if (typeof args === "object") {
    try {
      return JSON.stringify(args);
    } catch {
      return undefined;
    }
  }
  return String(args);
}

export function appendTrace(trace: string[], fingerprints: string[]): string[] {
  return [...trace, ...fingerprints].slice(-MAX_TOOL_TRACE);
}
