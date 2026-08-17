import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type DogfoodVerdict = "pass" | "fail" | "infra" | "missing";

export type DogfoodResult = {
  verdict: DogfoodVerdict;
  reason: string;
  output: string;
};

const pluginRequire = createRequire(import.meta.url);

export function resolveDogfoodBin(cwd?: string) {
  const candidates = [
    binFromRequire(pluginRequire),
    cwd ? binFromRequire(createRequire(join(cwd, "package.json"))) : undefined,
    cwd
      ? join(cwd, "node_modules", "@proofofwork-agency", "dogfood", "bin", "dogfood.mjs")
      : undefined,
  ];
  return candidates.find((path) => path && existsSync(path));
}

function binFromRequire(require: NodeJS.Require) {
  try {
    const pkg = require.resolve("@proofofwork-agency/dogfood/package.json");
    const bin = join(dirname(pkg), "bin", "dogfood.mjs");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

export async function runDogfood(input: {
  cwd: string;
  contractPath: string;
  timeoutMs: number;
  command: "validate" | "run";
  bin?: string;
  spawn?: typeof runProcess;
}): Promise<DogfoodResult> {
  const bin = input.bin ?? resolveDogfoodBin(input.cwd);
  if (!bin) {
    return {
      verdict: "missing",
      reason: "Bundled Dogfood CLI could not be resolved from opencode-goal.",
      output: "",
    };
  }
  const runner = input.spawn ?? runProcess;
  const args = [
    bin,
    input.command,
    "--contract",
    input.contractPath,
    "--cwd",
    input.cwd,
    "--json",
  ];
  if (input.command === "run") {
    args.push("--timeout-ms", String(input.timeoutMs));
  }
  const result = await runner(
    process.execPath,
    args,
    input.cwd,
    input.timeoutMs + 5_000,
  );
  if (result.code === 0) {
    return { verdict: "pass", reason: `${input.command} passed.`, output: result.output };
  }
  if (result.code === 2) {
    return {
      verdict: "infra",
      reason: `Dogfood ${input.command} hit an infrastructure error.`,
      output: result.output,
    };
  }
  return {
    verdict: "fail",
    reason: `Dogfood ${input.command} failed (exit ${result.code ?? "timeout"}).`,
    output: result.output,
  };
}

export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, timeout: timeoutMs });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", (code) => {
      resolvePromise({ code, output: output.trim().slice(0, 8_000) });
    });
    child.on("error", (error) => {
      resolvePromise({ code: null, output: error.message });
    });
  });
}
