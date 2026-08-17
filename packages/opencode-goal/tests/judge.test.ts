import { expect, test } from "bun:test";
import { parseJudgeOutput } from "../src/judge.ts";

test("parses a clean judge object", () => {
  expect(parseJudgeOutput(
    '{"verdict":"not_met","reason":"auth tests still fail"}',
  )).toEqual({
    verdict: "not_met",
    reason: "auth tests still fail",
  });
});

test("parses fenced JSON and treats junk as not met", () => {
  expect(parseJudgeOutput(
    "sure\n```json\n{\"verdict\":\"impossible\",\"reason\":\"no such API\"}\n```",
  )).toEqual({
    verdict: "impossible",
    reason: "no such API",
  });
  expect(parseJudgeOutput("looks done to me")).toEqual({
    verdict: "not_met",
    reason: "Judge output was unusable; treating the goal as not met.",
  });
});
