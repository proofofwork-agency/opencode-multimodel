import { describe, expect, test } from "bun:test";
import {
  runWorkflow,
  validateWorkflow,
  WorkflowValidationError,
} from "../src/workflow.ts";
import type {
  AgentReply,
  AgentRunner,
  Fleet,
  RunAgentInput,
  WorkflowDefinition,
} from "../src/types.ts";

const fleet: Fleet = {
  leadID: "lead",
  members: [
    {
      id: "lead",
      role: "lead",
      model: { providerID: "one", modelID: "lead" },
      enabled: true,
    },
    {
      id: "worker",
      role: "worker",
      model: { providerID: "two", modelID: "worker" },
      enabled: true,
    },
  ],
};

class WorkflowRunner implements AgentRunner {
  readonly calls: RunAgentInput[] = [];
  active = 0;
  peak = 0;

  constructor(private readonly fail = "") {}

  async run(input: RunAgentInput): Promise<AgentReply> {
    this.calls.push(input);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      await Bun.sleep(5);
      if (input.prompt.includes(this.fail) && this.fail)
        throw new Error("step failed");
      return {
        memberID: input.member.id,
        sessionID: `session-${input.member.id}`,
        model: input.member.model,
        text: `output(${input.prompt})`,
      };
    } finally {
      this.active -= 1;
    }
  }
}

describe("declarative workflow runtime", () => {
  test("runs ready DAG steps concurrently, interpolates outputs, and synthesizes", async () => {
    const definition: WorkflowDefinition = {
      name: "review",
      maxParallel: 2,
      synthesize: true,
      steps: [
        { id: "research", memberID: "worker", prompt: "Research ${input}" },
        { id: "audit", prompt: "Audit ${input}" },
        {
          id: "merge",
          needs: ["research", "audit"],
          prompt: "Merge ${research} with ${audit}",
        },
      ],
    };
    const runner = new WorkflowRunner();
    const snapshots: string[] = [];
    const run = await runWorkflow(
      runner,
      fleet,
      "parent",
      definition,
      "feature",
      {
        onUpdate(next) {
          snapshots.push(next.status);
        },
      },
    );

    expect(run.status).toBe("completed");
    expect(runner.peak).toBe(2);
    expect(runner.calls[2]?.prompt).toContain("output(Research feature)");
    expect(runner.calls).toHaveLength(4);
    expect(run.final).toContain("output(");
    expect(snapshots[0]).toBe("running");
    expect(snapshots.at(-1)).toBe("completed");
  });

  test("stops dependents after a hard failure", async () => {
    const definition: WorkflowDefinition = {
      name: "failure",
      steps: [
        { id: "first", prompt: "FAIL" },
        { id: "second", needs: ["first"], prompt: "Never run" },
      ],
    };
    const runner = new WorkflowRunner("FAIL");
    const run = await runWorkflow(runner, fleet, "parent", definition, "");

    expect(run.status).toBe("failed");
    expect(run.steps.map((step) => step.status)).toEqual([
      "failed",
      "cancelled",
    ]);
    expect(runner.calls).toHaveLength(1);
  });

  test("allows dependents when the failed step declares continueOnError", async () => {
    const definition: WorkflowDefinition = {
      name: "continue",
      steps: [
        { id: "first", prompt: "FAIL", continueOnError: true },
        { id: "second", needs: ["first"], prompt: "Use ${first}" },
      ],
    };
    const runner = new WorkflowRunner("FAIL");
    const run = await runWorkflow(runner, fleet, "parent", definition, "");

    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => step.status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(runner.calls[1]?.prompt).toBe("Use step failed");
  });

  test("rejects cycles before execution", () => {
    expect(() =>
      validateWorkflow({
        name: "cycle",
        steps: [
          { id: "a", needs: ["b"], prompt: "A" },
          { id: "b", needs: ["a"], prompt: "B" },
        ],
      }),
    ).toThrow(WorkflowValidationError);
  });
});
