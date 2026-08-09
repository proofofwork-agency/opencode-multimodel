import { describe, expect, test } from "bun:test";
import { collaborate, parseTasksBlock } from "../src/collaborate.ts";
import type {
  AgentReply,
  AgentRunner,
  Fleet,
  RunAgentInput,
} from "../src/types.ts";

const fleet: Fleet = {
  leadID: "lead",
  members: [
    {
      id: "lead",
      role: "orchestrator",
      model: { providerID: "openai", modelID: "gpt-lead" },
      enabled: true,
    },
    {
      id: "claude",
      role: "reviewer",
      model: { providerID: "anthropic", modelID: "claude-worker" },
      enabled: true,
    },
    {
      id: "codex",
      role: "implementer",
      model: { providerID: "codex-delegate", modelID: "gpt-codex" },
      enabled: true,
    },
  ],
};

class FakeRunner implements AgentRunner {
  readonly calls: RunAgentInput[] = [];
  active = 0;
  peak = 0;

  constructor(
    private readonly answer?: (
      input: RunAgentInput,
      index: number,
    ) => string | Promise<string>,
  ) {}

  async run(input: RunAgentInput): Promise<AgentReply> {
    const index = this.calls.push(input) - 1;
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      await Bun.sleep(5);
      const text =
        (await this.answer?.(input, index)) ?? `${input.member.id}:${index}`;
      return {
        memberID: input.member.id,
        sessionID: `session-${input.member.id}`,
        model: input.member.model,
        text,
      };
    } finally {
      this.active -= 1;
    }
  }
}

describe("Poly-derived collaboration modes", () => {
  test("pair runs lead plan, worker response, and lead synthesis", async () => {
    const runner = new FakeRunner((input, index) =>
      index === 2 ? "final answer" : `${input.member.id} reply`,
    );
    const result = await collaborate(runner, fleet, "parent", "Solve this", {
      mode: "pair",
    });

    expect(runner.calls.map((call) => call.member.id)).toEqual([
      "lead",
      "claude",
      "lead",
    ]);
    expect(result.final.memberID).toBe("lead");
    expect(result.final.text).toBe("final answer");
    expect(result.participants).toEqual(["lead", "claude"]);
  });

  test("council runs independent workers in parallel before lead synthesis", async () => {
    const runner = new FakeRunner((input) =>
      input.member.id === "lead" ? "synthesis" : `${input.member.id} view`,
    );
    const result = await collaborate(runner, fleet, "parent", "Review this", {
      mode: "council",
      maxParallel: 2,
    });

    expect(runner.peak).toBe(2);
    expect(
      runner.calls
        .slice(0, 2)
        .map((call) => call.member.id)
        .sort(),
    ).toEqual(["claude", "codex"]);
    expect(runner.calls.at(-1)?.member.id).toBe("lead");
    expect(result.final.text).toBe("synthesis");
  });

  test("jury runs two independent ballot rounds and a lead verdict", async () => {
    const runner = new FakeRunner((input) => {
      if (input.member.id === "lead") return "Ship with safeguards.";
      return [
        `POSITION: ${input.member.id} position`,
        input.member.id === "claude" ? "VOTE: approve" : "VOTE: conditional",
        "CONFIDENCE: high",
        "RATIONALE: Evidence",
        "RISKS: Regression",
        "ALTERNATIVE: Stage rollout",
      ].join("\n");
    });
    const result = await collaborate(
      runner,
      fleet,
      "parent",
      "Should we ship?",
      { mode: "jury" },
    );

    expect(runner.calls).toHaveLength(5);
    expect(result.jury?.rounds).toBe(2);
    expect(result.jury?.majority).toBe("split");
    expect(result.jury?.multiModel).toBe(true);
    expect(result.final.memberID).toBe("lead");
  });

  test("orchestrate honors a lead TASKS block and assigns active fleet members", async () => {
    const runner = new FakeRunner((input, index) => {
      if (index === 0) {
        return "Plan\n\nTASKS:\n- model: claude\n  prompt: Review risks\n- model: codex-delegate/gpt-codex\n  prompt: |\n    Draft implementation\n    notes";
      }
      if (input.member.id === "lead") return "orchestrated final";
      return `${input.member.id} result`;
    });
    const result = await collaborate(runner, fleet, "parent", "Build it", {
      mode: "orchestrate",
    });

    expect(runner.calls.map((call) => call.member.id)).toEqual([
      "lead",
      "claude",
      "codex",
      "lead",
    ]);
    expect(result.final.text).toBe("orchestrated final");
  });

  test("enforces a hard agent-call budget", async () => {
    const runner = new FakeRunner();
    await expect(
      collaborate(runner, fleet, "parent", "Budget", {
        mode: "pair",
        agentBudget: 2,
      }),
    ).rejects.toThrow("budget exhausted");
    expect(runner.calls).toHaveLength(2);
  });
});

test("TASKS parser preserves multiline task prompts", () => {
  expect(
    parseTasksBlock(
      "TASKS:\n- model: codex\n  prompt: |\n    Inspect code\n    Add tests",
    ),
  ).toEqual([{ model: "codex", prompt: "Inspect code\nAdd tests" }]);
});
