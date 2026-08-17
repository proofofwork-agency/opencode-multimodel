import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createGoalService } from "./engine.ts";
import { parseOptions } from "./options.ts";
import { formatGoalStatus } from "./prompts.ts";

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
    api.ui.toast({ title: "Goal", message, variant });
  };

  api.keymap.registerLayer({
    commands: [
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

export default {
  id: "opencode-goal",
  tui,
} satisfies TuiPluginModule;
