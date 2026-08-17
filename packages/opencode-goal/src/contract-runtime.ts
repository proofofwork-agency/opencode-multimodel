import { contractAuthorPrompt, extractYamlDocument } from "./contract-author.ts";
import {
  contractLooksCompletable,
  discoverProjectContract,
  readContractFile,
  requiredChecksPresent,
  resolveUserContractFile,
  sessionContractPath,
  synthesizeFromChecks,
  writeFrozenContract,
} from "./contract.ts";
import { runDogfood } from "./dogfood.ts";
import { auditCompletion, type EvidenceClaim } from "./evidence.ts";
import { pushHistory } from "./history.ts";
import type { GoalOptions } from "./options.ts";
import type { GoalClient } from "./opencode.ts";
import { formatContractStatus } from "./prompts.ts";
import { resolvePath } from "./store.ts";
import type { Goal } from "./types.ts";
import type { JudgeResult } from "./judge.ts";

export type ContractRuntimeOptions = GoalOptions & {
  directory: string;
  client?: GoalClient;
  runHostCheck?: typeof import("./evidence.ts").runCheck;
  authorContract?: (input: {
    goal: Goal;
    prompt: string;
  }) => Promise<string | undefined>;
  runDogfood?: typeof runDogfood;
  evaluate?: (input: {
    goal: Goal;
    transcript: string;
    hostAudit?: string;
    evidence?: string;
    contract?: string;
  }) => Promise<JudgeResult | undefined>;
};

export async function applyUserContract(input: {
  goal: Goal;
  file?: string;
  options: ContractRuntimeOptions;
  persist: (goal: Goal) => Goal;
}) {
  const source = input.file
    ? resolveUserContractFile(input.options.directory, input.file)
    : input.goal.contractPath ?? sessionContractPath(
      resolvePath(input.options.directory, input.options.snapshotDir),
      input.goal.sessionID,
      input.goal.goalID,
    );
  const yaml = readContractFile(source);
  if (!requiredChecksPresent(yaml, input.goal.requiredChecks)) {
    throw new Error("Contract apply dropped a user-required --check oracle.");
  }
  const frozenPath = sessionContractPath(
    resolvePath(input.options.directory, input.options.snapshotDir),
    input.goal.sessionID,
    input.goal.goalID,
  );
  const hash = writeFrozenContract(frozenPath, yaml);
  const next = input.persist(pushHistory({
    ...input.goal,
    contractPath: frozenPath,
    contractHash: hash,
    completable: contractLooksCompletable(yaml),
  }, "contract_revised", `${input.goal.contractHash ?? "none"} -> ${hash}`));
  return formatContractStatus(next);
}

export async function freezeGoalContract(input: {
  goal: Goal;
  options: ContractRuntimeOptions;
  persist: (goal: Goal) => Goal;
}) {
  if (!input.goal.dogfood) {
    return input.persist(pushHistory({
      ...input.goal,
      completable: true,
    }, "updated", "Dogfood disabled; host checks and the judge still apply."));
  }
  const dest = sessionContractPath(
    resolvePath(input.options.directory, input.options.snapshotDir),
    input.goal.sessionID,
    input.goal.goalID,
  );
  const project = discoverProjectContract(input.options.directory);
  let yaml = project ? readContractFile(project) : undefined;
  const authored = await authorYaml(input.goal, yaml, input.options);
  if (authored) yaml = authored;
  if (!yaml || !requiredChecksPresent(yaml, input.goal.requiredChecks)) {
    yaml = synthesizeFromChecks({
      project: "opencode-goal",
      objective: input.goal.objective,
      checks: input.goal.requiredChecks,
      timeoutMs: input.options.checkTimeoutMs,
    });
  }
  const hash = writeFrozenContract(dest, yaml);
  const completable = contractLooksCompletable(yaml) &&
    requiredChecksPresent(yaml, input.goal.requiredChecks);
  return input.persist(pushHistory({
    ...input.goal,
    contractPath: dest,
    contractHash: hash,
    completable,
  }, project ? "contract_bound" : "created", completable
    ? `Frozen contract ${hash.slice(0, 12)}`
    : "Contract is not completable yet."));
}

export async function proveHost(input: {
  goal: Goal;
  claim: EvidenceClaim;
  options: ContractRuntimeOptions;
  persist: (goal: Goal) => Goal;
}) {
  if (input.goal.dogfood && input.goal.contractPath && input.goal.completable) {
    const runner = input.options.runDogfood ?? runDogfood;
    const validated = await runner({
      cwd: input.options.directory,
      contractPath: input.goal.contractPath,
      timeoutMs: input.options.checkTimeoutMs,
      command: "validate",
    });
    if (validated.verdict === "fail" || validated.verdict === "infra") {
      return { approved: false, reason: validated.reason };
    }
    if (validated.verdict === "pass") {
      const ran = await runner({
        cwd: input.options.directory,
        contractPath: input.goal.contractPath,
        timeoutMs: input.options.checkTimeoutMs,
        command: "run",
      });
      if (ran.verdict === "pass") return { approved: true, reason: ran.reason };
      if (ran.verdict === "infra") {
        input.persist({
          ...input.goal,
          status: "paused",
          pauseReason: "blocked",
          blocker: ran.reason,
        });
        return { approved: false, reason: ran.reason };
      }
      if (ran.verdict === "fail") return { approved: false, reason: ran.reason };
    }
  }
  return auditCompletion(input.goal, input.claim, {
    cwd: input.options.directory,
    timeoutMs: input.options.checkTimeoutMs,
    runHostChecks: input.options.runHostChecks,
    requireHostProof: input.options.requireHostProof,
    run: input.options.runHostCheck,
  });
}

async function authorYaml(
  goal: Goal,
  projectContract: string | undefined,
  options: ContractRuntimeOptions,
) {
  const prompt = contractAuthorPrompt({
    objective: goal.objective,
    verification: goal.verification,
    constraints: goal.constraints,
    requiredChecks: goal.requiredChecks,
    projectContract,
  });
  try {
    const raw = options.authorContract
      ? await options.authorContract({ goal, prompt })
      : options.client?.author
      ? await options.client.author(prompt)
      : undefined;
    return raw ? extractYamlDocument(raw) : undefined;
  } catch {
    return undefined;
  }
}

export type { GoalClient };
