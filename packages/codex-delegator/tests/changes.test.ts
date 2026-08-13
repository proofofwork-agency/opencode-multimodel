import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectWorkspaceChanges } from "../src/changes.ts";

test("includes tracked edits and untracked file bodies in the change snapshot", async () => {
  const root = await gitFixture();
  await Bun.write(join(root, "README.md"), "tracked edit\n");
  await Bun.write(join(root, "new-file.txt"), "untracked body\n");
  const changes = await collectWorkspaceChanges(root, process.env);
  expect(changes).not.toBeNull();
  expect(changes!.files).toContain("README.md");
  expect(changes!.files).toContain("new-file.txt");
  expect(changes!.patch).toContain("tracked edit");
  expect(changes!.patch).toContain("untracked body");
  expect(changes!.patch).toContain("new-file.txt");
});

test("caps tracked patches at 64KB and marks them truncated", async () => {
  const root = await gitFixture();
  await Bun.write(join(root, "README.md"), `${"tracked edit ".repeat(8_000)}\n`);
  const changes = await collectWorkspaceChanges(root, process.env);
  expect(changes).not.toBeNull();
  expect(changes!.truncated).toBe(true);
  expect(Buffer.byteLength(changes!.patch ?? "")).toBeLessThanOrEqual(64_000);
});

test("excludes ContextRelay runtime state even when the host repo does not ignore it", async () => {
  const root = await gitFixture();
  await Bun.write(
    join(root, ".contextrelay", "state", "token"),
    "initial-runtime-token",
  );
  await git(root, ["add", "-f", ".contextrelay/state/token"]);
  await git(root, ["commit", "-qm", "tracked runtime fixture"]);
  await Bun.write(
    join(root, ".contextrelay", "state", "token"),
    "sensitive-runtime-token",
  );
  const changes = await collectWorkspaceChanges(root, process.env);
  expect(changes).not.toBeNull();
  expect(changes!.files).not.toContain(".contextrelay/state/token");
  expect(changes!.patch ?? "").not.toContain("sensitive-runtime-token");
});

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-delegator-changes-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "delegator@example.invalid"]);
  await git(root, ["config", "user.name", "Codex Delegator Test"]);
  await Bun.write(join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-qm", "fixture"]);
  return root;
}

async function git(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}
