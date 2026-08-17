import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { adaptPluginClient, asBtwClient } from "./client.ts";
import { parseOptions } from "./options.ts";
import { BTW_AGENT_ID, BTW_AGENT_PROMPT } from "./prompts.ts";
import { SideRegistry } from "./registry.ts";
import { BTW_DISABLED_TOOLS, BtwError, SideRunner } from "./runner.ts";

const server: Plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions);
  const client = input.client
    ? adaptPluginClient(input.client)
    : asBtwClient(createOpencodeClient({
      baseUrl: input.serverUrl?.toString(),
      directory: input.directory,
    }));
  let smallModel: string | undefined;
  const runner = new SideRunner(client, options, {
    smallModel: () => smallModel,
  });
  const registry = new SideRegistry(options.history);

  return {
    async config(config) {
      smallModel = typeof config.small_model === "string" &&
          config.small_model.trim()
        ? config.small_model.trim()
        : undefined;
      config.agent ??= {};
      const existing = config.agent[BTW_AGENT_ID];
      config.agent[BTW_AGENT_ID] = {
        ...existing,
        description: existing?.description ??
          "Ephemeral side questions about the current session; never enters the main transcript",
        mode: existing?.mode ?? "subagent",
        prompt: existing?.prompt ?? BTW_AGENT_PROMPT,
        tools: { ...BTW_DISABLED_TOOLS, ...existing?.tools },
        permission: {
          edit: "deny",
          bash: { "*": "deny" },
          webfetch: "deny",
          external_directory: "deny",
          doom_loop: "deny",
          ...existing?.permission,
        },
        maxSteps: existing?.maxSteps ?? 1,
      };
    },
    async "chat.params"(request, output) {
      if (!runner.isChild(request.sessionID)) return;
      output.maxOutputTokens = options.maxOutputTokens;
      output.temperature = 0;
    },
    async event(event) {
      if (event.event.type === "session.deleted") {
        const sessionID = event.event.properties.info.id;
        registry.clear(sessionID);
        await runner.cancelFor(sessionID);
        return;
      }
      if (event.event.type === "message.part.updated") {
        runner.consumePartEvent(event.event.properties.part);
      }
    },
    tool: options.tool
      ? {
        btw: tool({
          description:
            "Ask a one-shot side question about the current session. The question is answered from a bounded snapshot of the session by a tool-less ephemeral child session and the exchange never enters the main transcript. Use it for quick clarifications, not for work that needs files, commands, or edits.",
          args: {
            question: tool.schema
              .string()
              .min(1)
              .describe("The side question to answer from existing session context"),
          },
          async execute(args, context) {
            try {
              const exchange = await runner.ask({
                sessionID: context.sessionID,
                question: args.question,
                signal: context.abort,
              });
              registry.record(exchange);
              return {
                title: "btw · answered",
                output: exchange.answer,
                metadata: {
                  btwExchangeID: exchange.id,
                  model: exchange.model,
                  durationMs: exchange.durationMs,
                },
              };
            } catch (error) {
              if (error instanceof BtwError) {
                return {
                  title: "btw · failed",
                  output: `${error.code}: ${error.message}`,
                  metadata: { btwErrorCode: error.code },
                };
              }
              throw error;
            }
          },
        }),
      }
      : undefined,
    async dispose() {
      await runner.dispose();
      registry.clear();
    },
  };
};

export default { id: "opencode-btw", server } satisfies PluginModule;
