import { describe, expect, test } from "bun:test";
import {
  applySessionModel,
  assignFleetToWorkflow,
  defaultDynamicWorkflow,
  DYNAMIC_WORKFLOW_NAME,
  parseAssignmentBlock,
  parseWorkflowCommand,
  pickWorkflowSeats,
  resolveRunnableWorkflow,
  routeWorkflowAssignments,
  SESSION_MEMBER_ID,
  suggestMemberForStep,
  workflowStepKind,
} from "../src/dynamic.ts";
import { runWorkflow } from "../src/workflow.ts";
import type { AgentRunner, Fleet } from "../src/types.ts";

describe("dynamic workflow command parsing", () => {
  const workflows = [{ name: "release" }, { name: "review" }];

  test("treats a saved first token as a named run", () => {
    expect(parseWorkflowCommand("release ship it", workflows)).toEqual({
      name: "release",
      input: "ship it",
      dynamic: false,
    });
  });

  test("treats an unnamed task as a dynamic run", () => {
    expect(parseWorkflowCommand("audit every route", workflows)).toEqual({
      dynamic: true,
      input: "audit every route",
    });
    expect(resolveRunnableWorkflow([], undefined, "audit every route")).toMatchObject({
      dynamic: true,
      input: "audit every route",
      definition: { name: DYNAMIC_WORKFLOW_NAME, kind: "dag" },
    });
  });

  test("rejects an empty dynamic task", () => {
    expect(() => resolveRunnableWorkflow([], undefined, "")).toThrow(
      "Workflow input is required",
    );
  });
});

describe("session-model fleet overlay", () => {
  test("makes the current session model the workflow lead", () => {
    const fleet: Fleet = {
      leadID: "openai",
      members: [{
        id: "openai",
        role: "specialist",
        model: { providerID: "openai", modelID: "gpt-5.2" },
        agent: "plan",
        enabled: true,
      }],
    };
    const next = applySessionModel(fleet, {
      model: { providerID: "zai-coding-plan", modelID: "glm-5.3" },
      agent: "build",
    });
    expect(next.leadID).toBe(SESSION_MEMBER_ID);
    expect(next.members[0]).toMatchObject({
      id: SESSION_MEMBER_ID,
      model: { providerID: "zai-coding-plan", modelID: "glm-5.3" },
      agent: "build",
    });
    expect(next.members[1]?.id).toBe("openai");
    expect(next.members[1]?.agent).toBeUndefined();
  });

  test("fails closed when there is no session model and no fleet", () => {
    expect(() => applySessionModel({ leadID: "lead", members: [] })).toThrow(
      "fleet is empty",
    );
  });
});

describe("default dynamic workflow", () => {
  test("runs understand, change, verify, and synthesis on the session lead", async () => {
    const calls: string[] = [];
    const runner: AgentRunner = {
      async run(input) {
        calls.push(`${input.member.model.providerID}/${input.member.model.modelID}:${input.stepID}`);
        return {
          memberID: input.member.id,
          sessionID: "child",
          model: input.member.model,
          text: `done:${input.stepID}`,
        };
      },
    };
    const fleet = applySessionModel({ leadID: "lead", members: [] }, {
      model: { providerID: "xai", modelID: "grok-4.6" },
    });
    const run = await runWorkflow(
      runner,
      fleet,
      "parent",
      defaultDynamicWorkflow("fix the tests"),
      "fix the tests",
    );
    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => step.id)).toEqual([
      "understand",
      "change",
      "verify",
    ]);
    expect(calls).toEqual([
      "xai/grok-4.6:understand",
      "xai/grok-4.6:change",
      "xai/grok-4.6:verify",
      "xai/grok-4.6:__synthesize",
    ]);
  });

  test("picks understand/change/verify seats from the workflow fleet", async () => {
    const fleet = applySessionModel({
      leadID: "openai",
      members: [
        {
          id: "openai",
          role: "specialist",
          model: { providerID: "openai", modelID: "gpt-5.2" },
          enabled: true,
        },
        {
          id: "codex-delegate",
          role: "implementation specialist",
          model: { providerID: "codex-delegate", modelID: "gpt-5.6-sol" },
          enabled: true,
        },
      ],
    }, {
      model: { providerID: "zai-coding-plan", modelID: "glm-5.3" },
      agent: "build",
    });
    expect(pickWorkflowSeats(fleet).map((member) => member.id)).toEqual([
      SESSION_MEMBER_ID,
      "openai",
      "codex-delegate",
    ]);
    expect(workflowStepKind({
      id: "understand",
      prompt: "files to read or change",
    })).toBe("explore");
    expect(workflowStepKind({ id: "change", prompt: "implement the fix" }))
      .toBe("implement");
    expect(suggestMemberForStep(
      { id: "change", prompt: "implement the fix" },
      fleet,
    )?.id).toBe("codex-delegate");
    const assigned = assignFleetToWorkflow(
      defaultDynamicWorkflow("implement the fix"),
      fleet,
    );
    expect(assigned.steps.map((step) => `${step.id}:${step.memberID}`)).toEqual([
      "understand:session",
      "change:session",
      "verify:session",
    ]);

    const explicit = {
      ...assigned,
      steps: assigned.steps.map((step) =>
        step.id === "change" ? { ...step, memberID: "codex-delegate" } : step
      ),
    };
    const calls: string[] = [];
    const runner: AgentRunner = {
      async run(input) {
        calls.push(`${input.member.id}:${input.stepID}`);
        return {
          memberID: input.member.id,
          sessionID: `child-${input.member.id}`,
          model: input.member.model,
          text: `done:${input.stepID}`,
        };
      },
    };
    const run = await runWorkflow(
      runner,
      fleet,
      "parent",
      explicit,
      "implement the fix",
    );
    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => `${step.id}:${step.memberID}`)).toEqual([
      "understand:session",
      "change:codex-delegate",
      "verify:session",
    ]);
    expect(calls).toEqual([
      "session:understand",
      "codex-delegate:change",
      "session:verify",
      "session:__synthesize",
    ]);
  });

  test("lets the lead remap any unassigned step onto any fleet seat", async () => {
    const fleet = applySessionModel({
      leadID: "openai",
      members: [{
        id: "openai",
        role: "specialist",
        model: { providerID: "openai", modelID: "gpt-5.2" },
        enabled: true,
      }, {
        id: "codex-delegate",
        role: "implementation specialist",
        model: { providerID: "codex-delegate", modelID: "gpt-5.6-sol" },
        enabled: true,
      }],
    }, { model: { providerID: "xai", modelID: "grok-4.6" } });
    expect(parseAssignmentBlock(`
ASSIGN:
understand: session
change: openai
verify: codex-delegate
`).get("change")).toBe("openai");
    const routed = await routeWorkflowAssignments({
      runner: {
        async run() {
          return {
            memberID: "session",
            sessionID: "route",
            model: { providerID: "xai", modelID: "grok-4.6" },
            text: [
              "ASSIGN:",
              "understand: session",
              "change: openai",
              "verify: openai",
            ].join("\n"),
          };
        },
      },
      fleet,
      parentSessionID: "parent",
      definition: defaultDynamicWorkflow("ship it"),
      task: "ship it",
    });
    expect(routed.steps.map((step) => `${step.id}:${step.memberID}`)).toEqual([
      "understand:session",
      "change:openai",
      "verify:openai",
    ]);
  });

  test("ignores invalid lead picks and keeps the work on the lead", async () => {
    const fleet = applySessionModel({ leadID: "lead", members: [] }, {
      model: { providerID: "xai", modelID: "grok-4.6" },
    });
    const routed = await routeWorkflowAssignments({
      runner: {
        async run() {
          throw new Error("lead routing failed");
        },
      },
      fleet,
      parentSessionID: "parent",
      definition: defaultDynamicWorkflow("just think"),
      task: "just think",
    });
    expect(routed.steps.every((step) => step.memberID === SESSION_MEMBER_ID))
      .toBe(true);
  });

  test("keeps an explicit step member and skips disabled seats", () => {
    const assigned = assignFleetToWorkflow({
      kind: "dag",
      name: "review",
      steps: [
        { id: "research", prompt: "research", memberID: "openai" },
        { id: "tests", prompt: "tests" },
      ],
    }, {
      leadID: "session",
      members: [
        {
          id: "session",
          role: "lead",
          model: { providerID: "xai", modelID: "grok" },
          enabled: true,
        },
        {
          id: "openai",
          role: "worker",
          model: { providerID: "openai", modelID: "gpt" },
          enabled: true,
        },
        {
          id: "off",
          role: "worker",
          model: { providerID: "zai", modelID: "glm" },
          enabled: false,
        },
      ],
    });
    expect(assigned.steps.map((step) => step.memberID)).toEqual([
      "openai",
      "session",
    ]);
  });
});
