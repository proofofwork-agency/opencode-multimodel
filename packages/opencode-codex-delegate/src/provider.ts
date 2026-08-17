import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from "@ai-sdk/provider";
import {
  CodexProviderRuntime,
  getInstalledProviderRuntime,
  type ProviderDefaults,
} from "./provider-runtime.js";

export type CodexDelegateProviderOptions = {
  name?: string;
  directory?: string;
  executable?: string;
  stateDir?: string;
  mode?: ProviderDefaults["mode"];
  isolation?: ProviderDefaults["isolation"];
  approvalPolicy?: ProviderDefaults["approvalPolicy"];
  timeoutMs?: number;
  confirmedUnsafe?: boolean;
  runtimeKey?: string;
  runtime?: CodexProviderRuntime;
};

export function createCodexDelegateProvider(
  options: CodexDelegateProviderOptions = {},
) {
  const provider = options.name?.trim() || "codex-delegate";
  const runtime =
    options.runtime ??
    getInstalledProviderRuntime(options.runtimeKey) ??
    new CodexProviderRuntime({
      directory: options.directory ?? process.cwd(),
      executable: options.executable,
      stateDir: options.stateDir,
      defaults: {
        mode: options.mode === "read-only" ? "read-only" : "write",
        isolation: options.isolation === "current" ? "current" : "worktree",
        approvalPolicy:
          options.approvalPolicy === "auto" ||
          options.approvalPolicy === "bypass"
            ? options.approvalPolicy
            : "ask",
        timeoutMs: validTimeout(options.timeoutMs),
        confirmedUnsafe: options.confirmedUnsafe === true,
      },
    });
  const languageModel = (modelId: string) =>
    new CodexDelegateLanguageModel(provider, modelId, runtime);
  return {
    languageModel,
    chat: languageModel,
    responses: languageModel,
  };
}

class CodexDelegateLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly supportedUrls = {};

  constructor(
    readonly provider: string,
    readonly modelId: string,
    private readonly runtime: CodexProviderRuntime,
  ) {}

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    const result = await this.run(options);
    requireCompletedTurn(result);
    const reasoning = result.events
      .filter((event) => event.kind === "reasoning" && event.text)
      .map((event) => event.text)
      .join("");
    const output = result.output || "Codex completed without text output.";
    return {
      content: [
        ...(reasoning
          ? [
              {
                type: "reasoning" as const,
                text: reasoning,
              },
            ]
          : []),
        {
          type: "text" as const,
          text: output,
        },
      ],
      finishReason: finishReason(result.status),
      usage: usage(result.usage),
      providerMetadata: metadata(this.provider, result),
      response: {
        id: result.id,
        timestamp: new Date(result.startedAt),
        modelId: this.modelId,
      },
      warnings: warnings(options),
    };
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const abort = new AbortController();
    const signal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, abort.signal])
      : abort.signal;
    let open = true;
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          const enqueue = (part: LanguageModelV3StreamPart) => {
            if (open) controller.enqueue(part);
          };
          const textID = `text-${crypto.randomUUID()}`;
          const reasoningID = `reasoning-${crypto.randomUUID()}`;
          let textStarted = false;
          let reasoningStarted = false;
          const run = this.run(options, signal, (event) => {
            if (event.kind === "reasoning" && event.text) {
              if (!reasoningStarted) {
                enqueue({ type: "reasoning-start", id: reasoningID });
                reasoningStarted = true;
              }
              enqueue({
                type: "reasoning-delta",
                id: reasoningID,
                delta: event.text,
              });
              return;
            }
            if (event.kind !== "text" || !event.text) return;
            const snapshot =
              event.method === "item/completed" ||
              event.method === "item.completed";
            if (snapshot && textStarted) return;
            if (!textStarted) {
              enqueue({ type: "text-start", id: textID });
              textStarted = true;
            }
            enqueue({ type: "text-delta", id: textID, delta: event.text });
          });
          enqueue({ type: "stream-start", warnings: warnings(options) });
          enqueue({
            type: "response-metadata",
            id: crypto.randomUUID(),
            timestamp: new Date(),
            modelId: this.modelId,
          });
          void run
            .then((result) => {
              requireCompletedTurn(result);
              const output = result.output ||
                "Codex completed without text output.";
              if (!textStarted && output) {
                enqueue({ type: "text-start", id: textID });
                enqueue({
                  type: "text-delta",
                  id: textID,
                  delta: output,
                });
                textStarted = true;
              }
              if (reasoningStarted)
                enqueue({ type: "reasoning-end", id: reasoningID });
              if (textStarted) enqueue({ type: "text-end", id: textID });
              enqueue({
                type: "finish",
                usage: usage(result.usage),
                finishReason: finishReason(result.status),
                providerMetadata: metadata(this.provider, result),
              });
            })
            .catch((error: unknown) => {
              enqueue({ type: "error", error });
              enqueue({
                type: "finish",
                usage: emptyUsage(),
                finishReason: { unified: "error", raw: "delegate-error" },
              });
            })
            .finally(() => {
              if (open) controller.close();
              open = false;
            });
        },
        cancel() {
          open = false;
          abort.abort();
        },
      }),
    };
  }

  private run(
    options: LanguageModelV3CallOptions,
    signal = options.abortSignal,
    onEvent?: Parameters<CodexProviderRuntime["run"]>[0]["onEvent"],
  ) {
    const providerOptions = options.providerOptions?.[this.provider] ?? {};
    return this.runtime.run({
      sessionID:
        stringValue(providerOptions.sessionID) ?? `direct-${crypto.randomUUID()}`,
      agent: stringValue(providerOptions.agent) ?? "primary",
      messageID: stringValue(providerOptions.messageID),
      model: this.modelId,
      fullPrompt: renderConversation(options.prompt),
      latestPrompt: renderLatest(options.prompt),
      reasoningEffort:
        stringValue(providerOptions.reasoningEffort) ??
        stringValue(providerOptions.effort),
      signal,
      onEvent,
    });
  }
}

function renderConversation(prompt: LanguageModelV3CallOptions["prompt"]) {
  return prompt.map(renderMessage).filter(Boolean).join("\n\n");
}

function renderLatest(prompt: LanguageModelV3CallOptions["prompt"]) {
  const latest = prompt.findLast(
    (message) => message.role === "user" || message.role === "tool",
  );
  return latest ? renderMessage(latest) : renderConversation(prompt);
}

function renderMessage(message: LanguageModelV3Message) {
  if (message.role === "system") return `System:\n${message.content}`;
  return `${capitalize(message.role)}:\n${message.content
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text;
      if (part.type === "file")
        return `[File: ${part.filename ?? "attachment"} (${part.mediaType})]`;
      if (part.type === "tool-call")
        return `[Tool call ${part.toolName}: ${JSON.stringify(part.input)}]`;
      if (part.type === "tool-result")
        return `[Tool result ${part.toolName}: ${JSON.stringify(part.output)}]`;
      return `[Tool approval ${part.approvalId}: ${part.approved ? "approved" : "denied"}]`;
    })
    .join("\n")}`;
}

function warnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  return [
    ...(options.tools?.length
      ? [
          {
            type: "compatibility" as const,
            feature: "tools",
            details:
              "The Codex delegate uses the Codex CLI tool surface; OpenCode tool definitions are not forwarded.",
          },
        ]
      : []),
    ...([
      ["temperature", options.temperature],
      ["topP", options.topP],
      ["topK", options.topK],
      ["stopSequences", options.stopSequences],
      ["seed", options.seed],
      ["presencePenalty", options.presencePenalty],
      ["frequencyPenalty", options.frequencyPenalty],
      ["responseFormat", options.responseFormat?.type === "json"],
    ] as const).flatMap(([feature, value]) =>
      value === undefined || value === false
        ? []
        : [
            {
              type: "unsupported" as const,
              feature,
              details: "Codex app-server does not expose this through the delegate adapter.",
            },
          ],
    ),
  ];
}

function usage(value: {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: value.inputTokens ?? undefined,
      noCache:
        value.inputTokens === null
          ? undefined
          : Math.max(0, value.inputTokens - (value.cachedInputTokens ?? 0)),
      cacheRead: value.cachedInputTokens ?? undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: value.outputTokens ?? undefined,
      text:
        value.outputTokens === null
          ? undefined
          : Math.max(0, value.outputTokens - (value.reasoningTokens ?? 0)),
      reasoning: value.reasoningTokens ?? undefined,
    },
  };
}

function emptyUsage(): LanguageModelV3Usage {
  return usage({
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
  });
}

function requireCompletedTurn(result: {
  status: string;
  error?: { message?: string } | null;
}) {
  if (result.status === "completed") return;
  throw new Error(
    result.error?.message?.trim() || `Codex delegate ${result.status}.`,
  );
}

function finishReason(status: string): LanguageModelV3FinishReason {
  if (status === "completed") return { unified: "stop", raw: status };
  if (status === "cancelled") return { unified: "other", raw: status };
  return { unified: "error", raw: status };
}

function metadata(
  provider: string,
  result: {
    threadId: string | null;
    turnId: string | null;
    status: string;
    truncated: boolean;
    malformedEvents: number;
  },
): SharedV3ProviderMetadata {
  return {
    [provider]: {
      threadId: result.threadId,
      turnId: result.turnId,
      status: result.status,
      truncated: result.truncated,
      malformedEvents: result.malformedEvents,
    },
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validTimeout(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 3_600_000
    ? value
    : 300_000;
}

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
