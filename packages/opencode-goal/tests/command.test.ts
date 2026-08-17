import { expect, test } from "bun:test";
import { parseBudget, parseGoalCommand } from "../src/command.ts";
import {
  goalSlashArguments,
  sessionLooksBusy,
  shouldStartGoalTurn,
  shouldSteerLiveTurn,
} from "../src/slash.ts";

test("empty arguments are status", () => {
  expect(parseGoalCommand("")).toEqual({ action: "status" });
});

test("parses lifecycle controls", () => {
  expect(parseGoalCommand("pause")).toEqual({ action: "pause" });
  expect(parseGoalCommand("resume")).toEqual({ action: "resume" });
  expect(parseGoalCommand("clear")).toEqual({ action: "clear" });
  expect(parseGoalCommand("cancel")).toEqual({ action: "clear" });
});

test("parses an objective with budget and check flags", () => {
  expect(
    parseGoalCommand(
      `fix the failing tests --budget 200k --check "npm test" --constraint "do not change public API"`,
    ),
  ).toEqual({
    action: "set",
    objective: "fix the failing tests",
    tokenBudget: 200_000,
    verification: undefined,
    constraints: "do not change public API",
    checks: ["npm test"],
  });
});

test("parses equals-style flags", () => {
  expect(parseGoalCommand(`ship it --budget=1.5m --verify "tests pass"`)).toEqual({
    action: "set",
    objective: "ship it",
    tokenBudget: 1_500_000,
    verification: "tests pass",
    constraints: undefined,
    checks: [],
  });
});

test("extracts /goal arguments from a TUI submit line", () => {
  expect(goalSlashArguments("hello")).toBeUndefined();
  expect(goalSlashArguments("/btw why")).toBeUndefined();
  expect(goalSlashArguments("/goal")).toBe("");
  expect(goalSlashArguments("/goal status")).toBe("status");
  expect(goalSlashArguments("/GOAL  pause")).toBe("pause");
  expect(goalSlashArguments(`/goal fix auth --check "npm test"`)).toBe(
    `fix auth --check "npm test"`,
  );
});

test("set and resume always start a turn and steer a busy session", () => {
  expect(sessionLooksBusy({ type: "busy" })).toBe(true);
  expect(sessionLooksBusy({ type: "retry" })).toBe(true);
  expect(sessionLooksBusy({ type: "idle" })).toBe(false);
  expect(shouldStartGoalTurn("set")).toBe(true);
  expect(shouldStartGoalTurn("resume")).toBe(true);
  expect(shouldStartGoalTurn("pause")).toBe(false);
  expect(shouldSteerLiveTurn("set", true)).toBe(true);
  expect(shouldSteerLiveTurn("resume", true)).toBe(true);
  expect(shouldSteerLiveTurn("set", false)).toBe(false);
  expect(shouldSteerLiveTurn("pause", true)).toBe(false);
});

test("unwraps a fully quoted argument blob from OpenCode", () => {
  expect(
    parseGoalCommand('"Create GOAL_SMOKE.txt --check=./goal-smoke-check.sh"'),
  ).toEqual({
    action: "set",
    objective: "Create GOAL_SMOKE.txt",
    tokenBudget: undefined,
    verification: undefined,
    constraints: undefined,
    checks: ["./goal-smoke-check.sh"],
  });
});

test("parses budget suffixes", () => {
  expect(parseBudget("20")).toBe(20);
  expect(parseBudget("100k")).toBe(100_000);
  expect(parseBudget("1.5m")).toBe(1_500_000);
});
