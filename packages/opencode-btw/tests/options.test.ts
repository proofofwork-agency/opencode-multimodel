import { describe, expect, test } from "bun:test";
import { parseModelRef, parseOptions } from "../src/options.ts";

describe("parseOptions", () => {
  test("applies documented defaults", () => {
    expect(parseOptions(undefined)).toEqual({
      model: "inherit",
      maxMessages: 40,
      maxChars: 48_000,
      maxOutputTokens: 2_048,
      timeoutMs: 60_000,
      history: 10,
      concurrency: 1,
      tool: false,
      notify: false,
    });
  });

  test("accepts valid overrides and ignores unknown keys", () => {
    expect(
      parseOptions({
        model: "anthropic/claude-sonnet-4",
        maxMessages: 12,
        history: 0,
        concurrency: 2,
        tool: true,
        notify: true,
        nonsense: "ignored",
      } as never),
    ).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      maxMessages: 12,
      history: 0,
      concurrency: 2,
      tool: true,
      notify: true,
    });
  });

  test("clamps invalid values back to defaults", () => {
    expect(
      parseOptions({
        maxMessages: 10_000,
        maxChars: "lots",
        maxOutputTokens: 1,
        timeoutMs: 5,
        history: -3,
        concurrency: 99,
        tool: "yes",
        model: "not-a-model",
      } as never),
    ).toEqual({
      model: "inherit",
      maxMessages: 40,
      maxChars: 48_000,
      maxOutputTokens: 2_048,
      timeoutMs: 60_000,
      history: 10,
      concurrency: 1,
      tool: false,
      notify: false,
    });
  });

  test("resolves model keywords", () => {
    expect(parseOptions({ model: "" } as never).model).toBe("inherit");
    expect(parseOptions({ model: "inherit" } as never).model).toBe("inherit");
    expect(parseOptions({ model: "small" } as never).model).toBe("small");
  });
});

describe("parseModelRef", () => {
  test("parses provider/model strings", () => {
    expect(parseModelRef("openai/gpt-5.6")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6",
    });
  });

  test("rejects malformed refs", () => {
    expect(parseModelRef("")).toBeUndefined();
    expect(parseModelRef("nolash")).toBeUndefined();
    expect(parseModelRef("/leading")).toBeUndefined();
    expect(parseModelRef("trailing/")).toBeUndefined();
  });
});
