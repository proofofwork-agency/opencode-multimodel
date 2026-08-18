/**
 * OpenCode 2 (beta) entry module. Verified against opencode2
 * v0.0.0-beta-17519 (see docs/opencode2-notes.md).
 *
 * Limitations on the OC2 beta, documented honestly:
 * - ctx.session has no messages API, so the parent-context snapshot is
 *   unavailable; side questions run context-less on a fresh session.
 * - generate() returns empty text for long prompts, so answers are capped
 *   to short generations and retried with a fresh session per attempt.
 */
import { parseBtwRequest } from "./slash.ts";

type Oc2Registry = {
  add?: (definition: unknown) => unknown;
  update?: (name: string, transform: (existing: unknown) => unknown) => unknown;
};

type Oc2SessionApi = {
  create: (input: { title: string }) => Promise<unknown>;
  generate: (input: Record<string, unknown>) => Promise<unknown>;
  interrupt?: (input: { sessionID: string }) => Promise<unknown>;
};

type Oc2Context = {
  command?: { transform: (fn: (registry: Oc2Registry) => unknown) => unknown };
  tool?: { transform: (fn: (registry: Oc2Registry) => unknown) => unknown };
  session?: Oc2SessionApi;
};

type Oc2ToolContext = { sessionID: string; agent?: string };

const BTW_COMMAND_TEMPLATE = [
  'The user ran the /btw command with arguments: "$ARGUMENTS"',
  "",
  "Parse the flags: --send merges the answer into this session as a user",
  "message after it arrives; --thread keeps a side thread open; --end closes",
  "it. Everything after the flags is the side question.",
  "Then call the btw tool exactly once with the parsed question and flags.",
].join("\n");

export function sessionIDFrom(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; data?: { id?: unknown } };
  if (typeof record.id === "string" && record.id) return record.id;
  if (typeof record.data?.id === "string" && record.data.id) {
    return record.data.id;
  }
  return undefined;
}

export function textFromGenerate(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const record = value as {
    text?: unknown;
    data?: { text?: unknown } | string;
  };
  if (typeof record.text === "string") return record.text.trim();
  if (typeof record.data === "string") return record.data.trim();
  if (typeof record.data?.text === "string") return record.data.text.trim();
  return "";
}

const THREADS = new Map<string, string>();

export function createBtwOc2(ctx: Oc2Context, options?: {
  timeoutMs?: number;
}) {
  const timeoutMs = options?.timeoutMs ?? 60_000;

  async function askSide(question: string): Promise<string> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error("A side question is required.");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let child: string | undefined;
      try {
        const created = await ctx.session!.create({
          title: `btw: ${trimmed.slice(0, 40)}`,
        });
        child = sessionIDFrom(created);
        if (!child) throw new Error("side session create returned no id");
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          timeoutMs,
        );
        try {
          const out = await Promise.race([
            ctx.session!.generate({
              sessionID: child,
              prompt: `Answer this side question concisely. Question: ${trimmed}`,
            }),
            new Promise<never>((_, reject) =>
              controller.signal.addEventListener("abort", () =>
                reject(new Error("side question timed out")), { once: true })
            ),
          ]);
          const text = textFromGenerate(out);
          if (text) return text;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // retry with a fresh session
      } finally {
        if (child) {
          await ctx.session!.interrupt?.({ sessionID: child }).catch(
            () => undefined,
          );
        }
      }
    }
    throw new Error(
      "The side question could not be answered (no text from the side model).",
    );
  }

  const commandRegistry = (registry: Oc2Registry) => {
    registry.update?.("btw", (existing) => ({
      ...(existing as object ?? {}),
      name: "btw",
      title: "btw",
      description: "Ask a one-shot side question without leaving the session",
      template: BTW_COMMAND_TEMPLATE,
    }));
    return registry;
  };

  const toolRegistry = (registry: Oc2Registry) => {
    registry.add?.({
      name: "btw",
      description:
        "Ask a one-shot side question in a fresh ephemeral session. Use for quick clarifications that do not need files, commands, or edits. Returns the answer text; it never enters the main transcript unless send=true.",
      args: {
        question: { type: "string", description: "the side question" },
        send: {
          type: "string",
          description:
            'set to "true" to merge the answer back into this session as context',
        },
      },
      async execute(
        args: { question: string; send?: string },
        sctx: Oc2ToolContext,
      ) {
        void sctx;
        try {
          const question = typeof args === "string"
            ? args
            : args?.question ?? "";
          const answer = await askSide(question);
          if (typeof args === "object" && args?.send?.toLowerCase() === "true") {
            return `Side answer (merge into context): ${answer}`;
          }
          return answer;
        } catch (error) {
          return `btw tool error: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      },
    });
    registry.add?.({
      name: "btw_end",
      description:
        "Close and delete the open side thread for this session. Only call when the user explicitly asked (/btw --end).",
      args: {},
      async execute(_args: unknown, sctx: Oc2ToolContext) {
        const child = THREADS.get(sctx.sessionID);
        if (!child) return "No open side thread.";
        THREADS.delete(sctx.sessionID);
        await ctx.session!.interrupt?.({ sessionID: child }).catch(
          () => undefined,
        );
        return "Side thread closed.";
      },
    });
    return registry;
  };

  return {
    wire() {
      ctx.command?.transform(commandRegistry);
      ctx.tool?.transform(toolRegistry);
    },
    commandRegistry,
    toolRegistry,
    askSide,
    parse: parseBtwRequest,
  };
}

const oc2Module = {
  id: "opencode-btw",
  effect: {},
  setup(ctx: Oc2Context) {
    createBtwOc2(ctx).wire();
    return {};
  },
};

export default oc2Module;
