import { describe, expect, test } from "bun:test";
import type { BtwClient } from "../src/client.ts";
import { parseOptions } from "../src/options.ts";
import { BtwError, SideRunner, childTitle } from "../src/runner.ts";
import { SideRegistry } from "../src/registry.ts";

type PromptCall = {
  sessionID: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  system?: string;
  tools?: Record<string, boolean>;
  parts: Array<{ type: "text"; text: string }>;
};

function fakeClient(overrides: Partial<{
  answer: string;
  promptBehavior: () => Promise<never>;
  messages: BtwClient["session"]["messages"];
}> = {}) {
  const state = {
    created: [] as Array<{ parentID?: string; title?: string }>,
    prompted: [] as PromptCall[],
    aborted: [] as string[],
    deleted: [] as string[],
  };
  const client: BtwClient = {
    session: {
      async create(input) {
        state.created.push(input);
        return { data: { id: `child-${state.created.length}` } };
      },
      async messages(input) {
        if (overrides.messages) return overrides.messages(input);
        return {
          data: [
            {
              info: {
                role: "user",
                model: { providerID: "test", modelID: "main" },
              },
              parts: [{ type: "text", text: "fix the parser" }],
            },
            {
              info: {
                role: "assistant",
                model: { providerID: "test", modelID: "main" },
              },
              parts: [
                { type: "text", text: "I refactored parse() and added tests." },
              ],
            },
          ],
        };
      },
      async prompt(input) {
        state.prompted.push(input);
        if (overrides.promptBehavior) return overrides.promptBehavior();
        return {
          data: {
            info: {},
            parts: [{ type: "text", text: overrides.answer ?? "side answer" }],
          },
        };
      },
      async abort(input) {
        state.aborted.push(input.sessionID);
        return { data: true };
      },
      async delete(input) {
        state.deleted.push(input.sessionID);
        return { data: true };
      },
    },
  };
  return { client, state };
}

function fastOptions(extra: Record<string, unknown> = {}) {
  return parseOptions({ timeoutMs: 1_000, ...extra } as never);
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SideRunner.ask", () => {
  test("runs the full ephemeral child lifecycle", async () => {
    const { client, state } = fakeClient({ answer: "because of retries" });
    const runner = new SideRunner(client, fastOptions());
    const exchange = await runner.ask({
      sessionID: "parent",
      question: "  why the retry helper?  ",
    });

    expect(exchange).toMatchObject({
      parentSessionID: "parent",
      question: "why the retry helper?",
      answer: "because of retries",
      status: "answered",
      model: "test/main",
    });
    expect(state.created).toEqual([
      { parentID: "parent", title: childTitle("why the retry helper?") },
    ]);
    expect(state.created[0]?.title?.startsWith("btw: ")).toBe(true);
    expect(state.prompted).toHaveLength(1);
    const prompt = state.prompted[0]!;
    expect(prompt.sessionID).toBe("child-1");
    expect(prompt.model).toEqual({ providerID: "test", modelID: "main" });
    expect(prompt.agent).toBe("btw");
    expect(prompt.system).toContain("reference context only");
    expect(prompt.tools?.bash).toBe(false);
    expect(prompt.tools?.read).toBe(false);
    expect(prompt.tools?.task).toBe(false);
    expect(prompt.parts[0]?.text).toContain("<session-snapshot>");
    expect(prompt.parts[0]?.text).toContain("[user]");
    expect(prompt.parts[1]?.text).toContain("<side-question>");
    expect(prompt.parts[1]?.text).toContain("why the retry helper?");
    expect(state.deleted).toEqual(["child-1"]);
    expect(state.aborted).toEqual([]);
    expect(runner.isChild("child-1")).toBe(false);
  });

  test("rejects empty questions", async () => {
    const { client } = fakeClient();
    const runner = new SideRunner(client, fastOptions());
    await expect(runner.ask({ sessionID: "p", question: "   " })).rejects
      .toMatchObject({ code: "EMPTY_QUESTION" });
  });

  test("enforces per-session concurrency", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = fakeClient();
    client.session.prompt = async () => {
      await gate;
      return { data: { info: {}, parts: [{ type: "text", text: "late" }] } };
    };
    const runner = new SideRunner(client, fastOptions());
    const first = runner.ask({ sessionID: "p", question: "one" });
    await settle();
    await expect(runner.ask({ sessionID: "p", question: "two" })).rejects
      .toMatchObject({ code: "BUSY" });
    release();
    await expect(first).resolves.toMatchObject({ answer: "late" });
  });

  test("times out, aborts, and still deletes the child", async () => {
    const { client, state } = fakeClient();
    client.session.prompt = () => new Promise(() => {});
    const runner = new SideRunner(client, fastOptions());
    const pending = runner.ask({ sessionID: "parent", question: "slow" });
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(state.aborted).toEqual(["child-1"]);
    expect(state.deleted).toEqual(["child-1"]);
  });

  test("surfaces model errors and deletes the child", async () => {
    const { client, state } = fakeClient();
    client.session.prompt = async () => ({
      data: { info: { error: "rate limited" }, parts: [] },
    });
    const runner = new SideRunner(client, fastOptions());
    await expect(
      runner.ask({ sessionID: "parent", question: "q" }),
    ).rejects.toMatchObject({ code: "MODEL_ERROR" });
    expect(state.deleted).toEqual(["child-1"]);
  });

  test("fails when the answer has no text", async () => {
    const { client } = fakeClient();
    client.session.prompt = async () => ({
      data: { info: {}, parts: [{ type: "tool", tool: "read" }] },
    });
    const runner = new SideRunner(client, fastOptions());
    await expect(runner.ask({ sessionID: "parent", question: "q" })).rejects
      .toMatchObject({ code: "EMPTY_ANSWER" });
  });

  test("respects an abort signal", async () => {
    const { client, state } = fakeClient();
    let release: () => void = () => {};
    client.session.prompt = () => new Promise((_resolve, reject) => {
      release = () => reject(new Error("aborted by test"));
    });
    const controller = new AbortController();
    const runner = new SideRunner(client, fastOptions());
    const pending = runner.ask({
      sessionID: "parent",
      question: "q",
      signal: controller.signal,
    });
    controller.abort();
    release();
    await expect(pending).rejects.toThrow();
    expect(state.deleted).toEqual(["child-1"]);
  });

  test("model small defers to the smallModel hook with inherit fallback", async () => {
    const { client, state } = fakeClient();
    const runner = new SideRunner(client, fastOptions({ model: "small" }), {
      smallModel: () => "test/small-model",
    });
    await runner.ask({ sessionID: "p", question: "q" });
    expect(state.prompted[0]!.model).toEqual({
      providerID: "test",
      modelID: "small-model",
    });

    const fallback = new SideRunner(client, fastOptions({ model: "small" }), {
      smallModel: () => undefined,
    });
    await fallback.ask({ sessionID: "p", question: "q" });
    expect(state.prompted[1]!.model).toEqual({
      providerID: "test",
      modelID: "main",
    });
  });

  test("explicit model overrides inheritance", async () => {
    const { client, state } = fakeClient();
    const runner = new SideRunner(
      client,
      fastOptions({ model: "other/explicit" }),
    );
    await runner.ask({ sessionID: "p", question: "q" });
    expect(state.prompted[0]!.model).toEqual({
      providerID: "other",
      modelID: "explicit",
    });
  });

  test("forwards streaming part updates for live children", async () => {
    let captureRelease: (parts: unknown) => void = () => {};
    const { client } = fakeClient();
    client.session.prompt = () => new Promise((resolve) => {
      captureRelease = (parts) =>
        resolve({ data: { info: {}, parts } } as never);
    });
    const updates: string[] = [];
    const runner = new SideRunner(client, fastOptions());
    const pending = runner.ask({
      sessionID: "parent",
      question: "q",
      onUpdate: (text) => updates.push(text),
    });
    await settle();
    runner.consumePartEvent({
      id: "p1",
      sessionID: "child-1",
      type: "text",
      text: "partial",
    });
    runner.consumePartEvent({
      id: "p1",
      sessionID: "child-1",
      type: "text",
      text: "partial update",
    });
    runner.consumePartEvent({
      id: "p2",
      sessionID: "child-1",
      type: "text",
      text: " more",
    });
    runner.consumePartEvent({ id: "x", sessionID: "other", type: "text", text: "no" });
    runner.consumePartEvent({
      id: "p3",
      sessionID: "child-1",
      type: "text",
      text: "synthetic",
      synthetic: true,
    });
    captureRelease([{ type: "text", text: "partial update more" }]);
    const exchange = await pending;
    expect(exchange.answer).toBe("partial update more");
    expect(updates).toEqual(["partial", "partial update", "partial update more"]);
  });

  test("cancelFor aborts only that parent's children", async () => {
    const gates: Array<() => void> = [];
    const { client, state } = fakeClient();
    client.session.prompt = () => new Promise((resolve) => {
      gates.push(() =>
        resolve({ data: { info: {}, parts: [{ type: "text", text: "ok" }] } } as never)
      );
    });
    const runner = new SideRunner(client, fastOptions({ concurrency: 3 }));
    const one = runner.ask({ sessionID: "p1", question: "one" });
    const two = runner.ask({ sessionID: "p2", question: "two" });
    await settle();
    await runner.cancelFor("p1");
    expect(state.aborted).toEqual(["child-1"]);
    gates.forEach((release) => release());
    await Promise.all([one, two]);
    expect(state.deleted).toEqual(["child-1", "child-2"]);
  });
});

describe("childTitle", () => {
  test("prefixes and truncates", () => {
    expect(childTitle("what changed?")).toBe("btw: what changed?");
    expect(
      childTitle(
        "a very long question that goes well beyond any reasonable title limit",
      ).length,
    ).toBeLessThanOrEqual(53);
  });
});

describe("SideRegistry", () => {
  test("keeps a bounded ring per session", () => {
    const registry = new SideRegistry(2);
    const exchange = (id: string, parent = "p"): Parameters<
      SideRegistry["record"]
    >[0] => ({
      id,
      parentSessionID: parent,
      question: `q${id}`,
      answer: `a${id}`,
      status: "answered",
      createdAt: 0,
      durationMs: 1,
    });
    registry.record(exchange("1"));
    registry.record(exchange("2"));
    registry.record(exchange("3"));
    expect(registry.list("p").map((item) => item.id)).toEqual(["2", "3"]);
    expect(registry.list("other")).toEqual([]);
    expect(registry.clear("p")).toBe(2);
    expect(registry.list("p")).toEqual([]);
    registry.record(exchange("4"));
    expect(registry.clear()).toBe(1);
  });

  test("records nothing when disabled", () => {
    const registry = new SideRegistry(0);
    registry.record({
      id: "1",
      parentSessionID: "p",
      question: "q",
      answer: "a",
      status: "answered",
      createdAt: 0,
      durationMs: 1,
    });
    expect(registry.list("p")).toEqual([]);
  });
});

describe("BtwError", () => {
  test("carries a stable code", () => {
    const error = new BtwError("BUSY", "nope");
    expect(error.name).toBe("BtwError");
    expect(error.code).toBe("BUSY");
    expect(error.message).toBe("nope");
  });
});

describe("SideRunner threads", () => {
  test("askThread keeps the child alive and continues it on the next call", async () => {
    const { client, state } = fakeClient();
    const runner = new SideRunner(client, fastOptions());
    const first = await runner.askThread({
      sessionID: "parent",
      question: "what is this codebase?",
    });
    expect(first.answer).toBe("side answer");
    expect(state.deleted).toEqual([]);
    const child = runner.threadChild("parent");
    expect(child).toBeDefined();

    const second = await runner.askThread({
      sessionID: "parent",
      question: "and the entry point?",
    });
    expect(second.answer).toBe("side answer");
    // Continuation prompts the SAME child; no snapshot parts, only the question.
    expect(state.created).toHaveLength(1);
    const lastPrompt = state.prompted.at(-1)!;
    expect(lastPrompt.sessionID).toBe(child!);
    // Continuation sends only the question part (single text part), no snapshot preamble.
    expect(lastPrompt.parts).toHaveLength(1);
    expect(state.deleted).toEqual([]);

    expect(runner.endThread("parent")).resolves.toBe(true);
    await runner.endThread("parent");
    expect(state.deleted).toContain(child!);
    expect(runner.threadChild("parent")).toBeUndefined();
  });

  test("plain ask never leaves a child behind even after thread usage", async () => {
    const { client, state } = fakeClient();
    const runner = new SideRunner(client, fastOptions());
    await runner.askThread({ sessionID: "parent", question: "start thread" });
    const oneShot = await runner.ask({ sessionID: "parent", question: "quick one" });
    expect(oneShot.answer).toBe("side answer");
    const threadChild = runner.threadChild("parent");
    expect(threadChild).toBeDefined();
    // The one-shot child was deleted; the thread child survives.
    expect(state.deleted).toHaveLength(1);
    expect(state.deleted[0]).not.toBe(threadChild);
    await runner.endThread("parent");
  });
});
