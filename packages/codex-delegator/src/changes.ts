import { runBounded } from "./process.ts";
import { redactText } from "./redaction.ts";
import type { DelegateChanges } from "./types.ts";

const MAX_PATCH_BYTES = 64_000;

export async function collectWorkspaceChanges(
  cwd: string,
  env: NodeJS.ProcessEnv,
  runCommand: typeof runBounded = runBounded,
): Promise<DelegateChanges | null> {
  const root = await gitRoot(cwd, env, runCommand);
  if (!root) return null;
  const status = await runCommand({
    argv: ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd: root,
    env,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!status || status.exitCode !== 0) return null;
  const files = parsePorcelain(status.stdout).filter(isSafePath);
  const tracked = await runCommand({
    argv: [
      "git",
      "diff",
      "HEAD",
      "--",
      ".",
      ":(exclude,glob).contextrelay/**",
      ":(exclude,glob)**/.contextrelay/**",
    ],
    cwd: root,
    env,
    timeoutMs: 10_000,
    maxBytes: MAX_PATCH_BYTES,
  }).catch(() => null);
  const untracked = await listUntracked(root, env, runCommand);
  for (const file of untracked) {
    if (!files.includes(file)) files.push(file);
  }
  const chunks: string[] = [];
  let remaining = MAX_PATCH_BYTES;
  let truncated = tracked?.overflowed === true;
  if (tracked?.stdout) {
    const chunk = tracked.stdout.replace(/\n?$/, "\n");
    const added = boundedPrefix(chunk, remaining);
    chunks.push(added);
    remaining -= Buffer.byteLength(added);
    if (Buffer.byteLength(chunk) > Buffer.byteLength(added)) truncated = true;
  }
  for (const file of untracked) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const added = await untrackedFileDiff(root, env, file, runCommand);
    if (!added) continue;
    const chunk = added.endsWith("\n") ? added : `${added}\n`;
    const size = Buffer.byteLength(chunk);
    if (size > remaining) {
      chunks.push(boundedPrefix(chunk, remaining));
      truncated = true;
      break;
    }
    chunks.push(chunk);
    remaining -= size;
  }
  const patch = chunks.length
    ? redactText(chunks.join(""), MAX_PATCH_BYTES)
    : null;
  return {
    cwd: root,
    files,
    summary: files.length
      ? `${files.length} changed file${files.length === 1 ? "" : "s"}`
      : "No local changes.",
    patch,
    truncated,
  };
}

async function gitRoot(
  cwd: string,
  env: NodeJS.ProcessEnv,
  runCommand: typeof runBounded,
) {
  const result = await runCommand({
    argv: ["git", "rev-parse", "--show-toplevel"],
    cwd,
    env,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

async function listUntracked(
  cwd: string,
  env: NodeJS.ProcessEnv,
  runCommand: typeof runBounded,
) {
  const listed = await runCommand({
    argv: ["git", "ls-files", "--others", "--exclude-standard", "-z"],
    cwd,
    env,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!listed || listed.exitCode !== 0) return [];
  return listed.stdout
    .split("\0")
    .filter((path) => path && isSafePath(path));
}

async function untrackedFileDiff(
  cwd: string,
  env: NodeJS.ProcessEnv,
  file: string,
  runCommand: typeof runBounded,
) {
  const diff = await runCommand({
    argv: ["git", "diff", "--no-index", "--", "/dev/null", file],
    cwd,
    env,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (diff && (diff.stdout || diff.stderr)) {
    return diff.stdout || null;
  }
  const body = await Bun.file(`${cwd}/${file}`)
    .text()
    .catch(() => null);
  if (body === null) return null;
  const lines = body.split(/\n/);
  const numbered = lines
    .map((line, index) =>
      index === lines.length - 1 && line === "" ? null : `+${line}`,
    )
    .filter((line): line is string => line !== null);
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${numbered.length} @@`,
    ...numbered,
    "",
  ].join("\n");
}

function parsePorcelain(stdout: string) {
  const files = new Set<string>();
  const entries = stdout.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const line = entries[index]!;
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3);
    if (path) files.add(path);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return [...files];
}

function isSafePath(path: string) {
  return !path.split("/").includes(".contextrelay");
}

function boundedPrefix(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let prefix = Buffer.from(value).subarray(0, maxBytes).toString("utf8");
  while (prefix && Buffer.byteLength(prefix) > maxBytes) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}
