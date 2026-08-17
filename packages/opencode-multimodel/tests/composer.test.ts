import { describe, expect, test } from "bun:test";
import type { TuiPromptInfo } from "@opencode-ai/plugin/tui";
import { parseOptions } from "../src/options.ts";
import {
  collaborationComposerInput,
  composerSlotIsActive,
  isPlainComposerSubmitKey,
  nextFleetMemberID,
  routeComposerPrompt,
} from "../src/tui.tsx";
import type { WorkflowDefinition } from "../src/types.ts";

const workflows: WorkflowDefinition[] = [{
  kind: "dag",
  name: "release",
  steps: [{ id: "ship", prompt: "Ship ${input}" }],
}];

describe("native composer routing", () => {
  test("prefills interactive collaboration in the native composer", () => {
    expect(collaborationComposerInput("council")).toBe(
      "/collab council ",
    );
  });

  test("keeps SINGLE input and attachment objects unchanged", () => {
    const prompt = value("Review this", [{ type: "file", mime: "text/plain", url: "file:///a" }]);
    expect(routeComposerPrompt(
      prompt,
      { mode: "single", collaborationMode: "council" },
      false,
      workflows,
      "council",
    )).toBe(prompt);
  });

  test("routes TEAM and WORKFLOW while preserving attachments", () => {
    const prompt = value("Review this", [{ type: "agent", name: "reviewer" }]);
    const team = routeComposerPrompt(
      prompt,
      { mode: "team", collaborationMode: "jury" },
      false,
      workflows,
      "council",
    );
    const workflow = routeComposerPrompt(
      prompt,
      { mode: "workflow", collaborationMode: "council", workflowName: "release" },
      false,
      workflows,
      "council",
    );

    expect(team.input).toBe("/collab jury Review this");
    expect(team.parts).toBe(prompt.parts);
    expect(workflow.input).toBe("/workflow release Review this");
    expect(workflow.parts).toBe(prompt.parts);
    expect(routeComposerPrompt(
      prompt,
      { mode: "workflow", collaborationMode: "council" },
      false,
      workflows,
      "council",
    ).input).toBe("/workflow Review this");
  });

  test("never rewrites shell, slash-command, or @ input", () => {
    const selection = { mode: "team" as const, collaborationMode: "jury" as const };
    for (const prompt of [
      value("ls", [], "shell"),
      value("/help"),
      value("@reviewer inspect this"),
    ]) {
      expect(routeComposerPrompt(
        prompt,
        selection,
        true,
        workflows,
        "council",
      )).toBe(prompt);
    }
  });

  test("auto-routing requires explicit team language or an exact workflow reference", () => {
    const selection = { mode: "single" as const, collaborationMode: "pair" as const };
    expect(routeComposerPrompt(
      value("Ask multiple models to assess this"),
      selection,
      true,
      workflows,
      "pair",
    ).input).toStartWith("/collab council ");
    expect(routeComposerPrompt(
      value("Run workflow:release for version 2"),
      selection,
      true,
      workflows,
      "pair",
    ).input).toStartWith("/workflow release ");
    expect(routeComposerPrompt(
      value("Make the release workflow better"),
      selection,
      true,
      workflows,
      "pair",
    ).input).toBe("Make the release workflow better");
  });

  test("only lets the composer for the current route own the shared prompt ref", () => {
    expect(composerSlotIsActive({ name: "home" }, "__home__")).toBe(true);
    expect(composerSlotIsActive({ name: "home" }, "session-a")).toBe(false);
    expect(composerSlotIsActive(
      { name: "session", params: { sessionID: "session-a" } },
      "__home__",
    )).toBe(false);
    expect(composerSlotIsActive(
      { name: "session", params: { sessionID: "session-a" } },
      "session-a",
    )).toBe(true);
    expect(composerSlotIsActive(
      { name: "session", params: { sessionID: "session-a" } },
      "session-a",
      false,
    )).toBe(false);
  });

  test("routes only an unhandled plain Enter when no dialog is open", () => {
    expect(isPlainComposerSubmitKey({ name: "return" })).toBe(true);
    expect(isPlainComposerSubmitKey({ name: "enter" })).toBe(true);
    expect(isPlainComposerSubmitKey({ name: "return" }, true)).toBe(false);
    expect(isPlainComposerSubmitKey({ name: "return" }, false, true)).toBe(false);
    expect(isPlainComposerSubmitKey({ name: "return", shift: true })).toBe(false);
    expect(isPlainComposerSubmitKey({ name: "enter", ctrl: true })).toBe(false);
    expect(isPlainComposerSubmitKey({ name: "tab" })).toBe(false);
  });

  test("creates stable collision-free IDs for added fleet seats", () => {
    expect(nextFleetMemberID("codex-delegate", "gpt-5.6-sol", [])).toBe(
      "codex-delegate",
    );
    expect(nextFleetMemberID("codex-delegate", "gpt-5.6-sol", [
      "codex-delegate",
    ])).toBe("codex-delegate-gpt-5-6-sol");
    expect(nextFleetMemberID("codex-delegate", "gpt-5.6-sol", [
      "codex-delegate",
      "codex-delegate-gpt-5-6-sol",
    ])).toBe("codex-delegate-gpt-5-6-sol-2");
  });
});

describe("configuration validation", () => {
  test("accepts the documented nested configuration", () => {
    expect(parseOptions({
      databasePath: ".opencode/custom.sqlite",
      composer: { enabled: true, initial: "workflow", autoRoute: true },
      workflows: {
        scripts: true,
        directories: [".opencode/workflows"],
        timeoutMs: 1_000,
        maxAgentCalls: 4,
      },
      retention: { runs: 25, events: 500 },
    })).toMatchObject({
      databasePath: ".opencode/custom.sqlite",
      composer: { initial: "workflow", autoRoute: true },
      workflows: { scripts: true, maxAgentCalls: 4 },
      retention: { runs: 25, events: 500 },
    });
  });

  test("rejects unknown and invalid options instead of falling back", () => {
    expect(() => parseOptions({ typo: true })).toThrow("typo is not a supported option");
    expect(() => parseOptions({ maxParallel: 99 })).toThrow("maxParallel");
    expect(() => parseOptions({ composer: { initial: "magic" } })).toThrow("composer.initial");
    expect(() => parseOptions({
      fleet: {
        leadID: "lead",
        members: [{
          id: "lead",
          role: "lead",
          model: { providerID: "test", modelID: "model", token: "secret" },
          enabled: true,
        }],
      },
    })).toThrow("fleet.members[0].model.token is not a supported option");
  });
});

function value(
  input: string,
  parts: unknown[] = [],
  mode: "normal" | "shell" = "normal",
): TuiPromptInfo {
  return { input, mode, parts } as TuiPromptInfo;
}
