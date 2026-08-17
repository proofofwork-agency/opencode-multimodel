import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const PROJECT_CONTRACT_CANDIDATES = [
  ".dogfood/dogfood.contract.yaml",
  ".dogfood/dogfood.contract.yml",
  ".dogfood/dogfood.contract.json",
  "dogfood.contract.yaml",
  "dogfood.contract.yml",
  "dogfood.contract.json",
];

export function discoverProjectContract(cwd: string) {
  for (const relativePath of PROJECT_CONTRACT_CANDIDATES) {
    const path = resolve(cwd, relativePath);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function sessionContractPath(
  snapshotDir: string,
  sessionID: string,
  goalID?: string,
) {
  const safe = sessionID.replace(/[^A-Za-z0-9._-]+/g, "_");
  const scope = goalID ? `.${goalID.replace(/[^A-Za-z0-9._-]+/g, "_")}` : "";
  return join(snapshotDir, `${safe}${scope}.contract.yaml`);
}

export function hashContract(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function readContractFile(path: string) {
  return readFileSync(path, "utf8");
}

export function writeFrozenContract(path: string, yaml: string) {
  const text = yaml.endsWith("\n") ? yaml : `${yaml}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  return hashContract(text);
}

export function verifyContractHash(path: string, expected: string) {
  if (!existsSync(path)) return false;
  return hashContract(readContractFile(path)) === expected;
}

export function extractCommandRuns(yaml: string) {
  const runs: string[] = [];
  for (const match of yaml.matchAll(/^\s*run:\s*(.+)$/gm)) {
    const value = unwrapScalar(match[1] ?? "");
    if (value) runs.push(value);
  }
  return runs;
}

export function requiredChecksPresent(yaml: string, required: string[]) {
  const runs = extractCommandRuns(yaml);
  return required.every((check) =>
    runs.some((run) => run === check || run.includes(check))
  );
}

export function contractLooksCompletable(yaml: string) {
  return /class:\s*deterministic/i.test(yaml) &&
    extractCommandRuns(yaml).length > 0 &&
    !/replace this placeholder command/i.test(yaml);
}

export function synthesizeFromChecks(input: {
  project: string;
  objective: string;
  checks: string[];
  timeoutMs: number;
}) {
  if (input.checks.length === 0) {
    return [
      "version: 1",
      `project: ${yamlScalar(input.project)}`,
      "description: Incomplete session contract; no host oracle yet.",
      "commands:",
      "  replace-me:",
      "    run: node -e \"console.error('replace this placeholder command'); process.exit(1)\"",
      "    timeoutMs: 120000",
      "    adapter: exit-code",
      "gates:",
      "  verification: [replace-me]",
      "oracles:",
      "  replace-me-oracle:",
      "    kind: command",
      "    command: replace-me",
      "acceptanceCriteria:",
      "  - id: AC-replace-me",
      "    class: deterministic",
      "    severity: blocker",
      `    text: ${yamlScalar(input.objective)}`,
    ].join("\n");
  }
  const commands = input.checks.map((check, index) => {
    const id = `check-${index + 1}`;
    return { id, check };
  });
  return [
    "version: 1",
    `project: ${yamlScalar(input.project)}`,
    `description: ${yamlScalar(input.objective)}`,
    "commands:",
    ...commands.flatMap(({ id, check }) => [
      `  ${id}:`,
      `    run: ${yamlScalar(check)}`,
      `    timeoutMs: ${input.timeoutMs}`,
      "    adapter: exit-code",
    ]),
    "gates:",
    `  verification: [${commands.map((item) => item.id).join(", ")}]`,
    "oracles:",
    ...commands.flatMap(({ id }) => [
      `  ${id}-oracle:`,
      "    kind: command",
      `    command: ${id}`,
    ]),
    "acceptanceCriteria:",
    ...commands.flatMap(({ id, check }) => [
      `  - id: AC-${id}`,
      "    class: deterministic",
      "    severity: blocker",
      `    oracle: ${id}-oracle`,
      `    text: ${yamlScalar(`User-required check: ${check}`)}`,
    ]),
  ].join("\n");
}

export function resolveUserContractFile(cwd: string, file: string) {
  const resolved = isAbsolute(file) ? file : resolve(cwd, file);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Contract file must stay inside the project directory.");
  }
  if (!existsSync(resolved)) {
    throw new Error(`Contract file not found: ${file}`);
  }
  return resolved;
}

function unwrapScalar(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function yamlScalar(value: string) {
  if (/^[\w./:@-]+$/.test(value) && !value.includes(": ")) return value;
  return JSON.stringify(value);
}
