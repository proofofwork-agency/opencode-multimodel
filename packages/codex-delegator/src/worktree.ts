import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DelegatorError } from "./errors.ts";
import { commandError, runBounded } from "./process.ts";

export async function ensureManagedWorktree(
  cwd: string,
  seatId: string,
  env: NodeJS.ProcessEnv,
  sessionID?: string | null,
) {
  const rootResult = await runBounded({
    argv: ["git", "rev-parse", "--show-toplevel"],
    cwd,
    env,
    timeoutMs: 10_000,
  });
  if (rootResult.exitCode !== 0)
    throw commandError(rootResult, "Resolve delegate git root");
  const root = rootResult.stdout.trim();
  if (!root)
    throw new DelegatorError(
      "INVALID_REQUEST",
      `${cwd} is not inside a git worktree.`,
    );
  const repoKey = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const safeSeat =
    seatId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64) || "codex";
  const sessionKey = sessionID
    ? `-${createHash("sha256").update(sessionID).digest("hex").slice(0, 10)}`
    : "";
  const worktree = join(
    dirname(root),
    ".codex-delegate-worktrees",
    `${basename(root)}-${repoKey}`,
    `${safeSeat}${sessionKey}`,
  );
  if (await Bun.file(join(worktree, ".git")).exists())
    return { sourceRoot: root, worktree };
  await mkdir(dirname(worktree), { recursive: true });
  const added = await runBounded({
    argv: ["git", "worktree", "add", "--detach", worktree, "HEAD"],
    cwd: root,
    env,
    timeoutMs: 60_000,
  });
  if (
    added.exitCode !== 0 &&
    !(await Bun.file(join(worktree, ".git")).exists())
  ) {
    throw commandError(added, "Create delegate worktree");
  }
  return { sourceRoot: root, worktree };
}

export async function removeManagedWorktree(
  sourceRoot: string,
  worktree: string,
  env: NodeJS.ProcessEnv,
  runCommand: typeof runBounded = runBounded,
) {
  const removed = await runCommand({
    argv: ["git", "worktree", "remove", "--force", worktree],
    cwd: sourceRoot,
    env,
    timeoutMs: 60_000,
  });
  if (removed.exitCode !== 0 && (await Bun.file(join(worktree, ".git")).exists()))
    throw commandError(removed, "Remove delegate worktree");
}
