import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import serverModule from "../src/server.ts";
import {
  runScriptWorkflow,
  validateWorkflowScript,
} from "../src/script.ts";
import { workflowSourceHash } from "../src/state.ts";
import type {
  AgentRunner,
  Fleet,
  ScriptWorkflowDefinition,
} from "../src/types.ts";

describe("confined script workflows", () => {
  test("runs only the six-function expression surface", async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async run(input) {
        calls.push(input.prompt);
        return {
          memberID: input.member.id,
          sessionID: `child-${calls.length}`,
          model: input.member.model,
          text: `answer:${input.prompt}`,
        };
      },
    };
    const definition: ScriptWorkflowDefinition = {
      kind: "script",
      name: "research",
      source: `export default async ({ args, agent, parallel, pipeline, phase, log }) =>
        pipeline([
          phase("research", parallel([
            agent({ prompt: "one", memberID: "worker" }),
            agent("two")
          ])),
          log(args.input),
          agent("three")
        ])`,
    };
    const updates: string[] = [];
    const run = await runScriptWorkflow(
      runner,
      fleet(),
      "parent",
      definition,
      "input value",
      { onUpdate: (value) => void updates.push(value.status) },
    );

    expect(calls.slice(0, 2).sort()).toEqual(["one", "two"]);
    expect(calls[2]).toBe("three");
    expect(run.status).toBe("completed");
    expect(run.steps).toHaveLength(3);
    expect(updates).toContain("running");
    expect(updates.at(-1)).toBe("completed");
  });

  test("rejects host and evaluator escape attempts", () => {
    for (const source of [
      'import("node:fs")',
      'agent(process.env.SECRET)',
      'agent(Bun.file("secret"))',
      'agent(fetch("https://example.com"))',
      'agent(globalThis.constructor.constructor("return process")())',
      'agent(eval("1"))',
    ]) {
      expect(() => validateWorkflowScript(source)).toThrow();
    }
  });

  test("normalizes source before hashing", () => {
    expect(workflowSourceHash("agent('one')\r\n")).toBe(
      workflowSourceHash("agent('one')"),
    );
    expect(workflowSourceHash("agent('two')")).not.toBe(
      workflowSourceHash("agent('one')"),
    );
  });

  test("enforces timeout and call budget", async () => {
    const runner: AgentRunner = {
      async run(input) {
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
    };
    const run = await runScriptWorkflow(
      runner,
      fleet(),
      "parent",
      { kind: "script", name: "timeout", source: 'agent("wait")' },
      "",
      { timeoutMs: 20 },
    );
    expect(run.status).toBe("cancelled");
    expect(run.error).toContain("exceeded 20 ms");

    await expect(runScriptWorkflow(
      {
        async run(input) {
          return {
            memberID: input.member.id,
            sessionID: "child",
            model: input.member.model,
            text: "done",
          };
        },
      },
      fleet(),
      "parent",
      {
        kind: "script",
        name: "budget",
        source: 'pipeline([agent("one"), agent("two")])',
      },
      "",
      { maxAgentCalls: 1 },
    )).resolves.toMatchObject({ status: "failed" });
  });

  test("binds OpenCode permission to workflow name and source hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-script-permission-"));
    const source = 'agent("review")';
    const asks: Array<{ patterns: string[] }> = [];
    const plugin = await serverModule.server({
      directory,
      client: {
        session: {
          async create() {
            return { data: { id: "child" } };
          },
          async prompt() {
            return { data: { parts: [{ type: "text", text: "done" }] } };
          },
          async abort() {
            return { data: true };
          },
        },
      },
    } as never, {
      databasePath: join(directory, "state.sqlite"),
      fleet: fleet(),
      workflows: { scripts: true },
    });
    const context = {
      sessionID: "parent",
      messageID: "message",
      abort: new AbortController().signal,
      metadata() {},
      async ask(input: { patterns: string[] }) {
        asks.push(input);
      },
    } as never;
    await plugin.tool!.multimodel_workflow!.execute({
      action: "save",
      definition: JSON.stringify({ kind: "script", name: "secure", source }),
    }, context);
    await plugin.tool!.multimodel_workflow!.execute({
      action: "run",
      name: "secure",
      input: "",
    }, context);

    expect(asks.at(-1)?.patterns).toEqual([
      `secure:${workflowSourceHash(source)}`,
    ]);
    await plugin.dispose?.();
  });
});

function fleet(): Fleet {
  return {
    leadID: "lead",
    members: [
      {
        id: "lead",
        role: "lead",
        model: { providerID: "test", modelID: "lead" },
        enabled: true,
      },
      {
        id: "worker",
        role: "worker",
        model: { providerID: "test", modelID: "worker" },
        enabled: true,
      },
    ],
  };
}
