import type { Goal, JudgeVerdictName } from "./types.ts";
import { JUDGE_VERDICTS } from "./types.ts";

export type JudgeResult = {
  verdict: JudgeVerdictName;
  reason: string;
};

export type JudgeInput = {
  goal: Goal;
  transcript: string;
  hostAudit?: string;
  evidence?: string;
  contract?: string;
};

export function judgePrompt(input: JudgeInput) {
  return [
    "You are an independent goal evaluator. You do not do the work.",
    "Judge only whether the completion condition holds from the evidence below.",
    "Return exactly one JSON object and nothing else:",
    '{"verdict":"not_met"|"met"|"impossible","reason":"short reason"}',
    "",
    "Rules:",
    "- met: every explicit requirement is proven by current evidence. Uncertainty is not met.",
    "- not_met: work remains, evidence is missing, or host checks failed.",
    "- impossible: the condition can never be satisfied under the stated constraints.",
    "- Ignore intent, effort, and the worker claiming it is done.",
    "",
    `Objective:\n${input.goal.objective}`,
    input.goal.verification ? `Verification:\n${input.goal.verification}` : "",
    input.goal.constraints ? `Constraints:\n${input.goal.constraints}` : "",
    input.goal.checks.length > 0
      ? `Host checks:\n${input.goal.checks.join("\n")}`
      : "",
    input.contract ? `Frozen Dogfood contract:\n${input.contract}` : "",
    input.hostAudit ? `Host audit:\n${input.hostAudit}` : "",
    input.evidence ? `Worker evidence:\n${input.evidence}` : "",
    input.transcript ? `Latest worker output:\n${input.transcript}` : "",
  ].filter(Boolean).join("\n\n");
}

export function parseJudgeOutput(text: string): JudgeResult {
  const json = extractJson(text);
  const verdict = typeof json?.verdict === "string"
    ? json.verdict.trim().toLowerCase().replace("-", "_")
    : "";
  const reason = typeof json?.reason === "string"
    ? json.reason.trim()
    : "";
  if (JUDGE_VERDICTS.includes(verdict as JudgeVerdictName) && reason) {
    return { verdict: verdict as JudgeVerdictName, reason };
  }
  const line = text.trim().match(
    /(?:^|\n)\s*(?:verdict\s*[:=]\s*)?(met|not[_\s-]?met|impossible)\s*[.!]?\s*(?:\n|$)/i,
  );
  if (line) {
    const fallback = line[1]!.toLowerCase().replace(/[\s_-]+/g, "_")
      .replace("notmet", "not_met");
    if (JUDGE_VERDICTS.includes(fallback as JudgeVerdictName)) {
      return {
        verdict: fallback as JudgeVerdictName,
        reason: `Judge verdict line: ${line[1]}`,
      };
    }
  }
  return {
    verdict: "not_met",
    reason: text.trim()
      ? "Judge output was unusable; treating the goal as not met."
      : "Judge returned no text.",
  };
}

function extractJson(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/\{[\s\S]*\}/);
  if (!fenced) return undefined;
  try {
    return JSON.parse(fenced[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
