import { describe, expect, test } from "bun:test";
import type { Config } from "@opencode-ai/plugin";
import serverModule from "../src/server.ts";

type AgentConfig = NonNullable<Config["agent"]>[string];

function fakeClient(answer = "side answer") {
  const state = {
    created: [] as Array<{ parentID?: string; title?: string }>,
    prompted: [] as Array<Record<string, unknown> & { id: string }>,
    aborted: [] as string[],
    deleted: [] as string[],
  };
  let gate: Promise<void> | undefined;
  const client = {
    session: {
      async create(input: { body: { parentID?: string; title?: string } }) {
        state.created.push(input.body);
        return { data: { id: `child-${state.created.length}` } };
      },
      async messages(input: { path: { id: string } }) {
        return {
          data: [
            {
              info: {
                role: "user",
                model: { providerID: "test", modelID: "main" },
              },
              parts: [{ type: "text", text: "fix the parser" }],
            },
          ],
        };
      },
      async prompt(input: { path: { id: string }; body: Record<string, unknown> }) {
        state.prompted.push({ id: input.path.id, ...input.body });
        if (gate) await gate;
        return {
          data: { info: {}, parts: [{ type: "text", text: answer }] },
        };
      },
      async abort(input: { path: { id: string } }) {
        state.aborted.push(input.path.id);
        return { data: true };
      },
      async delete(input: { path: { id: string } }) {
        state.deleted.push(input.path.id);
        return { data: true };
      },
    },
  };
  return {
    client,
    state,
    holdPrompt(promise: Promise<void>) {
      gate = promise;
    },
  };
}

async function startPlugin(
  options?: Record<string, unknown>,
  answer = "side answer",
) {
  const { client, state, holdPrompt } = fakeClient(answer);
  const plugin = await serverModule.server(
    {
      directory: `${process.env.TMPDIR ?? "/tmp"}/opencode-btw-${crypto.randomUUID()}`,
      client,
      serverUrl: new URL("http://127.0.0.1:1"),
    } as never,
    options as never,
  );
  return { plugin, state, holdPrompt };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("server plugin", () => {
  test("registers the tool-less btw agent", async () => {
    const { plugin } = await startPlugin();
    const config: {
      small_model?: string;
      agent?: Record<string, AgentConfig>;
    } = { small_model: "test/small" };
    await plugin.config?.(config as never);

    const agent = config.agent?.btw;
    expect(agent).toBeDefined();
    expect(agent?.mode).toBe("subagent");
    expect(agent?.prompt).toContain("reference context only");
    expect(agent?.tools).toMatchObject({
      bash: false,
      read: false,
      write: false,
      task: false,
      webfetch: false,
      btw: false,
    });
    expect(Object.values(agent?.tools ?? {})).not.toContain(true);
    expect(agent?.permission).toMatchObject({
      edit: "deny",
      webfetch: "deny",
      external_directory: "deny",
    });
    expect(agent?.maxSteps).toBe(1);
    expect("build" in (config.agent ?? {})).toBe(false);
  });

  test("does not register a command or tool by default", async () => {
    const { plugin } = await startPlugin();
    const config: Record<string, unknown> = {};
    await plugin.config?.(config as never);
    expect(config.command).toBeUndefined();
    expect(plugin.tool).toBeUndefined();
  });

  test("clamps chat params for live child sessions only", async () => {
    const { plugin, state, holdPrompt } = await startPlugin({
      tool: true,
      maxOutputTokens: 512,
    });
    const readParams = async (sessionID: string) => {
      const output = {
        temperature: 1,
        topP: 1,
        topK: 40,
        maxOutputTokens: undefined as number | undefined,
        options: {},
      };
      await plugin["chat.params"]?.(
        {
          sessionID,
          agent: "btw",
          model: { providerID: "test", modelID: "main" },
          provider: {},
          message: {},
        } as never,
        output,
      );
      return output;
    };
    expect((await readParams("unrelated")).maxOutputTokens).toBeUndefined();
    expect((await readParams("unrelated")).temperature).toBe(1);

    let release: () => void = () => {};
    holdPrompt(new Promise((resolve) => {
      release = resolve;
    }));
    const pending = plugin.tool?.btw?.execute(
      { question: "what file?" },
      { sessionID: "parent", abort: new AbortController().signal } as never,
    );
    await settle();
    const childID = state.prompted[0]?.id;
    expect(childID).toBe("child-1");
    const childOutput = await readParams(childID!);
    expect(childOutput.maxOutputTokens).toBe(512);
    expect(childOutput.temperature).toBe(0);
    release();
    const exchange = await pending;
    expect(exchange).toMatchObject({
      title: "btw · answered",
      output: "side answer",
    });
    expect(state.deleted).toEqual(["child-1"]);
  });

  test("btw tool runs an ephemeral exchange and reports failures", async () => {
    const failing = await startPlugin({ tool: true }, "");
    const failure = await failing.plugin.tool?.btw?.execute(
      { question: "q" },
      { sessionID: "parent", abort: new AbortController().signal } as never,
    ) as { title?: string; output?: string };
    expect(failure).toMatchObject({ title: "btw · failed" });
    expect(String(failure?.output)).toContain("EMPTY_ANSWER");
    expect(failing.state.deleted).toEqual(["child-1"]);
  });

  test("cleans up on session.deleted and dispose", async () => {
    const { plugin, state } = await startPlugin();
    await plugin.event?.({
      event: {
        type: "session.deleted",
        properties: { info: { id: "parent" } },
      },
    } as never);
    await plugin.dispose?.();
    expect(state.aborted).toEqual([]);
    expect(state.deleted).toEqual([]);
  });

  test("forwards message part updates to the runner", async () => {
    const { plugin } = await startPlugin();
    await expect(
      plugin.event?.({
        event: {
          type: "message.part.updated",
          properties: { part: { sessionID: "ghost", type: "text", text: "x" } },
        },
      } as never),
    ).resolves.toBeUndefined();
  });
});
