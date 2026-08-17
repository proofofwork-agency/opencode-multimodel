import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModuleWorkflow } from "../src/workflow-module.ts";
import { workflowSourceHash } from "../src/state.ts";
import type { AgentRunner, Fleet, ModuleWorkflowDefinition } from "../src/types.ts";

const fleet: Fleet = {
  leadID: "session",
  members: [
    {
      id: "session",
      role: "lead",
      model: { providerID: "xai", modelID: "grok" },
      enabled: true,
    },
    {
      id: "codex-delegate",
      role: "implementation specialist",
      model: { providerID: "codex-delegate", modelID: "gpt-5.6-sol" },
      enabled: true,
    },
    {
      id: "worker",
      role: "worker",
      model: { providerID: "openai", modelID: "gpt-5.2" },
      enabled: true,
    },
  ],
};

describe("TypeScript module workflows", () => {
  test("runs ctx.agent through the fleet and falls back after a seat failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-workflow-"));
    const file = join(directory, "release.ts");
    const source = `
import { workflow } from "opencode-multimodel/workflow"

export default workflow({
  name: "release",
  phases: ["change"],
  async run(_args, ctx) {
    const built = await ctx.agent({
      role: "implement",
      label: "change",
      prompt: "implement the fix",
    })
    return built?.text
  },
})
`;
    await writeFile(file, source);
    const runner: AgentRunner = {
      async run(input) {
        if (input.member.id === "codex-delegate") {
          throw new Error("usage limit");
        }
        return {
          memberID: input.member.id,
          sessionID: "child",
          model: input.member.model,
          text: `ok:${input.member.id}`,
        };
      },
    };
    const run = await runModuleWorkflow(
      runner,
      fleet,
      "parent",
      definition(file, source),
      "",
    );
    expect(run.status).toBe("completed");
    expect(run.final).toBe("ok:worker");
    expect(run.steps.some((step) => step.output?.includes("Fell back to worker")))
      .toBe(true);
  });

  test("returns null from a failed parallel task and keeps the others", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-workflow-"));
    const file = join(directory, "fanout.ts");
    const source = `
import { workflow } from "opencode-multimodel/workflow"

export default workflow({
  name: "fanout",
  async run(_args, ctx) {
    return ctx.parallel([
      () => ctx.agent({ member: "session", prompt: "one" }),
      () => ctx.agent({ member: "codex-delegate", prompt: "two", onError: "null" }),
    ])
  },
})
`;
    await writeFile(file, source);
    const runner: AgentRunner = {
      async run(input) {
        if (input.member.id === "codex-delegate") throw new Error("down");
        return {
          memberID: input.member.id,
          sessionID: "child",
          model: input.member.model,
          text: "ok",
        };
      },
    };
    const run = await runModuleWorkflow(
      runner,
      fleet,
      "parent",
      definition(file, source),
      "",
    );
    expect(run.status).toBe("completed");
    expect(JSON.parse(run.final ?? "[]")).toEqual([
      { text: "ok", data: "ok" },
      null,
    ]);
  });

  test("ctx.shell returns a non-zero exit without failing the run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mm-workflow-"));
    await mkdir(join(directory, ".opencode", "workflows"), { recursive: true });
    const file = join(directory, ".opencode", "workflows", "build.ts");
    const source = `
import { workflow } from "opencode-multimodel/workflow"

export default workflow({
  name: "build",
  async run(_args, ctx) {
    const result = await ctx.shell("exit 7")
    return result
  },
})
`;
    await writeFile(file, source);
    const run = await runModuleWorkflow(
      {
        async run() {
          throw new Error("should not call an agent");
        },
      },
      fleet,
      "parent",
      definition(file, source),
      "",
    );
    expect(run.status).toBe("completed");
    expect(JSON.parse(run.final ?? "{}")).toMatchObject({ exitCode: 7 });
  });
});

function definition(path: string, source: string): ModuleWorkflowDefinition {
  return {
    kind: "module",
    name: "release",
    path,
    source,
    sourceHash: workflowSourceHash(source),
    phases: ["change"],
  };
}
