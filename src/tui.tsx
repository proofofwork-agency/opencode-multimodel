import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiRouteCurrent,
} from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import {
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { collaborate } from "./collaborate.ts";
import {
  asOpenCodeClient,
  discoverFleet,
  OpenCodeAgentRunner,
} from "./opencode.ts";
import { parseOptions, type MultiModelOptions } from "./options.ts";
import { defaultStatePath, StateStore } from "./state.ts";
import {
  COLLAB_MODES,
  type CollabActivity,
  type CollabMode,
} from "./types.ts";
import { runWorkflow } from "./workflow.ts";

const ROUTE_FLEET = "multimodel.fleet";
const ROUTE_COLLAB = "multimodel.collab";
const ROUTE_WORKFLOWS = "multimodel.workflows";
const ROUTE_WORKFLOW = "multimodel.workflow";

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = parseOptions(rawOptions);
  const client = asOpenCodeClient(api.client);
  const store = new StateStore(
    options.statePath ?? defaultStatePath(api.state.path.directory),
  );
  await store.initializeFleet(options.fleet ?? (await discoverFleet(client)));
  const runner = new OpenCodeAgentRunner(client);

  api.route.register([
    {
      name: ROUTE_FLEET,
      render: ({ params }) => (
        <FleetScreen api={api} store={store} params={params} />
      ),
    },
    {
      name: ROUTE_COLLAB,
      render: ({ params }) => (
        <CollabScreen
          api={api}
          store={store}
          runner={runner}
          options={options}
          params={params}
        />
      ),
    },
    {
      name: ROUTE_WORKFLOWS,
      render: ({ params }) => (
        <WorkflowsScreen api={api} store={store} params={params} />
      ),
    },
    {
      name: ROUTE_WORKFLOW,
      render: ({ params }) => (
        <WorkflowScreen
          api={api}
          store={store}
          runner={runner}
          params={params}
        />
      ),
    },
  ]);

  api.keymap.registerLayer({
    commands: [
      {
        name: "multimodel.fleet",
        title: "Multi-model fleet",
        description: "View fleet models and the selected lead",
        category: "Multi-model",
        namespace: "palette",
        slashName: "fleet",
        run() {
          api.route.navigate(ROUTE_FLEET, { returnRoute: api.route.current });
          api.ui.dialog.clear();
        },
      },
      {
        name: "multimodel.lead",
        title: "Select fleet lead",
        description: "Choose which model owns synthesis and decisions",
        category: "Multi-model",
        namespace: "palette",
        slashName: "lead",
        run() {
          void selectLead(api, store);
        },
      },
      {
        name: "multimodel.collab",
        title: "Multi-model collaboration",
        description: "Run pair, council, jury, or another collaboration mode",
        category: "Multi-model",
        namespace: "palette",
        slashName: "collab",
        run() {
          void selectCollaboration(api, store, options);
        },
      },
      {
        name: "multimodel.workflow",
        title: "Run multi-model workflow",
        description: "Choose and run a saved declarative workflow",
        category: "Multi-model",
        namespace: "palette",
        slashName: "workflow",
        run() {
          void selectWorkflow(api, store);
        },
      },
      {
        name: "multimodel.workflows",
        title: "Multi-model workflow history",
        description: "View workflow definitions and recent runs",
        category: "Multi-model",
        namespace: "palette",
        slashName: "workflows",
        run() {
          api.route.navigate(ROUTE_WORKFLOWS, {
            returnRoute: api.route.current,
          });
          api.ui.dialog.clear();
        },
      },
    ],
  });

  api.lifecycle.onDispose(() => runner.close());
};

function FleetScreen(props: ScreenProps) {
  const [state] = createResource(() => props.store.read());
  useBackKey(props.api, props.params);
  return (
    <Screen api={props.api} title="Multi-model fleet" params={props.params}>
      <Show
        when={state()}
        fallback={
          <text fg={props.api.theme.current.textMuted}>Loading fleet…</text>
        }
      >
        {(value) => (
          <box flexDirection="column" gap={1}>
            <text fg={props.api.theme.current.text}>
              Lead: {value().fleet.leadID}
            </text>
            <Show
              when={value().fleet.members.length > 0}
              fallback={
                <text fg={props.api.theme.current.warning}>
                  Fleet is empty.
                </text>
              }
            >
              <For each={value().fleet.members}>
                {(member) => (
                  <box flexDirection="row" gap={1}>
                    <text
                      fg={
                        member.id === value().fleet.leadID
                          ? props.api.theme.current.accent
                          : props.api.theme.current.textMuted
                      }
                    >
                      {member.id === value().fleet.leadID ? "LEAD" : "WORK"}
                    </text>
                    <text fg={props.api.theme.current.text}>{member.id}</text>
                    <text fg={props.api.theme.current.textMuted}>
                      {member.role}
                    </text>
                    <text fg={props.api.theme.current.info}>
                      {member.model.providerID}/{member.model.modelID}
                    </text>
                    <text fg={props.api.theme.current.textMuted}>
                      agent={member.agent ?? "default"}
                    </text>
                  </box>
                )}
              </For>
            </Show>
            <text fg={props.api.theme.current.textMuted}>
              Use /lead to select the lead. Use multimodel_fleet to add or
              remove seats.
            </text>
          </box>
        )}
      </Show>
    </Screen>
  );
}

function WorkflowsScreen(props: ScreenProps) {
  const [state] = createResource(() => props.store.read());
  useBackKey(props.api, props.params);
  return (
    <Screen api={props.api} title="Multi-model workflows" params={props.params}>
      <Show
        when={state()}
        fallback={
          <text fg={props.api.theme.current.textMuted}>Loading workflows…</text>
        }
      >
        {(value) => (
          <box flexDirection="column" gap={1}>
            <text fg={props.api.theme.current.accent}>Definitions</text>
            <Show
              when={value().workflows.length > 0}
              fallback={
                <text fg={props.api.theme.current.textMuted}>
                  No workflows saved.
                </text>
              }
            >
              <For each={value().workflows}>
                {(workflow) => (
                  <text fg={props.api.theme.current.text}>
                    {workflow.name} · {workflow.steps.length} steps ·{" "}
                    {workflow.description ?? "No description"}
                  </text>
                )}
              </For>
            </Show>
            <text fg={props.api.theme.current.accent}>Recent runs</text>
            <Show
              when={value().runs.length > 0}
              fallback={
                <text fg={props.api.theme.current.textMuted}>No runs yet.</text>
              }
            >
              <For each={value().runs.slice(-20).reverse()}>
                {(run) => (
                  <text
                    fg={
                      run.status === "completed"
                        ? props.api.theme.current.success
                        : run.status === "failed"
                          ? props.api.theme.current.error
                          : props.api.theme.current.warning
                    }
                  >
                    {run.definition} · {run.status} ·{" "}
                    {
                      run.steps.filter((step) => step.status === "completed")
                        .length
                    }
                    /{run.steps.length} steps
                  </text>
                )}
              </For>
            </Show>
          </box>
        )}
      </Show>
    </Screen>
  );
}

function CollabScreen(
  props: ScreenProps & {
    runner: OpenCodeAgentRunner;
    options: MultiModelOptions;
  },
) {
  const controller = new AbortController();
  const [activity, setActivity] = createSignal<Record<string, CollabActivity>>(
    {},
  );
  const [output] = createResource(async () => {
    const state = await props.store.read();
    const mode = isMode(props.params?.mode)
      ? props.params.mode
      : props.options.defaultMode;
    const sessionID = stringParam(props.params?.sessionID, "sessionID");
    const prompt = stringParam(props.params?.prompt, "prompt");
    return collaborate(props.runner, state.fleet, sessionID, prompt, {
      mode,
      maxWorkers: props.options.maxWorkers,
      maxParallel: props.options.maxParallel,
      signal: controller.signal,
      onActivity(event) {
        setActivity((current) => ({ ...current, [event.memberID]: event }));
      },
    });
  });
  onCleanup(() => controller.abort());
  useBackKey(props.api, props.params);
  return (
    <Screen
      api={props.api}
      title={`Collaboration · ${String(props.params?.mode ?? props.options.defaultMode)}`}
      params={props.params}
    >
      <box flexDirection="column" gap={1}>
        <For each={Object.values(activity())}>
          {(event) => (
            <text fg={phaseColor(props.api, event)}>
              {event.memberID} · {event.phase} · {event.detail}
            </text>
          )}
        </For>
        <Show when={output.error}>
          <text fg={props.api.theme.current.error}>{String(output.error)}</text>
        </Show>
        <Show
          when={output()}
          fallback={
            <text fg={props.api.theme.current.textMuted}>
              Fleet is working…
            </text>
          }
        >
          {(value) => (
            <box flexDirection="column" gap={1}>
              <text fg={props.api.theme.current.success}>
                Done · lead={value().leadID} · {value().participants.join(", ")}
              </text>
              <text fg={props.api.theme.current.text} wrapMode="word">
                {value().final.text}
              </text>
            </box>
          )}
        </Show>
      </box>
    </Screen>
  );
}

function WorkflowScreen(props: ScreenProps & { runner: OpenCodeAgentRunner }) {
  const controller = new AbortController();
  const [snapshot, setSnapshot] = createSignal<string>("Starting…");
  const [output] = createResource(async () => {
    const state = await props.store.read();
    const name = stringParam(props.params?.name, "name");
    const definition = state.workflows.find(
      (workflow) => workflow.name === name,
    );
    if (!definition) throw new Error(`Workflow ${name} does not exist.`);
    return runWorkflow(
      props.runner,
      state.fleet,
      stringParam(props.params?.sessionID, "sessionID"),
      definition,
      typeof props.params?.input === "string" ? props.params.input : "",
      {
        signal: controller.signal,
        async onUpdate(run) {
          setSnapshot(
            `${run.status} · ${run.steps.filter((step) => step.status === "completed").length}/${run.steps.length} steps`,
          );
          await props.store.saveRun(run);
        },
      },
    );
  });
  onCleanup(() => controller.abort());
  useBackKey(props.api, props.params);
  return (
    <Screen
      api={props.api}
      title={`Workflow · ${String(props.params?.name ?? "")}`}
      params={props.params}
    >
      <box flexDirection="column" gap={1}>
        <text fg={props.api.theme.current.info}>{snapshot()}</text>
        <Show when={output.error}>
          <text fg={props.api.theme.current.error}>{String(output.error)}</text>
        </Show>
        <Show when={output()}>
          {(run) => (
            <box flexDirection="column" gap={1}>
              <For each={run().steps}>
                {(step) => (
                  <text
                    fg={
                      step.status === "completed"
                        ? props.api.theme.current.success
                        : step.status === "failed"
                          ? props.api.theme.current.error
                          : props.api.theme.current.textMuted
                    }
                  >
                    {step.id} · {step.memberID} · {step.status}
                  </text>
                )}
              </For>
              <text fg={props.api.theme.current.text} wrapMode="word">
                {run().final ?? run().error ?? "No final output."}
              </text>
            </box>
          )}
        </Show>
      </box>
    </Screen>
  );
}

type ScreenProps = {
  api: TuiPluginApi;
  store: StateStore;
  params?: Record<string, unknown>;
};

function Screen(props: {
  api: TuiPluginApi;
  title: string;
  params?: Record<string, unknown>;
  children: JSX.Element;
}) {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.api.theme.current.accent}>{props.title}</text>
        <box
          onMouseUp={() => goBack(props.api, props.params)}
          backgroundColor={props.api.theme.current.backgroundElement}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={props.api.theme.current.text}>esc · back</text>
        </box>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="column">
        {props.children}
      </box>
    </box>
  );
}

async function selectLead(api: TuiPluginApi, store: StateStore) {
  const state = await store.read();
  if (state.fleet.members.length === 0)
    return toast(api, "Fleet is empty.", "warning");
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.replace(() => (
    <DialogSelect
      title="Select fleet lead"
      current={state.fleet.leadID}
      options={state.fleet.members
        .filter((member) => member.enabled)
        .map((member) => ({
          title: member.id,
          value: member.id,
          description: `${member.role} · ${member.model.providerID}/${member.model.modelID}`,
          async onSelect() {
            await store.setLead(member.id);
            api.ui.dialog.clear();
            toast(api, `${member.id} is now LEAD.`, "success");
          },
        }))}
    />
  ));
}

async function selectCollaboration(
  api: TuiPluginApi,
  store: StateStore,
  options: MultiModelOptions,
) {
  const state = await store.read();
  if (state.fleet.members.length === 0)
    return toast(api, "Fleet is empty.", "warning");
  const returnRoute = api.route.current;
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.replace(() => (
    <DialogSelect
      title="Collaboration mode"
      current={options.defaultMode}
      options={COLLAB_MODES.map((mode) => ({
        title: mode,
        value: mode,
        description: modeDescription(mode),
        onSelect() {
          askForInput(
            api,
            "Collaboration request",
            "What should the fleet do?",
            async (prompt) => {
              const sessionID = await parentSession(api);
              api.route.navigate(ROUTE_COLLAB, {
                mode,
                prompt,
                sessionID,
                returnRoute,
              });
            },
          );
        },
      }))}
    />
  ));
}

async function selectWorkflow(api: TuiPluginApi, store: StateStore) {
  const state = await store.read();
  if (state.workflows.length === 0)
    return toast(api, "No workflows saved.", "warning");
  const returnRoute = api.route.current;
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.replace(() => (
    <DialogSelect
      title="Run workflow"
      options={state.workflows.map((definition) => ({
        title: definition.name,
        value: definition.name,
        description: `${definition.steps.length} steps · ${definition.description ?? "No description"}`,
        onSelect() {
          askForInput(
            api,
            `${definition.name} input`,
            "Workflow input",
            async (input) => {
              const sessionID = await parentSession(api);
              api.route.navigate(ROUTE_WORKFLOW, {
                name: definition.name,
                input,
                sessionID,
                returnRoute,
              });
            },
          );
        },
      }))}
    />
  ));
}

function askForInput(
  api: TuiPluginApi,
  title: string,
  placeholder: string,
  confirm: (value: string) => Promise<void>,
) {
  const DialogPrompt = api.ui.DialogPrompt;
  api.ui.dialog.replace(() => (
    <DialogPrompt
      title={title}
      placeholder={placeholder}
      onConfirm={(value) => {
        if (!value.trim()) return;
        api.ui.dialog.clear();
        void confirm(value).catch((error) =>
          toast(
            api,
            error instanceof Error ? error.message : String(error),
            "error",
          ),
        );
      }}
    />
  ));
}

async function parentSession(api: TuiPluginApi) {
  const current = api.route.current;
  if (
    current.name === "session" &&
    typeof current.params?.sessionID === "string"
  )
    return current.params.sessionID;
  const response = await asOpenCodeClient(api.client).session.create({
    title: "Multi-model run",
  });
  if (response.error)
    throw new Error(
      `Could not create parent session: ${JSON.stringify(response.error)}`,
    );
  if (!response.data?.id)
    throw new Error("OpenCode did not return a parent session id.");
  return response.data.id;
}

function useBackKey(api: TuiPluginApi, params?: Record<string, unknown>) {
  onMount(() => {
    const unregister = api.keymap.registerLayer({
      priority: 100,
      commands: [
        {
          name: "multimodel.back",
          title: "Back",
          run: () => goBack(api, params),
        },
      ],
      bindings: [{ key: "escape", cmd: "multimodel.back", desc: "Back" }],
    });
    onCleanup(unregister);
  });
}

function goBack(api: TuiPluginApi, params?: Record<string, unknown>) {
  const route = params?.returnRoute;
  if (isRoute(route))
    return api.route.navigate(
      route.name,
      "params" in route ? route.params : undefined,
    );
  api.route.navigate("home");
}

function isRoute(value: unknown): value is TuiRouteCurrent {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function isMode(value: unknown): value is CollabMode {
  return (
    typeof value === "string" &&
    (COLLAB_MODES as readonly string[]).includes(value)
  );
}

function stringParam(value: unknown, name: string) {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`Missing route parameter ${name}.`);
}

function phaseColor(api: TuiPluginApi, event: CollabActivity) {
  if (event.phase === "error") return api.theme.current.error;
  if (event.phase === "done") return api.theme.current.success;
  if (event.phase === "thinking" || event.phase === "synthesizing")
    return api.theme.current.info;
  return api.theme.current.textMuted;
}

function toast(
  api: TuiPluginApi,
  message: string,
  variant: "success" | "warning" | "error",
) {
  api.ui.toast({ title: "Multi-model", message, variant });
}

function modeDescription(mode: CollabMode) {
  const descriptions: Record<CollabMode, string> = {
    lead: "Lead answers alone",
    pair: "Lead plans, one worker responds, lead synthesizes",
    round: "Fleet contributes sequentially",
    council: "Workers advise in parallel, lead synthesizes",
    orchestrate: "Lead assigns tasks, workers run in parallel",
    handoff: "Lead hands one explicit task to a worker",
    panel: "One independent ballot round, lead judges",
    deliberate: "One independent ballot round, lead judges",
    jury: "Two ballot rounds with rebuttal, lead judges",
  };
  return descriptions[mode];
}

export default { id: "opencode-multimodel", tui } satisfies TuiPluginModule;
