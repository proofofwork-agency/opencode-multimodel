import { expect, test } from "bun:test";
import {
  parseCollabCommand,
  parseCollabSlash,
  parsePluginSlash,
  parseWorkflowSlash,
} from "../src/slash.ts";

test("parses /workflow and /workflows submit lines", () => {
  expect(parseWorkflowSlash("hello")).toBeUndefined();
  expect(parseWorkflowSlash("/goal pause")).toBeUndefined();
  expect(parseWorkflowSlash("/workflow-fleet")).toBeUndefined();
  expect(parseWorkflowSlash("/workflows")).toEqual({ kind: "workflows" });
  expect(parseWorkflowSlash("/WORKFLOWS extra")).toEqual({ kind: "workflows" });
  expect(parseWorkflowSlash("/workflow")).toEqual({
    kind: "workflow",
    args: "",
  });
  expect(parseWorkflowSlash("/workflow audit auth")).toEqual({
    kind: "workflow",
    args: "audit auth",
  });
  expect(parseWorkflowSlash("/workflow release ship it")).toEqual({
    kind: "workflow",
    args: "release ship it",
  });
});

test("parses /collab submit lines without waiting for a command adapter", () => {
  expect(parseCollabSlash("/collab")).toEqual({ kind: "collab", args: "" });
  expect(parseCollabSlash("/collab orchestrate ship the auth fix")).toEqual({
    kind: "collab",
    args: "orchestrate ship the auth fix",
  });
  expect(parsePluginSlash("/collab handoff implement the adapter")).toEqual({
    kind: "collab",
    args: "handoff implement the adapter",
  });
  expect(parseCollabCommand("orchestrate ship the auth fix", "council")).toEqual({
    mode: "orchestrate",
    prompt: "ship the auth fix",
  });
  expect(parseCollabCommand("review the diff", "orchestrate")).toEqual({
    mode: "orchestrate",
    prompt: "review the diff",
  });
  expect(parseCollabCommand("", "pair")).toEqual({
    mode: "pair",
    prompt: "",
  });
});
