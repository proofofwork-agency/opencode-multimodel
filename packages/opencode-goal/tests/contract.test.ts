import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractYamlDocument } from "../src/contract-author.ts";
import {
  contractLooksCompletable,
  discoverProjectContract,
  hashContract,
  requiredChecksPresent,
  synthesizeFromChecks,
  verifyContractHash,
  writeFrozenContract,
} from "../src/contract.ts";
import { GoalService } from "../src/engine.ts";
import { parseOptions } from "../src/options.ts";

test("synthesizes a completable contract from user checks and refuses dropping them", () => {
  const yaml = synthesizeFromChecks({
    project: "demo",
    objective: "ship",
    checks: ["npm test"],
    timeoutMs: 120000,
  });
  expect(contractLooksCompletable(yaml)).toBe(true);
  expect(requiredChecksPresent(yaml, ["npm test"])).toBe(true);
  expect(requiredChecksPresent(yaml, ["npm run e2e"])).toBe(false);
});

test("incomplete synthesis is not completable", () => {
  const yaml = synthesizeFromChecks({
    project: "demo",
    objective: "ship",
    checks: [],
    timeoutMs: 120000,
  });
  expect(contractLooksCompletable(yaml)).toBe(false);
});

test("binds a project dogfood contract without rewriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  await mkdir(join(directory, ".dogfood"), { recursive: true });
  const original = synthesizeFromChecks({
    project: "demo",
    objective: "ship",
    checks: ["npm test"],
    timeoutMs: 1_000,
  });
  const path = join(directory, ".dogfood", "dogfood.contract.yaml");
  await writeFile(path, original);
  expect(discoverProjectContract(directory)).toBe(path);
  const service = new GoalService({
    ...parseOptions({
      databasePath: join(directory, "goal.sqlite"),
      snapshotDir: join(directory, "goals"),
    }),
    directory,
  });
  await service.apply("ses", {
    action: "set",
    objective: "ship",
    checks: ["npm test"],
  }, { start: false });
  const goal = service.get("ses")!;
  expect(goal.completable).toBe(true);
  expect(goal.contractHash).toBe(
    hashContract(original.endsWith("\n") ? original : `${original}\n`),
  );
  expect(await Bun.file(path).text()).toBe(original);
  service.close();
});

test("human contract apply re-hashes and model tools cannot drop required checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const service = new GoalService({
    ...parseOptions({
      databasePath: join(directory, "goal.sqlite"),
      snapshotDir: join(directory, "goals"),
    }),
    directory,
  });
  await service.apply("ses", {
    action: "set",
    objective: "ship",
    checks: ["npm test"],
  }, { start: false });
  const goal = service.get("ses")!;
  const weak = synthesizeFromChecks({
    project: "demo",
    objective: "ship",
    checks: ["true"],
    timeoutMs: 1_000,
  });
  await writeFile(join(directory, "weak.yaml"), weak);
  await expect(service.apply("ses", {
    action: "contract-apply",
    file: "weak.yaml",
  })).rejects.toThrow("user-required");
  expect(service.get("ses")?.contractHash).toBe(goal.contractHash);
  const next = synthesizeFromChecks({
    project: "demo",
    objective: "ship harder",
    checks: ["npm test"],
    timeoutMs: 1_000,
  });
  await writeFile(goal.contractPath!, next);
  const status = await service.apply("ses", { action: "contract-apply" });
  expect(status).toContain("Completable: yes");
  expect(service.get("ses")?.contractHash).toBe(
    hashContract(next.endsWith("\n") ? next : `${next}\n`),
  );
  expect(verifyContractHash(goal.contractPath!, service.get("ses")!.contractHash!)).toBe(true);
  service.close();
});

test("hash mismatch refuses completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const service = new GoalService({
    ...parseOptions({
      databasePath: join(directory, "goal.sqlite"),
      snapshotDir: join(directory, "goals"),
    }),
    directory,
    evaluate: async () => ({ verdict: "met", reason: "ok" }),
  });
  await service.apply("ses", {
    action: "set",
    objective: "ship",
    checks: ["npm test"],
  }, { start: false });
  const goal = service.get("ses")!;
  await writeFile(goal.contractPath!, `${goal.contractPath}\ntampered\n`);
  const result = await service.completeFromModel("ses", {
    evidence: "Ran npm test and everything passed cleanly.",
  });
  expect(result.approved).toBe(false);
  expect(result.reason).toContain("hash mismatch");
  expect(service.get("ses")?.pauseReason).toBe("audit");
  service.close();
});

test("extracts yaml from author prose", () => {
  const yaml = extractYamlDocument(
    "sure\n```yaml\nversion: 1\ncommands:\n  test:\n    run: npm test\nacceptanceCriteria: []\n```\n",
  );
  expect(yaml).toContain("run: npm test");
});

test("author session output is frozen by the plugin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-goal-"));
  const yaml = synthesizeFromChecks({
    project: "demo",
    objective: "ship",
    checks: ["npm test"],
    timeoutMs: 1_000,
  });
  const service = new GoalService({
    ...parseOptions({
      databasePath: join(directory, "goal.sqlite"),
      snapshotDir: join(directory, "goals"),
    }),
    directory,
    authorContract: async () => `here you go\n\`\`\`yaml\n${yaml}\n\`\`\``,
  });
  await service.apply("ses", {
    action: "set",
    objective: "ship",
    checks: ["npm test"],
  }, { start: false });
  expect(service.get("ses")?.completable).toBe(true);
  expect(await Bun.file(service.get("ses")!.contractPath!).text()).toContain(
    "npm test",
  );
  service.close();
});
