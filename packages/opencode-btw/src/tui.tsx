/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiRouteCurrent,
} from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createSignal, onCleanup, onMount, Show, type Setter } from "solid-js";
import { asBtwClient } from "./client.ts";
import { parseOptions } from "./options.ts";
import { SideRegistry } from "./registry.ts";
import { BtwError, SideRunner, type SideExchange } from "./runner.ts";
import { btwSlashQuestion, parseBtwRequest } from "./slash.ts";

const SUBMIT_PRIORITY = 20_000;

const ROUTE_ANSWER = "btw.answer";

type OverlayState = {
  question: string;
  status: "pending" | "answered" | "failed";
  text: string;
  model?: string;
  error?: string;
};

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = parseOptions(rawOptions);
  const client = asBtwClient(api.client);
  const registry = new SideRegistry(options.history);
  const runner = new SideRunner(client, options, {
    smallModel: () => api.state.config.small_model,
  });
  const [overlay, setOverlay] = createSignal<OverlayState | null>(null);

  // Feed streamed child parts into the runner so the answer overlay can
  // render live output while the side question is being answered.
  api.lifecycle.onDispose(
    api.event?.on("message.part.updated", (event) => {
      const part = (event as { properties?: { part?: unknown } })
        .properties?.part;
      if (part) runner.consumePartEvent(part);
    }) ?? (() => undefined),
  );

  api.route.register([
    {
      name: ROUTE_ANSWER,
      render: ({ params }) => (
        <AnswerScreen
          api={api}
          state={overlay}
          registry={registry}
          params={params}
        />
      ),
    },
  ]);

  api.lifecycle.onDispose(interceptSlashSubmit(api, {
    match: btwSlashQuestion,
    onMatch: (question) => {
      void runSideQuestion(
        api,
        runner,
        registry,
        client,
        setOverlay,
        options,
        question,
      );
    },
  }));

  api.keymap.registerLayer({
    commands: [
      {
        name: "btw.ask",
        title: "BTW side question",
        description:
          "Ask a one-shot side question about the current session without touching the main transcript",
        category: "BTW",
        namespace: "palette",
        slashName: "btw",
        run(ctx) {
          const input = ctx as { input?: unknown };
          void runSideQuestion(
            api,
            runner,
            registry,
            client,
            setOverlay,
            options,
            typeof input.input === "string" ? input.input : "",
          );
        },
      },
      {
        name: "btw.ask.side",
        title: "Side question (alias)",
        description: "Alias of /btw for Codex /side muscle memory",
        category: "BTW",
        namespace: "palette",
        slashName: "side",
        run(ctx) {
          const input = ctx as { input?: unknown };
          void runSideQuestion(
            api,
            runner,
            registry,
            client,
            setOverlay,
            options,
            typeof input.input === "string" ? input.input : "",
          );
        },
      },
      {
        name: "btw.history",
        title: "BTW history",
        description: "Review recent side questions for this session",
        category: "BTW",
        namespace: "palette",
        slashName: "btw-history",
        run() {
          showHistory(api, registry);
        },
      },
    ],
    bindings: [
      { key: "ctrl+b", cmd: "btw.history", desc: "BTW history" },
    ],
  });

  api.lifecycle.onDispose(() => {
    void runner.dispose();
    registry.clear();
  });
};

async function runSideQuestion(
  api: TuiPluginApi,
  runner: SideRunner,
  registry: SideRegistry,
  client: ReturnType<typeof asBtwClient>,
  setOverlay: Setter<OverlayState | null>,
  options: ReturnType<typeof parseOptions>,
  rawInput: string,
) {
  const sessionID = currentSessionID(api);
  if (!sessionID) {
    toast(api, "Open a session before asking a side question.", "warning");
    return;
  }
  const parsed = parseBtwRequest(rawInput) ?? { question: "", send: false };
  let question = parsed.question.trim();
  const send = parsed.send;
  if (!question) {
    question = await promptForQuestion(api);
    if (!question) return;
  }
  const returnRoute: TuiRouteCurrent = api.route.current;
  setOverlay({
    question,
    status: "pending",
    text: "",
  });
  api.route.navigate(ROUTE_ANSWER, { returnRoute });
  try {
    const exchange = await runner.ask({
      sessionID,
      question,
      onUpdate: (text) =>
        setOverlay((current) =>
          current && current.question === question
            ? { ...current, text }
            : current,
        ),
    });
    registry.record(exchange);
    setOverlay((current) =>
      current && current.question === question
        ? {
          question,
          status: "answered",
          text: exchange.answer,
          model: exchange.model,
        }
        : current,
    );
    if (send) {
      const merged = [
        `Side question (answered by ${exchange.model ?? "a side session"}):`,
        question,
        "",
        "Answer:",
        exchange.answer,
      ].join("\n");
      const sent = await client.session.prompt({
        sessionID,
        parts: [{ type: "text", text: merged }],
      }).then(
        () => true,
        () => false,
      );
      toast(
        api,
        sent
          ? "Side answer merged into the session."
          : "Could not merge the side answer into the session.",
        sent ? "success" : "warning",
      );
    }
    if (options.notify) {
      void api.attention.notify({
        title: "btw answered",
        message: exchange.answer.slice(0, 120),
      });
    }
  } catch (error) {
    const failed = error instanceof BtwError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
    setOverlay((current) =>
      current && current.question === question
        ? { question, status: "failed", text: "", error: failed }
        : current,
    );
    toast(api, failed, "error");
  }
}

function AnswerScreen(props: {
  api: TuiPluginApi;
  state: () => OverlayState | null;
  registry: SideRegistry;
  params?: Record<string, unknown>;
}) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [frame, setFrame] = createSignal(0);
  onMount(() => {
    const timer = setInterval(() =>
      setFrame((current) => (current + 1) % frames.length), 100);
    const unregister = props.api.keymap.registerLayer({
      priority: 100,
      commands: [
        {
          name: "btw.dismiss",
          title: "Close side answer",
          run: () => goBack(props.api, props.params),
        },
      ],
      bindings: [
        { key: "escape", cmd: "btw.dismiss", desc: "Close" },
        { key: "enter", cmd: "btw.dismiss", desc: "Close" },
      ],
    });
    onCleanup(() => {
      clearInterval(timer);
      unregister();
    });
  });
  const history = props.registry.list(
    sessionIDFromParams(props.params),
  ).length;
  return (
    <box width="100%" height="100%" flexDirection="column" padding={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.api.theme.current.accent}>btw</text>
        <box
          onMouseUp={() => goBack(props.api, props.params)}
          backgroundColor={props.api.theme.current.backgroundElement}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={props.api.theme.current.text}>
            enter/esc · back{history > 0 ? ` · ${history} saved` : ""}
          </text>
        </box>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="column" gap={1}>
        <text fg={props.api.theme.current.textMuted}>
          {props.state()?.question ?? ""}
        </text>
        <Show
          when={props.state()?.status === "pending"}
          fallback={
            <Show
              when={props.state()?.status === "answered"}
              fallback={
                <text fg={props.api.theme.current.error}>
                  {props.state()?.error ?? "The side question failed."}
                </text>
              }
            >
              <text fg={props.api.theme.current.markdownText}>
                {props.state()?.text ?? ""}
              </text>
            </Show>
          }
        >
          <text fg={props.api.theme.current.info}>
            {frames[frame()]} thinking
            {props.state()?.text
              ? ` · ${props.state()!.text!.length} chars`
              : ""}
          </text>
        </Show>
        <Show when={props.state()?.model}>
          <text fg={props.api.theme.current.textMuted}>
            model: {props.state()?.model}
          </text>
        </Show>
      </box>
      <text fg={props.api.theme.current.textMuted}>
        Side answers never enter the session transcript and are not persisted.
      </text>
    </box>
  );
}

function showHistory(api: TuiPluginApi, registry: SideRegistry) {
  const sessionID = currentSessionID(api);
  if (!sessionID) {
    toast(api, "Open a session to review its side questions.", "warning");
    return;
  }
  const exchanges = registry.list(sessionID);
  const DialogSelect = api.ui.DialogSelect;
  if (exchanges.length === 0) {
    toast(api, "No side questions yet in this session.", "info");
    return;
  }
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`BTW history · ${exchanges.length} side question${exchanges.length === 1 ? "" : "s"}`}
      options={[
        ...exchanges.slice().reverse().map((exchange) => ({
          title: exchange.question.slice(0, 60),
          value: exchange.id,
          description: `${exchange.status} · ${exchange.model ?? "default model"} · ${Math.round(exchange.durationMs / 100) / 10}s`,
          onSelect() {
            api.ui.dialog.clear();
            showExchange(api, exchange);
          },
        })),
        {
          title: "clear history",
          value: "clear",
          description: "Forget every saved side question for this session",
          onSelect() {
            registry.clear(sessionID);
            api.ui.dialog.clear();
            toast(api, "BTW history cleared.", "success");
          },
        },
      ]}
    />
  ));
}

function showExchange(api: TuiPluginApi, exchange: SideExchange) {
  api.ui.dialog.replace(() => (
    <api.ui.Dialog
      size="large"
      onClose={() => api.ui.dialog.clear()}
    >
      <box flexDirection="column" gap={1}>
        <text fg={api.theme.current.accent}>
          btw · {exchange.question.slice(0, 80)}
        </text>
        <text fg={api.theme.current.markdownText}>{exchange.answer}</text>
        <text fg={api.theme.current.textMuted}>
          {exchange.model ?? "default model"} ·{" "}
          {Math.round(exchange.durationMs / 100) / 10}s · not persisted
        </text>
      </box>
    </api.ui.Dialog>
  ));
}

function promptForQuestion(api: TuiPluginApi): Promise<string> {
  return new Promise((resolve) => {
    const DialogPrompt = api.ui.DialogPrompt;
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title="btw — side question"
        placeholder="What is this helper doing?"
        onConfirm={(value) => {
          api.ui.dialog.clear();
          resolve(value.trim());
        }}
        onCancel={() => {
          api.ui.dialog.clear();
          resolve("");
        }}
      />
    ));
  });
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const current = api.route.current;
  if (current.name === "session") {
    const sessionID = current.params?.sessionID;
    if (typeof sessionID === "string" && sessionID) return sessionID;
  }
  return undefined;
}

function sessionIDFromParams(params?: Record<string, unknown>): string {
  const candidate = params?.sessionID;
  return typeof candidate === "string" ? candidate : "";
}

function goBack(api: TuiPluginApi, params?: Record<string, unknown>) {
  const candidate = params?.returnRoute as TuiRouteCurrent | undefined;
  if (candidate?.name) {
    api.route.navigate(
      candidate.name,
      "params" in candidate ? candidate.params : undefined,
    );
    return;
  }
  api.route.navigate("home");
}

function toast(api: TuiPluginApi, message: string, variant: "info" | "success" | "warning" | "error") {
  api.ui.toast({ variant, message });
}

function interceptSlashSubmit(
  api: TuiPluginApi,
  handler: {
    match: (text: string) => string | undefined;
    onMatch: (args: string) => void;
  },
) {
  return api.keymap.intercept("key", (ctx) => {
    if (!isSubmitKey(ctx.event) || api.ui.dialog.open) return;
    const editor = api.renderer.currentFocusedEditor;
    if (!editor) return;
    const args = handler.match(editor.plainText);
    if (args === undefined) return;
    ctx.consume();
    editor.clear();
    handler.onMatch(args);
  }, { priority: SUBMIT_PRIORITY });
}

function isSubmitKey(event: {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}) {
  return (event.name === "return" || event.name === "enter") &&
    !event.ctrl && !event.meta && !event.shift;
}

export default { id: "opencode-btw", tui } satisfies TuiPluginModule;
