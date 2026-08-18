import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../src/options.ts";
import { StateStore } from "../src/state.ts";
import { loadWorkflowDirectories } from "../src/workflow-files.ts";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

describe("configured workflow directories", () => {
  test("loads DAG files and gates script files behind workflows.scripts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-workflows-"));
    const workflows = join(directory, ".opencode", "workflows");
    await mkdir(workflows, { recursive: true });
    await Bun.write(join(workflows, "review.json"), JSON.stringify({
      kind: "dag",
      name: "review",
      steps: [{ id: "review", prompt: "Review ${input}" }],
    }));
    await Bun.write(
      join(workflows, "script.ts"),
      'export const meta = { name: "scripted" };\nexport default () => agent("lead", args("input"));',
    );
    const store = new StateStore(join(directory, "state.sqlite"));
    cleanup.push(async () => {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    });

    await loadWorkflowDirectories(
      store,
      directory,
      parseOptions(undefined).workflows,
    );
    expect((await store.read()).workflows.map((item) => item.name)).toEqual([
      "review",
    ]);

    await loadWorkflowDirectories(
      store,
      directory,
      parseOptions({ workflows: { scripts: true } }).workflows,
    );
    expect((await store.read()).workflows.map((item) => item.name)).toEqual([
      "review",
      "scripted",
    ]);
  });

  test("loads TypeScript workflow() modules without enabling confined scripts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-workflows-"));
    const workflows = join(directory, ".opencode", "workflows");
    await mkdir(workflows, { recursive: true });
    await Bun.write(
      join(workflows, "release.ts"),
      `import { workflow } from "opencode-multimodel/workflow"
export default workflow({
  name: "release",
  description: "Ship notes",
  phases: ["draft"],
  async run(_args, ctx) { return ctx.agent({ prompt: "draft" }) }
})
`,
    );
    const store = new StateStore(join(directory, "state.sqlite"));
    cleanup.push(async () => {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    });
    await loadWorkflowDirectories(
      store,
      directory,
      parseOptions(undefined).workflows,
    );
    expect((await store.read()).workflows).toEqual([
      expect.objectContaining({
        kind: "module",
        name: "release",
        description: "Ship notes",
        phases: ["draft"],
      }),
    ]);
  });
});

describe("workflow file loading robustness", () => {
  test("a malformed file is skipped instead of failing the whole scan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-workflows-"));
    const workflows = join(directory, ".opencode", "workflows");
    await mkdir(workflows, { recursive: true });
    await Bun.write(join(workflows, "good.json"), JSON.stringify({
      kind: "dag",
      name: "good",
      steps: [{ id: "only", prompt: "work" }],
    }));
    await Bun.write(join(workflows, "broken.json"), "{ not valid json");
    const store = new StateStore(join(directory, "state.sqlite"));
    cleanup.push(async () => {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    });

    const loaded = await loadWorkflowDirectories(
      store,
      directory,
      parseOptions(undefined).workflows,
    );
    expect(loaded).toBe(1);
    expect((await store.read()).workflows.map((item) => item.name)).toEqual([
      "good",
    ]);
  });
});
