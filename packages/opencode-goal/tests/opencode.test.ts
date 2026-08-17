import { expect, test } from "bun:test";
import { adaptGoalClient, createdSessionID, httpJudge } from "../src/opencode.ts";

test("session reads do not send a GET body", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const client = adaptGoalClient({
    session: {
      async get(input: unknown) {
        calls.push({ name: "get", input });
        return { data: { agent: "build", model: { id: "glm-4.7", providerID: "zai" } } };
      },
      async messages(input: unknown) {
        calls.push({ name: "messages", input });
        return { data: [] };
      },
      async children(input: unknown) {
        calls.push({ name: "children", input });
        return { data: [] };
      },
    },
  });
  await client.session!("ses_1");
  await client.messages!("ses_1");
  await client.children!("ses_1");
  expect(calls.length).toBe(3);
  for (const call of calls) {
    expect(JSON.stringify(call.input)).not.toContain('"body"');
  }
});

test("reads a session id from wrapped and raw create responses", () => {
  expect(createdSessionID({ data: { id: "ses_a" } })).toBe("ses_a");
  expect(createdSessionID({ id: "ses_b" })).toBe("ses_b");
  expect(createdSessionID({ data: { info: { id: "ses_c" } } })).toBe("ses_c");
  expect(createdSessionID({ info: { id: "ses_d" } })).toBe("ses_d");
  expect(createdSessionID({ error: "nope" })).toBeUndefined();
});

test("judge keeps the SDK this-binding when creating a session", async () => {
  const created: unknown[] = [];
  const client = adaptGoalClient({
    session: {
      create(this: { label: string }, input: unknown) {
        if (this?.label !== "sdk") {
          throw new Error("undefined is not an object (evaluating 'this._client')");
        }
        created.push(input);
        return { id: "ses_bound" };
      },
      async prompt() {
        return { parts: [{ type: "text", text: '{"verdict":"met","reason":"ok"}' }] };
      },
      label: "sdk",
    },
  });
  expect(await client.judge!("prove it", {
    model: { id: "glm-4.7", providerID: "zai-coding-plan" },
  })).toContain('"verdict":"met"');
  expect(JSON.stringify(created[0])).toContain("glm-4.7");
});

test("http judge posts to /session and /session/:id/message", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const text = await httpJudge({
    baseUrl: "http://127.0.0.1:4096",
    directory: "/tmp/oc",
    prompt: "prove it",
    model: { id: "glm-4.7", providerID: "zai-coding-plan" },
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("/message")) {
        return new Response(JSON.stringify({
          parts: [{ type: "text", text: '{"verdict":"met","reason":"http"}' }],
        }), { status: 200 });
      }
      if (url.endsWith("/abort") || url.includes("/abort?")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ id: "ses_http" }), { status: 200 });
    },
  });
  expect(text).toContain('"verdict":"met"');
  expect(calls[0]?.url).toContain("/session?directory=");
  expect(calls[0]?.body).toEqual({
    title: "goal-judge",
    model: { id: "glm-4.7", providerID: "zai-coding-plan" },
  });
  expect(calls.some((call) => call.url.includes("/session/ses_http/message"))).toBe(
    true,
  );
});

test("judge uses the first create/prompt shape that returns text", async () => {
  const prompts: unknown[] = [];
  const client = adaptGoalClient({
    session: {
      async create() {
        return { id: "ses_judge" };
      },
      async prompt(input: unknown) {
        prompts.push(input);
        return {
          parts: [{
            type: "text",
            text: '{"verdict":"met","reason":"host check passed"}',
          }],
        };
      },
      async abort() {
        return {};
      },
    },
  });
  const text = await client.judge!("prove it");
  expect(text).toContain('"verdict":"met"');
  expect(prompts.length).toBe(1);
});
