/** @jsxImportSource @opentui/solid */
import type { TuiDialogStack, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { GoalService } from "./engine.ts";
import type { Goal } from "./types.ts";

export function openGoalDialog(
  api: TuiPluginApi,
  title: string,
  body: string,
): boolean {
  const dialog = (api.ui as { dialog?: TuiDialogStack }).dialog;
  if (!dialog?.replace) return false;
  const theme = api.theme.current;
  try {
    dialog.setSize?.("xlarge");
    dialog.replace(() => (
      <scrollbox
        scrollY={true}
        stickyStart="top"
        height="100%"
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
      >
        <text fg={theme.text}>{title}</text>
        <For each={body.split("\n")}>
          {(line) => <text fg={theme.textMuted}>{line || " "}</text>}
        </For>
      </scrollbox>
    ));
    return true;
  } catch {
    return false;
  }
}

export function registerGoalSidebar(api: TuiPluginApi, goals: GoalService) {
  const slots = (api as TuiPluginApi & {
    slots?: {
      register(plugin: {
        slots: {
          sidebar_content(
            _ctx: unknown,
            props: { session_id: string },
          ): unknown;
        };
      }): string;
    };
  }).slots;
  if (!slots?.register) return;
  slots.register({
    slots: {
      sidebar_content(_ctx, props) {
        return <GoalSidebar api={api} goals={goals} sessionID={props.session_id} />;
      },
    },
  });
}

function GoalSidebar(props: {
  api: TuiPluginApi;
  goals: GoalService;
  sessionID: string;
}) {
  const theme = props.api.theme.current;
  const goal = () => props.goals.get(props.sessionID);
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1_000);
  onCleanup(() => clearInterval(timer));
  return (
    <Show when={goal()}>
      {(current) => (
        <box paddingLeft={1} paddingRight={1}>
          <text fg={theme.text}>Goal</text>
          <text fg={theme.textMuted}>{`Status: ${current().status}`}</text>
          <text fg={theme.textMuted}>
            {`Time: ${formatDuration(liveSeconds(current(), now()))}`}
          </text>
          <text fg={theme.textMuted}>
            {`Tokens: ${current().tokensUsed}${
              current().tokenBudget ? `/${current().tokenBudget}` : ""
            }`}
          </text>
          <text fg={theme.textMuted}>
            {`Auto: ${current().autoTurns}${
              current().maxTurns ? `/${current().maxTurns}` : ""
            }`}
          </text>
          <Show when={current().lastCheckpoint}>
            {(checkpoint) => (
              <text fg={theme.textMuted}>{`Checkpoint: ${checkpoint().summary}`}</text>
            )}
          </Show>
          <Show when={current().blocker}>
            {(blocker) => <text fg={theme.warning}>{blocker()}</text>}
          </Show>
          <text fg={theme.textMuted}>{current().objective}</text>
        </box>
      )}
    </Show>
  );
}

function liveSeconds(goal: Goal, now: number) {
  if (goal.status !== "active") return goal.timeUsedSeconds;
  return goal.timeUsedSeconds + Math.max(0, Math.floor((now - goal.updatedAt) / 1000));
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}
