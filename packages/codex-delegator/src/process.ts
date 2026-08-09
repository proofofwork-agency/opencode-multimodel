import { DelegatorError } from "./errors.ts";

export async function runBounded(input: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
}) {
  input.signal?.throwIfAborted();
  const child = Bun.spawn(input.argv, {
    cwd: input.cwd,
    env: input.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  if (input.stdin) child.stdin.write(input.stdin);
  child.stdin.end();
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort("timeout"),
    input.timeoutMs,
  );
  timeout.unref?.();
  const stop = () => terminateProcess(child);
  controller.signal.addEventListener("abort", stop, { once: true });
  const budget = { remaining: input.maxBytes ?? 1_000_000, overflow: false };
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, budget, stop),
      readBounded(child.stderr, budget, stop),
      child.exited,
    ]);
    return {
      stdout,
      stderr,
      exitCode,
      signal: child.signalCode,
      cancelled: input.signal?.aborted === true,
      timedOut: controller.signal.aborted && !input.signal?.aborted,
      overflowed: budget.overflow,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
    await terminateProcess(child);
  }
}

export async function terminateProcess(child: Bun.Subprocess) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), 500);
      timer.unref?.();
    }),
  ]);
  if (exited) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await Promise.race([
    child.exited,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
    }),
  ]);
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  budget: { remaining: number; overflow: boolean },
  overflow: () => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const output: string[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength <= budget.remaining) {
        budget.remaining -= next.value.byteLength;
        output.push(decoder.decode(next.value, { stream: true }));
        continue;
      }
      if (budget.remaining > 0) {
        output.push(
          decoder.decode(next.value.subarray(0, budget.remaining), {
            stream: true,
          }),
        );
      }
      budget.remaining = 0;
      budget.overflow = true;
      overflow();
      break;
    }
  } finally {
    reader.releaseLock();
  }
  output.push(decoder.decode());
  return output.join("");
}

export function commandError(
  result: Awaited<ReturnType<typeof runBounded>>,
  label: string,
) {
  if (result.cancelled)
    return new DelegatorError("CANCELLED", `${label} was cancelled.`);
  if (result.timedOut)
    return new DelegatorError("TIMED_OUT", `${label} timed out.`, true);
  if (result.overflowed)
    return new DelegatorError(
      "OUTPUT_OVERFLOW",
      `${label} exceeded its output bound.`,
    );
  return new DelegatorError(
    "TRANSPORT_ERROR",
    `${label} exited ${result.exitCode}: ${result.stderr.trim().slice(0, 2_048) || "no diagnostic"}`,
  );
}
