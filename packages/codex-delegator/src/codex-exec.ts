import { DelegateEventCollector, EMPTY_USAGE } from "./events.ts";
import { commandError, runBounded } from "./process.ts";
import type {
  DelegateApprovalPolicy,
  DelegateEvent,
  DelegateMode,
  DelegateTurnResult,
} from "./types.ts";

export async function runCodexExec(input: {
  executable?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  model: string | null;
  reasoningEffort?: string;
  mode: DelegateMode;
  approvalPolicy: DelegateApprovalPolicy;
  nativeThreadId: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: DelegateEvent) => void;
}) {
  const startedAt = Date.now();
  const collector = new DelegateEventCollector({ onEvent: input.onEvent });
  const argv = codexExecArgv(input);
  const result = await runBounded({
    argv,
    cwd: input.cwd,
    env: input.env,
    stdin: `${input.prompt}\n`,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => {
      try {
        collector.push(JSON.parse(line));
      } catch {
        collector.markMalformed();
      }
    });
  const snapshot = collector.snapshot();
  const error =
    result.exitCode === 0 ? null : commandError(result, "Codex exec turn");
  const status = result.cancelled
    ? "cancelled"
    : snapshot.status === "rate-limited"
      ? "rate-limited"
      : result.exitCode === 0 && snapshot.status !== "failed"
        ? "completed"
        : "failed";
  return {
    id: crypto.randomUUID(),
    status,
    output: snapshot.output,
    events: snapshot.events,
    usage: snapshot.usage ?? { ...EMPTY_USAGE },
    threadId: snapshot.threadId ?? input.nativeThreadId,
    turnId: snapshot.turnId,
    startedAt,
    completedAt: Date.now(),
    malformedEvents: snapshot.malformed,
    truncated: snapshot.truncated || result.overflowed,
    error: error
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : null,
  } satisfies DelegateTurnResult;
}

export function codexExecArgv(input: {
  executable?: string;
  cwd: string;
  model: string | null;
  reasoningEffort?: string;
  mode: DelegateMode;
  approvalPolicy: DelegateApprovalPolicy;
  nativeThreadId: string | null;
}) {
  const argv = input.nativeThreadId
    ? [
        input.executable ?? "codex",
        "exec",
        "resume",
        input.nativeThreadId,
        "--json",
        "--skip-git-repo-check",
        "--strict-config",
      ]
    : [
        input.executable ?? "codex",
        "exec",
        "--json",
        "--sandbox",
        input.mode === "write" ? "workspace-write" : "read-only",
        "--cd",
        input.cwd,
        "--skip-git-repo-check",
        "--strict-config",
      ];
  if (input.approvalPolicy === "bypass" && input.mode === "write")
    argv.push("--dangerously-bypass-approvals-and-sandbox");
  else {
    // The non-interactive fallback cannot surface approvals. Keep sandbox
    // boundaries, reject escalation, and advertise approvals=false.
    argv.push("-c", 'approval_policy="never"');
    if (input.nativeThreadId)
      argv.push(
        "-c",
        `sandbox_mode=${JSON.stringify(input.mode === "write" ? "workspace-write" : "read-only")}`,
      );
  }
  if (input.model) argv.push("--model", checkedOption(input.model, "model"));
  if (input.reasoningEffort)
    argv.push(
      "-c",
      `model_reasoning_effort=${JSON.stringify(checkedOption(input.reasoningEffort, "reasoning effort"))}`,
    );
  argv.push("-");
  return argv;
}

function checkedOption(value: string, label: string) {
  if (!value || value.startsWith("-") || value.includes("\0") || /[\r\n]/.test(value))
    throw new Error(`Invalid delegate ${label}.`);
  return value;
}
