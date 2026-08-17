import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { Goal } from "./types.ts";

export type EvidenceClaim = {
  summary?: string;
  evidence?: string;
  criteria?: Array<{ criterion?: string; evidence?: string[] }>;
  checks?: Array<{ command?: string; result?: string }>;
};

export type HostCheckResult = {
  command: string;
  ok: boolean;
  code: number | null;
  output: string;
};

export type CompletionAudit = {
  approved: boolean;
  reason: string;
  checks: HostCheckResult[];
  citedFiles: string[];
};

export function inspectClaim(goal: Goal, claim: EvidenceClaim): CompletionAudit {
  void goal;
  const failed = (claim.checks ?? []).find((item) => item.result === "failed");
  if (failed) {
    return fail(`Completion cannot include a failed check: ${failed.command ?? "unnamed"}.`);
  }
  const evidence = serializeClaim(claim);
  if (!evidence) {
    return fail("Completion requires concrete evidence, not an empty claim.");
  }
  if (evidence.length < 24) {
    return fail("Completion evidence is too thin to audit.");
  }
  return {
    approved: true,
    reason: evidence,
    checks: [],
    citedFiles: citedFiles(evidence),
  };
}

export function serializeClaim(claim: EvidenceClaim) {
  const lines = [
    claim.summary?.trim(),
    claim.evidence?.trim(),
    ...(claim.criteria ?? []).flatMap((item) => {
      const criterion = item.criterion?.trim();
      const evidence = (item.evidence ?? []).map((value) => value.trim()).filter(Boolean);
      if (!criterion || evidence.length === 0) return [];
      return [`${criterion}: ${evidence.join("; ")}`];
    }),
  ].filter(Boolean);
  return lines.join("\n");
}

export async function auditCompletion(
  goal: Goal,
  claim: EvidenceClaim,
  options: {
    cwd: string;
    timeoutMs: number;
    runHostChecks: boolean;
    requireHostProof: boolean;
    run?: typeof runCheck;
  },
): Promise<CompletionAudit> {
  const local = inspectClaim(goal, claim);
  if (!local.approved) return local;

  const checks: HostCheckResult[] = [];
  if (options.runHostChecks && goal.checks.length > 0) {
    const runner = options.run ?? runCheck;
    for (const command of goal.checks) {
      const result = await runner(command, options.cwd, options.timeoutMs);
      checks.push(result);
      if (!result.ok) {
        return {
          approved: false,
          reason:
            `Host check failed: ${command} (exit ${result.code ?? "timeout"})`,
          checks,
          citedFiles: local.citedFiles,
        };
      }
    }
  }

  if (!options.requireHostProof) {
    return { ...local, checks, approved: true };
  }

  if (goal.checks.length > 0) {
    return {
      approved: true,
      reason: local.reason,
      checks,
      citedFiles: local.citedFiles,
    };
  }

  const existing = local.citedFiles.filter((file) =>
    fileExistsInProject(options.cwd, file)
  );
  if (existing.length === 0) {
    return {
      approved: false,
      reason:
        "Completion needs a --check command or evidence that cites an existing project file.",
      checks,
      citedFiles: local.citedFiles,
    };
  }
  return {
    approved: true,
    reason: local.reason,
    checks,
    citedFiles: existing,
  };
}

export function formatAudit(audit: CompletionAudit) {
  const checks = audit.checks.map((check) =>
    `${check.ok ? "pass" : "fail"} ${check.command}`
  );
  return [
    audit.reason,
    checks.length > 0 ? `Checks: ${checks.join("; ")}` : undefined,
    audit.citedFiles.length > 0
      ? `Cited files: ${audit.citedFiles.join(", ")}`
      : undefined,
  ].filter(Boolean).join("\n");
}

export function citedFiles(evidence: string) {
  const matches = evidence.match(
    /(?:^|[\s`'"(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.[A-Za-z0-9]+)/g,
  ) ?? [];
  return [...new Set(
    matches
      .map((match) => match.replace(/^[`'"( \t]+/, "").trim())
      .filter((file) =>
        !file.startsWith("http") &&
        file.includes(".") &&
        file.length < 240
      ),
  )];
}

export function fileExistsInProject(cwd: string, file: string) {
  const resolved = isAbsolute(file) ? file : resolve(cwd, file);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return existsSync(resolved);
}

export function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<HostCheckResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", (code) => {
      resolvePromise({
        command,
        ok: code === 0,
        code,
        output: output.trim().slice(0, 4_000),
      });
    });
    child.on("error", (error) => {
      resolvePromise({
        command,
        ok: false,
        code: null,
        output: error.message,
      });
    });
  });
}

function fail(reason: string): CompletionAudit {
  return { approved: false, reason, checks: [], citedFiles: [] };
}
