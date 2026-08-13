import { describe, expect, test } from "bun:test";
import { DelegateEventCollector, decodeEvent } from "../src/events.ts";

describe("structured Codex events", () => {
  test("decodes text, tool, usage, and completion notifications", () => {
    expect(
      decodeEvent({
        method: "item/agentMessage/delta",
        params: { threadId: "t", turnId: "r", delta: "hello" },
      })[0],
    ).toMatchObject({
      kind: "text",
      text: "hello",
      threadId: "t",
      turnId: "r",
    });
    expect(
      decodeEvent({
        method: "item/completed",
        params: {
          item: {
            id: "i",
            type: "fileChange",
            changes: [{ path: "src/a.ts" }],
          },
        },
      })[0],
    ).toMatchObject({
      kind: "file",
      itemId: "i",
      text: "src/a.ts",
    });
    expect(
      decodeEvent({
        method: "item/completed",
        params: {
          item: {
            id: "review",
            type: "exitedReviewMode",
            review: "No findings.",
          },
        },
      })[0],
    ).toMatchObject({
      kind: "text",
      text: "No findings.",
    });
  });

  test("replaces a streamed item with its completed snapshot without duplicating output", () => {
    const collector = new DelegateEventCollector();
    collector.push({
      method: "item/agentMessage/delta",
      params: { itemId: "i", delta: "hello " },
    });
    collector.push({
      method: "item/agentMessage/delta",
      params: { itemId: "i", delta: "world" },
    });
    collector.push({
      method: "item/completed",
      params: { item: { id: "i", type: "agentMessage", text: "hello world" } },
    });
    collector.push({
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { inputTokens: 10, outputTokens: 2 } },
    });
    collector.push({
      method: "turn/completed",
      params: { turn: { id: "r", status: "completed" } },
    });
    expect(collector.snapshot()).toMatchObject({
      output: "hello world",
      status: "completed",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
  });

  test("bounds retained events and preserves rate-limit status", () => {
    const collector = new DelegateEventCollector({
      maxEvents: 1,
      maxBytes: 1_000,
    });
    collector.push({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 100 } } },
    });
    collector.push({
      method: "turn/completed",
      params: { turn: { status: "failed" } },
    });
    collector.markMalformed();
    expect(collector.snapshot()).toMatchObject({
      status: "rate-limited",
      malformed: 1,
      truncated: true,
      error: "Codex rate limit 100% used",
    });
  });
});
