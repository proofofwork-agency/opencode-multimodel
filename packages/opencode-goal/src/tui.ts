import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { parseGoalCommand } from "./command.ts";
import { createGoalService } from "./engine.ts";
import { formatHistory } from "./history.ts";
import { parseOptions } from "./options.ts";
import { formatContractStatus, formatGoalStatus } from "./prompts.ts";
import {
  goalSlashArguments,
  shouldStartGoalTurn,
} from "./slash.ts";

const SUBMIT_PRIORITY = 50_000;
const LONG_RESULT_LINES = 30;
const LONG_RESULT_CHARS = 1_200;

export function isLongResult(text: string) {
  return text.length > LONG_RESULT_CHARS ||
    text.split("\n").length > LONG_RESULT_LINES;
}

function firstLine(text: string) {
  return text.split("\n")[0] ?? "";
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = parseOptions(rawOptions);
  const goals = createGoalService(api.state.path.directory, options, api.client);

  const sessionID = () => {
    const current = api.route.current;
    if (
      current.name === "session" &&
      typeof current.params?.sessionID === "string"
    ) {
      return current.params.sessionID;
    }
    return undefined;
  };

  const notify = (
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
  ) => {
    if (isLongResult(message)) {
      api.ui.toast({
        title: "Goal",
        message:
          `${firstLine(message).slice(0, 80)} — full output opened in a dialog (esc to close).`,
        variant,
        duration: 12_000,
      });
      void import("./tui-sidebar.tsx").then((mod) => {
        try {
          mod.openGoalDialog(api, "Goal", message);
        } catch {
          // Dialog is optional; the toast already surfaced the summary.
        }
      }).catch(() => undefined);
      return;
    }
    api.ui.toast({ title: "Goal", message, variant, duration: 12_000 });
  };

  const applyFromSlash = async (raw: string) => {
    const id = sessionID();
    if (!id) return notify("Open a session before using /goal.", "warning");
    try {
      const command = parseGoalCommand(raw);
      const start = shouldStartGoalTurn(command.action);
      const message = await goals.apply(id, command, { start, steer: true });
      const goal = goals.get(id);
      notify(
        command.action === "set" && goal
          ? `Goal set: ${goal.objective}`
          : command.action === "resume"
          ? "Goal resumed."
          : message,
        command.action === "set" || command.action === "resume" ? "success" : "info",
      );
      if (command.action === "set" || command.action === "resume") {
        void api.attention.notify({
          title: "Goal is steering this session",
          message: goals.get(id)?.objective ?? "Thread goal updated.",
        });
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  api.lifecycle.onDispose(interceptSlashSubmit(api, {
    match: goalSlashArguments,
    onMatch: (args) => {
      void applyFromSlash(args);
    },
  }));

  void import("./tui-sidebar.tsx").then((mod) => {
    try {
      mod.registerGoalSidebar(api, goals);
    } catch {
      // Sidebar is optional. Slash intercept must keep working.
    }
  }).catch(() => undefined);

  api.keymap.registerLayer({
    commands: [
      {
        name: "goal.run",
        title: "Goal",
        description:
          "Set or manage the persisted thread goal immediately, without queuing",
        category: "Goal",
        namespace: "palette",
        slashName: "goal",
        run(ctx) {
          const input = ctx as { input?: unknown };
          void applyFromSlash(
            typeof input.input === "string" ? input.input : "",
          );
        },
      },
      {
        name: "goal.status",
        title: "Goal status",
        description: "Show the persisted thread goal",
        category: "Goal",
        namespace: "palette",
        slashName: "goal-status",
        run() {
          const id = sessionID();
          if (!id) return notify("Open a session before using /goal.", "warning");
          notify(formatGoalStatus(goals.get(id)));
        },
      },
      {
        name: "goal.history",
        title: "Goal history",
        description: "Show bounded lifecycle history for the current goal",
        category: "Goal",
        namespace: "palette",
        slashName: "goal-history",
        run() {
          const id = sessionID();
          if (!id) return notify("Open a session before using /goal.", "warning");
          notify(formatHistory(goals.get(id)));
        },
      },
      {
        name: "goal.contract",
        title: "Goal contract",
        description: "Show the frozen Dogfood contract path and hash",
        category: "Goal",
        namespace: "palette",
        slashName: "goal-contract",
        run() {
          const id = sessionID();
          if (!id) return notify("Open a session before using /goal.", "warning");
          notify(formatContractStatus(goals.get(id)));
        },
      },
      {
        name: "goal.pause",
        title: "Pause goal",
        description: "Pause autonomous continuation for the current goal",
        category: "Goal",
        namespace: "palette",
        slashName: "goal-pause",
        async run() {
          const id = sessionID();
          if (!id) return notify("Open a session before using /goal.", "warning");
          try {
            notify(await goals.apply(id, { action: "pause" }, { start: false }));
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), "error");
          }
        },
      },
      {
        name: "goal.resume",
        title: "Resume goal",
        description: "Resume a paused thread goal",
        category: "Goal",
        namespace: "palette",
        slashName: "goal-resume",
        async run() {
          const id = sessionID();
          if (!id) return notify("Open a session before using /goal.", "warning");
          try {
            notify(
              await goals.apply(id, { action: "resume" }, { start: true }),
              "success",
            );
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), "error");
          }
        },
      },
      {
        name: "goal.clear",
        title: "Clear goal",
        description: "Remove the persisted thread goal",
        category: "Goal",
        namespace: "palette",
        slashName: "goal-clear",
        async run() {
          const id = sessionID();
          if (!id) return notify("Open a session before using /goal.", "warning");
          try {
            notify(await goals.apply(id, { action: "clear" }, { start: false }));
          } catch (error) {
            notify(error instanceof Error ? error.message : String(error), "error");
          }
        },
      },
    ],
  });

  api.lifecycle.onDispose(() => {
    goals.close();
  });
};

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

export default {
  id: "opencode-goal",
  tui,
} satisfies TuiPluginModule;
