import { describe, expect, test } from "bun:test";
import { inheritModel, renderSnapshot } from "../src/snapshot.ts";

function message(
  role: "user" | "assistant",
  text: string,
  extra: { model?: { providerID: string; modelID: string } } = {},
) {
  return {
    role,
    model: extra.model,
    parts: [{ type: "text", text }],
  };
}

describe("renderSnapshot", () => {
  test("renders roles and text with blank-line separation", () => {
    const snapshot = renderSnapshot(
      [
        message("user", "fix the parser"),
        message("assistant", "I refactored parse() and added tests."),
      ],
      { maxMessages: 40, maxChars: 48_000 },
    );
    expect(snapshot.text).toBe(
      "[user]\nfix the parser\n\n[assistant]\nI refactored parse() and added tests.",
    );
    expect(snapshot.messageCount).toBe(2);
    expect(snapshot.truncatedMessages).toBe(0);
    expect(snapshot.truncatedChars).toBe(false);
  });

  test("summarizes tool parts and skips step noise and synthetic text", () => {
    const snapshot = renderSnapshot(
      [
        {
          role: "assistant",
          parts: [
            { type: "step-start" },
            { type: "text", text: "checking", synthetic: true },
            { type: "tool", tool: "read", state: { status: "completed" } },
            { type: "tool", tool: "bash", state: "running" },
            { type: "step-finish", reason: "stop" },
            { type: "text", text: "the config was in src/config.ts" },
          ],
        },
      ],
      { maxMessages: 40, maxChars: 48_000 },
    );
    expect(snapshot.text).toBe(
      "[assistant]\n[tool read]\n[tool bash (running)]\nthe config was in src/config.ts",
    );
  });

  test("drops oldest messages beyond maxMessages with a marker", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message("user", `m${index}`),
    );
    const snapshot = renderSnapshot(messages, { maxMessages: 3, maxChars: 48_000 });
    expect(snapshot.truncatedMessages).toBe(7);
    expect(snapshot.messageCount).toBe(3);
    expect(snapshot.text.startsWith("[... 7 earlier messages truncated ...]"))
      .toBe(true);
    expect(snapshot.text).toContain("m9");
    expect(snapshot.text).not.toContain("m2\n");
  });

  test("stops at the character budget from the newest side", () => {
    const messages = [
      message("user", "x".repeat(200)),
      message("assistant", "y".repeat(50)),
      message("user", "z".repeat(50)),
    ];
    const snapshot = renderSnapshot(messages, { maxMessages: 40, maxChars: 120 });
    expect(snapshot.truncatedChars).toBe(true);
    expect(snapshot.text).toContain("z");
    expect(snapshot.text).not.toContain("xxxx");
  });

  test("marks compaction summaries", () => {
    const snapshot = renderSnapshot(
      [
        {
          role: "assistant",
          summary: true,
          parts: [{ type: "text", text: "earlier work summarized" }],
        },
      ],
      { maxMessages: 40, maxChars: 48_000 },
    );
    expect(snapshot.text).toContain("[assistant (compaction summary)]");
  });

  test("skips messages without renderable parts", () => {
    const snapshot = renderSnapshot(
      [
        { role: "user", parts: [{ type: "step-start" }] },
        message("user", "real"),
      ],
      { maxMessages: 40, maxChars: 48_000 },
    );
    expect(snapshot.messageCount).toBe(1);
    expect(snapshot.text).toBe("[user]\nreal");
  });
});

describe("inheritModel", () => {
  test("returns the newest message model", () => {
    expect(
      inheritModel([
        message("user", "a", { model: { providerID: "p", modelID: "old" } }),
        message("user", "b", { model: { providerID: "p", modelID: "new" } }),
      ]),
    ).toEqual({ providerID: "p", modelID: "new" });
  });

  test("returns undefined when no message carries a model", () => {
    expect(inheritModel([message("user", "a")])).toBeUndefined();
    expect(inheritModel([])).toBeUndefined();
  });
});
