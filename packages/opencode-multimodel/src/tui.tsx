import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiPromptInfo,
  TuiPromptRef,
  TuiRouteCurrent,
} from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  asOpenCodeClient,
  discoverFleet,
  listAvailableFleetModels,
  OpenCodeAgentRunner,
} from "./opencode.ts";
import { RunService } from "./orchestration.ts";
import { parseOptions, type MultiModelOptions } from "./options.ts";
import { resolveDatabasePath, StateStore } from "./state.ts";
import {
  COLLAB_MODES,
  type CollabActivity,
  type CollabMode,
  type ComposerMode,
  type WorkflowDefinition,
} from "./types.ts";
import { loadWorkflowDirectories } from "./workflow-files.ts";

const ROUTE_FLEET = "multimodel.fleet";
const ROUTE_COLLAB = "multimodel.collab";
const ROUTE_WORKFLOWS = "multimodel.workflows";
const ROUTE_WORKFLOW = "multimodel.workflow";
const ROUTE_RUNS = "multimodel.runs";
const ROUTE_RUN = "multimodel.run";
const ROUTE_GRAPH = "multimodel.graph";

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = parseOptions(rawOptions);
  const client = asOpenCodeClient(api.client);
  const store = new StateStore(
    resolveDatabasePath(api.state.path.directory, options.databasePath),
    {
      legacyPath: options.statePath
        ? resolveDatabasePath(api.state.path.directory, options.statePath)
        : undefined,
      retention: options.retention,
    },
  );
  await store.initializeFleet(options.fleet ?? (await discoverFleet(client)));
  await loadWorkflowDirectories(
    store,
    api.state.path.directory,
    options.workflows,
  );
  const runner = new OpenCodeAgentRunner(client, store);
  const runs = new RunService(store, runner, options);
  const composer = createComposerController(
    options,
    (await store.read()).workflows,
  );

  if (options.composer.enabled && api.slots) {
    registerComposerInputRouting(api, options, composer);
    registerComposerSlots(api, store, options, composer);
  }
  watchBackgroundRuns(api, store, composer);

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
          runs={runs}
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
          runs={runs}
          params={params}
        />
      ),
    },
    {
      name: ROUTE_RUNS,
      render: ({ params }) => (
        <RunLedgerScreen api={api} store={store} params={params} />
      ),
    },
    {
      name: ROUTE_RUN,
      render: ({ params }) => (
        <RunDetailScreen api={api} store={store} params={params} />
      ),
    },
    {
      name: ROUTE_GRAPH,
      render: ({ params }) => (
        <GraphScreen api={api} store={store} params={params} />
      ),
    },
  ]);

  api.keymap.registerLayer({
    commands: [
      {
        name: "multimodel.fleet",
        title: "Multi-model fleet",
        description: "Select participants and add, remove, or lead models",
        category: "Multi-model",
        namespace: "palette",
        slashName: "fleet",
        run() {
          void manageFleet(api, store, client);
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
          void selectCollaboration(api, store, options, composer);
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
          void selectWorkflow(api, store, composer);
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
      {
        name: "multimodel.mode",
        title: "Composer mode: SINGLE · TEAM · WORKFLOW",
        description: "Choose how normal TUI prompts are submitted",
        category: "Multi-model",
        namespace: "palette",
        slashName: "mode",
        run() {
          void chooseComposerMode(api, store, options, composer);
        },
      },
      {
        name: "multimodel.runs",
        title: "Multi-model run ledger",
        description: "Inspect foreground and background orchestration runs",
        category: "Multi-model",
        namespace: "palette",
        slashName: "runs",
        run() {
          api.route.navigate(ROUTE_RUNS, { returnRoute: api.route.current });
          api.ui.dialog.clear();
        },
      },
      {
        name: "multimodel.graph",
        title: "Multi-model wire graph",
        description: "View routes between fleet members in recent runs",
        category: "Multi-model",
        namespace: "palette",
        slashName: "graph",
        run() {
          api.route.navigate(ROUTE_GRAPH, { returnRoute: api.route.current });
          api.ui.dialog.clear();
        },
      },
    ],
  });

  api.lifecycle.onDispose(async () => {
    await runs.dispose();
    await runner.close();
    await store.close();
  });
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
              Use /fleet to toggle participants or add and remove model seats.
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
                    {workflow.name} · {workflowSummary(workflow)} ·{" "}
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
              <For each={value().runs.slice(0, 20)}>
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
    runs: RunService;
    options: MultiModelOptions;
  },
) {
  const controller = new AbortController();
  const [activity, setActivity] = createSignal<Record<string, CollabActivity>>(
    {},
  );
  const [output] = createResource(async () => {
    const mode = isMode(props.params?.mode)
      ? props.params.mode
      : props.options.defaultMode;
    const sessionID = stringParam(props.params?.sessionID, "sessionID");
    const prompt = stringParam(props.params?.prompt, "prompt");
    return props.runs.startCollaboration({
      sessionID,
      prompt,
      mode,
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
                {value().status} · run={value().id}
              </text>
              <text fg={props.api.theme.current.text} wrapMode="word">
                {value().final ?? value().error ?? "No output."}
              </text>
            </box>
          )}
        </Show>
      </box>
    </Screen>
  );
}

function WorkflowScreen(props: ScreenProps & { runs: RunService }) {
  const controller = new AbortController();
  const [snapshot, setSnapshot] = createSignal<string>("Starting…");
  const [output] = createResource(async () => {
    const state = await props.store.read();
    const name = stringParam(props.params?.name, "name");
    const definition = state.workflows.find(
      (workflow) => workflow.name === name,
    );
    if (!definition) throw new Error(`Workflow ${name} does not exist.`);
    if (definition.kind === "script") {
      throw new Error(
        "Run script workflows through /workflow so OpenCode can request source-hash permission.",
      );
    }
    return props.runs.startWorkflow({
      sessionID: stringParam(props.params?.sessionID, "sessionID"),
      definition,
      input: typeof props.params?.input === "string" ? props.params.input : "",
      signal: controller.signal,
    }).then((run) => {
      setSnapshot(
        `${run.status} · ${run.steps.filter((step) => step.status === "completed").length}/${run.steps.length} steps`,
      );
      return run;
    });
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

function RunLedgerScreen(props: ScreenProps) {
  const state = usePollingState(props.store);
  useBackKey(props.api, props.params);
  return (
    <Screen api={props.api} title="Multi-model run ledger" params={props.params}>
      <Show
        when={state()}
        fallback={<text fg={props.api.theme.current.textMuted}>Loading ledger…</text>}
      >
        {(value) => (
          <box flexDirection="column" gap={1}>
            <Show
              when={value().runs.length > 0}
              fallback={<text fg={props.api.theme.current.textMuted}>No runs yet.</text>}
            >
              <For each={value().runs.slice(0, 40)}>
                {(run) => (
                  <box
                    flexDirection="row"
                    gap={1}
                    onMouseUp={() => props.api.route.navigate(ROUTE_RUN, {
                      runID: run.id,
                      returnRoute: props.api.route.current,
                    })}
                  >
                    <text fg={runColor(props.api, run.status)}>{run.status}</text>
                    <text fg={props.api.theme.current.text}>{run.definition}</text>
                    <text fg={props.api.theme.current.textMuted}>{run.kind}</text>
                    <text fg={props.api.theme.current.info}>{run.id}</text>
                  </box>
                )}
              </For>
            </Show>
            <text fg={props.api.theme.current.textMuted}>
              Active dashboards refresh every 500 ms; idle dashboards every 2 s.
            </text>
          </box>
        )}
      </Show>
    </Screen>
  );
}

function RunDetailScreen(props: ScreenProps) {
  const state = usePollingState(props.store);
  const runID = stringParam(props.params?.runID, "runID");
  useBackKey(props.api, props.params);
  return (
    <Screen api={props.api} title={`Run · ${runID}`} params={props.params}>
      <Show
        when={state()?.runs.find((run) => run.id === runID)}
        fallback={<text fg={props.api.theme.current.textMuted}>Loading run…</text>}
      >
        {(run) => (
          <box flexDirection="column" gap={1}>
            <text fg={runColor(props.api, run().status)}>
              {run().definition} · {run().status} · {run().kind}
            </text>
            <For each={run().steps}>
              {(step) => (
                <text fg={runColor(props.api, step.status)}>
                  {step.id} · {step.memberID} · {step.status}
                  {step.error ? ` · ${step.error}` : ""}
                </text>
              )}
            </For>
            <Show when={run().final ?? run().error}>
              <text fg={props.api.theme.current.text} wrapMode="word">
                {run().final ?? run().error}
              </text>
            </Show>
            <text fg={props.api.theme.current.accent}>Ledger events</text>
            <For each={state()?.events.filter((event) => event.runID === runID).slice(-20)}>
              {(event) => (
                <text fg={props.api.theme.current.textMuted}>
                  {event.id} · {event.type}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
    </Screen>
  );
}

function GraphScreen(props: ScreenProps) {
  const state = usePollingState(props.store);
  useBackKey(props.api, props.params);
  return (
    <Screen api={props.api} title="Multi-model wire graph" params={props.params}>
      <Show
        when={state()}
        fallback={<text fg={props.api.theme.current.textMuted}>Loading graph…</text>}
      >
        {(value) => (
          <box flexDirection="column" gap={1}>
            <text fg={props.api.theme.current.accent}>
              Fleet · lead={value().fleet.leadID}
            </text>
            <For each={value().fleet.members}>
              {(member) => (
                <text fg={props.api.theme.current.text}>
                  {member.id === value().fleet.leadID
                    ? `human → ${member.id} → human`
                    : `${member.id} → ${value().fleet.leadID}`}
                  {` · ${member.model.providerID}/${member.model.modelID}`}
                </text>
              )}
            </For>
            <text fg={props.api.theme.current.accent}>Recent routes</text>
            <For each={value().runs.slice(0, 10)}>
              {(run) => (
                <text fg={runColor(props.api, run.status)}>
                  {run.id} · {run.steps.map((step) => step.memberID).join(" → ") || run.definition}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
    </Screen>
  );
}

type ComposerSelection = {
  mode: ComposerMode;
  collaborationMode: CollabMode;
  workflowName?: string;
};

type ComposerController = {
  selection: () => ComposerSelection;
  setSelection: (value: ComposerSelection) => void;
  ref: (current: TuiRouteCurrent) => TuiPromptRef | undefined;
  addRef: (sessionID: string, value: TuiPromptRef) => void;
  removeRef: (sessionID: string, value: TuiPromptRef) => void;
  sessionID: () => string;
  setSessionID: (value: string) => void;
  workflows: () => WorkflowDefinition[];
  setWorkflows: (value: WorkflowDefinition[]) => void;
};

function createComposerController(
  options: MultiModelOptions,
  initialWorkflows: WorkflowDefinition[],
): ComposerController {
  const [selection, setSelection] = createSignal<ComposerSelection>({
    mode: options.composer.initial,
    collaborationMode: options.defaultMode,
  });
  const refs = new Map<string, Set<TuiPromptRef>>();
  const [sessionID, setSessionID] = createSignal("__home__");
  const [workflows, setWorkflows] = createSignal(initialWorkflows);
  return {
    selection,
    setSelection,
    ref(current) {
      const currentSessionID = current.name === "home"
        ? "__home__"
        : current.name === "session" &&
            typeof current.params?.sessionID === "string"
          ? current.params.sessionID
          : undefined;
      if (!currentSessionID) return undefined;
      const candidates = [...(refs.get(currentSessionID) ?? [])];
      return candidates.find((candidate) => candidate.focused) ??
        candidates.at(-1);
    },
    addRef(currentSessionID, value) {
      const candidates = refs.get(currentSessionID) ?? new Set<TuiPromptRef>();
      candidates.add(value);
      refs.set(currentSessionID, candidates);
    },
    removeRef(currentSessionID, value) {
      const candidates = refs.get(currentSessionID);
      candidates?.delete(value);
      if (candidates?.size === 0) refs.delete(currentSessionID);
    },
    sessionID,
    setSessionID,
    workflows,
    setWorkflows,
  };
}

function registerComposerInputRouting(
  api: TuiPluginApi,
  options: MultiModelOptions,
  controller: ComposerController,
) {
  const route = () => {
    const active = controller.ref(api.route.current);
    if (!active?.focused) return false;
    const routed = routeComposerPrompt(
      active.current,
      controller.selection(),
      options.composer.autoRoute,
      controller.workflows(),
      options.defaultMode,
    );
    if (routed !== active.current) active.set(routed);
    return active;
  };
  api.lifecycle.onDispose(api.keymap.intercept("key:after", (context) => {
    if (!isPlainComposerSubmitKey(
      context.event,
      api.ui.dialog.open,
      context.handled,
    )) return;
    route();
  }, { priority: 10_000 }));
  api.lifecycle.onDispose(api.keymap.registerLayer({
    priority: 10_000,
    commands: [{
      name: "prompt.submit",
      title: "Submit prompt through multi-model composer",
      hidden: true,
      run() {
        const active = route();
        if (!active) return false;
        active.submit();
        return true;
      },
    }],
  }));
}

export function isPlainComposerSubmitKey(event: {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  option?: boolean;
}, dialogOpen = false, keymapHandled = false) {
  return !dialogOpen && !keymapHandled &&
    (event.name === "return" || event.name === "enter") &&
    !event.ctrl && !event.meta && !event.shift && !event.option;
}

function registerComposerSlots(
  api: TuiPluginApi,
  store: StateStore,
  options: MultiModelOptions,
  controller: ComposerController,
) {
  api.slots.register({
    slots: {
      home_prompt(_context, props) {
        return (
          <NativeComposer
            api={api}
            store={store}
            options={options}
            controller={controller}
            sessionID="__home__"
            hostRef={props.ref}
            rightSlot="home_prompt_right"
          />
        );
      },
      session_prompt(_context, props) {
        return (
          <NativeComposer
            api={api}
            store={store}
            options={options}
            controller={controller}
            sessionID={props.session_id}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.on_submit}
            hostRef={props.ref}
            rightSlot="session_prompt_right"
          />
        );
      },
      sidebar_content(_context, props) {
        return (
          <SidebarStatus api={api} store={store} sessionID={props.session_id} />
        );
      },
      sidebar_footer() {
        return (
          <box paddingLeft={1} paddingRight={1}>
            <text fg={api.theme.current.textMuted}>/runs · /graph · /workflows</text>
          </box>
        );
      },
    },
  });
}

function NativeComposer(props: {
  api: TuiPluginApi;
  store: StateStore;
  options: MultiModelOptions;
  controller: ComposerController;
  sessionID: string;
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  hostRef?: (ref: TuiPromptRef | undefined) => void;
  rightSlot: "home_prompt_right" | "session_prompt_right";
}) {
  const Prompt = props.api.ui.Prompt;
  const Slot = props.api.ui.Slot;
  let ref: TuiPromptRef | undefined;
  createEffect(() => {
    if (!composerSlotIsActive(
      props.api.route.current,
      props.sessionID,
      props.visible,
    )) {
      return;
    }
    props.controller.setSessionID(props.sessionID);
    void props.store.getSessionMode(props.sessionID).then((stored) => {
      if (props.controller.sessionID() !== props.sessionID) return;
      if (!stored) {
        const selection = props.controller.selection();
        void props.store.setSessionMode(
          props.sessionID,
          selection.mode,
          selection.mode === "team"
            ? selection.collaborationMode
            : selection.workflowName,
        );
        return;
      }
      props.controller.setSelection({
        mode: stored.mode,
        collaborationMode: isMode(stored.collaboration_mode)
          ? stored.collaboration_mode
          : props.options.defaultMode,
        workflowName: stored.workflow_name ?? undefined,
      });
    });
  });
  onCleanup(() => {
    if (ref) props.controller.removeRef(props.sessionID, ref);
    props.hostRef?.(undefined);
  });
  return (
    <Prompt
      sessionID={props.sessionID === "__home__" ? undefined : props.sessionID}
      visible={props.visible}
      disabled={props.disabled}
      onSubmit={props.onSubmit}
      ref={(value) => {
        if (ref) props.controller.removeRef(props.sessionID, ref);
        ref = value;
        if (value) props.controller.addRef(props.sessionID, value);
        if (!composerSlotIsActive(
          props.api.route.current,
          props.sessionID,
          props.visible,
        )) return;
        props.controller.setSessionID(props.sessionID);
        props.hostRef?.(value);
      }}
      right={
        <box flexDirection="row" gap={1}>
          {props.rightSlot === "session_prompt_right"
            ? <Slot name="session_prompt_right" session_id={props.sessionID} />
            : <Slot name="home_prompt_right" />}
          <ModeBadge api={props.api} controller={props.controller} />
        </box>
      }
    />
  );
}

export function composerSlotIsActive(
  current: TuiRouteCurrent,
  sessionID: string,
  visible?: boolean,
) {
  if (visible === false) return false;
  if (sessionID === "__home__") return current.name === "home";
  return current.name === "session" && current.params?.sessionID === sessionID;
}

function ModeBadge(props: {
  api: TuiPluginApi;
  controller: ComposerController;
}) {
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.api.theme.current.backgroundElement}
      onMouseUp={() => props.api.keymap.dispatchCommand("multimodel.mode")}
    >
      <text fg={props.api.theme.current.accent}>
        {props.controller.selection().mode.toUpperCase()}
      </text>
    </box>
  );
}

async function chooseComposerMode(
  api: TuiPluginApi,
  store: StateStore,
  options: MultiModelOptions,
  controller: ComposerController,
) {
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.replace(() => (
    <DialogSelect
      title="Composer mode"
      current={controller.selection().mode}
      options={[
        {
          title: "SINGLE",
          value: "single" as const,
          description: "Submit through OpenCode's native single-model path",
          onSelect() {
            void saveComposerSelection(store, controller, {
              ...controller.selection(),
              mode: "single",
            });
            api.ui.dialog.clear();
          },
        },
        {
          title: "TEAM",
          value: "team" as const,
          description: "Rewrite normal prompts to /collab",
          onSelect() {
            api.ui.dialog.replace(() => (
              <DialogSelect
                title="Team collaboration mode"
                current={controller.selection().collaborationMode}
                options={COLLAB_MODES.map((mode) => ({
                  title: mode,
                  value: mode,
                  description: modeDescription(mode),
                  onSelect() {
                    void saveComposerSelection(store, controller, {
                      mode: "team",
                      collaborationMode: mode,
                    });
                    api.ui.dialog.clear();
                  },
                }))}
              />
            ));
          },
        },
        {
          title: "WORKFLOW",
          value: "workflow" as const,
          description: "Rewrite normal prompts to a selected /workflow",
          async onSelect() {
            const workflows = (await store.read()).workflows;
            if (workflows.length === 0) {
              toast(api, "No workflows saved.", "warning");
              return;
            }
            api.ui.dialog.replace(() => (
              <DialogSelect
                title="Workflow"
                options={workflows.map((workflow) => ({
                  title: workflow.name,
                  value: workflow.name,
                  description: workflowSummary(workflow),
                  onSelect() {
                    void saveComposerSelection(store, controller, {
                      mode: "workflow",
                      collaborationMode: options.defaultMode,
                      workflowName: workflow.name,
                    });
                    api.ui.dialog.clear();
                  },
                }))}
              />
            ));
          },
        },
      ]}
    />
  ));
}

async function saveComposerSelection(
  store: StateStore,
  controller: ComposerController,
  selection: ComposerSelection,
) {
  controller.setSelection(selection);
  await store.setSessionMode(
    controller.sessionID(),
    selection.mode,
    selection.mode === "team"
      ? selection.collaborationMode
      : selection.workflowName,
  );
}

export function routeComposerPrompt(
  prompt: TuiPromptInfo,
  selection: ComposerSelection,
  autoRoute: boolean,
  workflows: WorkflowDefinition[],
  defaultMode: CollabMode,
): TuiPromptInfo {
  const input = prompt.input.trim();
  if (
    !input ||
    prompt.mode === "shell" ||
    input.startsWith("/") ||
    input.startsWith("@")
  ) return prompt;
  const automatic = autoRoute ? automaticRoute(input, workflows) : undefined;
  const mode = automatic?.mode ?? selection.mode;
  if (mode === "single") return prompt;
  if (mode === "team") {
    return {
      ...prompt,
      input: `/collab ${automatic?.collaborationMode ?? selection.collaborationMode ?? defaultMode} ${prompt.input}`,
    };
  }
  const workflowName = automatic?.workflowName ?? selection.workflowName;
  if (!workflowName) return prompt;
  return { ...prompt, input: `/workflow ${workflowName} ${prompt.input}` };
}

function automaticRoute(input: string, workflows: WorkflowDefinition[]) {
  const workflow = workflows.find((definition) => {
    const name = escapeRegExp(definition.name);
    return new RegExp(`(?:^|\\s)workflow(?::|\\s+)${name}(?=\\s|$)`, "i").test(input);
  });
  if (workflow) {
    return { mode: "workflow" as const, workflowName: workflow.name };
  }
  if (
    /\b(multi[- ]model|multiple models|team|council|jury|panel|collaborat(?:e|ion))\b/i.test(input)
  ) {
    return { mode: "team" as const, collaborationMode: "council" as const };
  }
  return undefined;
}

function watchBackgroundRuns(
  api: TuiPluginApi,
  store: StateStore,
  composer: ComposerController,
) {
  const seen = new Map<string, string>();
  const watchingSince = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const poll = async () => {
    if (disposed || api.lifecycle.signal.aborted) return;
    const state = await store.read();
    composer.setWorkflows(state.workflows);
    const runs = state.runs.filter((run) => run.background);
    await Promise.all(runs.map(async (run) => {
      const previous = seen.get(run.id);
      seen.set(run.id, run.status);
      const newlyCompleted = !previous && run.createdAt >= watchingSince &&
        !isActiveStatus(run.status);
      const transitioned = !!previous && isActiveStatus(previous) &&
        !isActiveStatus(run.status);
      if (!newlyCompleted && !transitioned) return;
      await api.attention.notify({
        title: "Multi-model run complete",
        message: `${run.definition} · ${run.status}`,
        sound: { name: run.status === "completed" ? "done" : "error" },
        notification: true,
      });
    }));
    if (disposed || api.lifecycle.signal.aborted) return;
    timer = setTimeout(
      () => void poll(),
      runs.some((run) => isActiveStatus(run.status)) ? 500 : 2_000,
    );
  };
  void poll();
  api.lifecycle.onDispose(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
}

function usePollingState(store: StateStore) {
  const [state, setState] = createSignal<Awaited<ReturnType<StateStore["read"]>>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onMount(() => {
    const poll = async () => {
      const next = await store.read();
      if (disposed) return;
      setState(next);
      timer = setTimeout(
        () => void poll(),
        next.runs.some((run) => isActiveStatus(run.status)) ? 500 : 2_000,
      );
    };
    void poll();
  });
  onCleanup(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
  return state;
}

function SidebarStatus(props: {
  api: TuiPluginApi;
  store: StateStore;
  sessionID: string;
}) {
  const state = usePollingState(props.store);
  return (
    <Show when={state()}>
      {(value) => (
        <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={1}>
          <text fg={props.api.theme.current.accent}>MULTI-MODEL</text>
          <text fg={props.api.theme.current.textMuted}>
            lead={value().fleet.leadID} · fleet={value().fleet.members.filter((member) => member.enabled).length}
          </text>
          <For each={value().runs.filter((run) =>
            run.sessionID === props.sessionID && isActiveStatus(run.status)
          )}>
            {(run) => (
              <text fg={props.api.theme.current.info}>
                {run.definition} · {run.status}
              </text>
            )}
          </For>
        </box>
      )}
    </Show>
  );
}

function isActiveStatus(status: string) {
  return status === "pending" || status === "running" || status === "paused";
}

function runColor(api: TuiPluginApi, status: string) {
  if (status === "completed") return api.theme.current.success;
  if (status === "failed" || status === "cancelled" || status === "stopped") {
    return api.theme.current.error;
  }
  if (status === "running") return api.theme.current.info;
  return api.theme.current.warning;
}

function workflowSummary(workflow: WorkflowDefinition) {
  return workflow.kind === "script"
    ? "confined script"
    : `${workflow.steps.length} DAG steps`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

type FleetClient = ReturnType<typeof asOpenCodeClient>;

async function manageFleet(
  api: TuiPluginApi,
  store: StateStore,
  client: FleetClient,
) {
  const state = await store.read();
  const DialogSelect = api.ui.DialogSelect;
  const enabled = state.fleet.members.filter((member) => member.enabled).length;
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`Multi-model fleet · ${enabled} active · lead ${state.fleet.leadID}`}
      skipFilter
      options={[
        ...state.fleet.members.map((member) => ({
          title: `${member.enabled ? "☑" : "☐"} ${member.id === state.fleet.leadID ? "★ " : ""}${member.id}`,
          value: `toggle:${member.id}`,
          description: `${member.role} · ${member.model.providerID}/${member.model.modelID} · ${member.enabled ? "on" : "off"}`,
          onSelect() {
            if (member.id === state.fleet.leadID && member.enabled) {
              toast(api, "Choose another lead before disabling this seat.", "warning");
              return;
            }
            void store.enableMember(member.id, !member.enabled)
              .then(() => manageFleet(api, store, client))
              .then(() =>
                toast(
                  api,
                  `${member.id} ${member.enabled ? "disabled" : "enabled"}.`,
                  "success",
                )
              )
              .catch((error) => toast(api, String(error), "error"));
          },
        })),
        {
          title: "＋ add a specific model",
          value: "add",
          description: "Choose any connected text model, including Codex delegate models",
          onSelect() {
            void selectFleetModel(api, store, client)
              .catch((error) => toast(api, String(error), "error"));
          },
        },
        {
          title: "★ choose fleet lead",
          value: "lead",
          description: "The lead owns synthesis and final decisions",
          onSelect() {
            void selectFleetLead(api, store, client)
              .catch((error) => toast(api, String(error), "error"));
          },
        },
        {
          title: "− remove a model seat",
          value: "remove",
          description: "Remove a non-lead seat from the durable fleet",
          disabled: state.fleet.members.every((member) =>
            member.id === state.fleet.leadID
          ),
          onSelect() {
            void selectFleetRemoval(api, store, client)
              .catch((error) => toast(api, String(error), "error"));
          },
        },
        {
          title: "◎ open fleet overview",
          value: "overview",
          description: "Show the full fleet route and model details",
          onSelect() {
            api.route.navigate(ROUTE_FLEET, { returnRoute: api.route.current });
            api.ui.dialog.clear();
          },
        },
      ]}
    />
  ));
}

async function selectFleetModel(
  api: TuiPluginApi,
  store: StateStore,
  client: FleetClient,
) {
  const models = await listAvailableFleetModels(client);
  if (models.length === 0) {
    toast(api, "No connected text models are available.", "warning");
    return manageFleet(api, store, client);
  }
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.replace(
    () => (
      <DialogSelect
        title="Add model seat"
        placeholder="Filter provider or model"
        options={models.map((model) => ({
          title: model.modelName,
          value: `${model.providerID}/${model.modelID}`,
          category: model.providerName,
          description: `${model.providerID}/${model.modelID}`,
          onSelect() {
            void addFleetModel(api, store, client, model)
              .catch((error) => toast(api, String(error), "error"));
          },
        }))}
      />
    ),
    () => void manageFleet(api, store, client),
  );
}

async function addFleetModel(
  api: TuiPluginApi,
  store: StateStore,
  client: FleetClient,
  model: { providerID: string; modelID: string },
) {
  const state = await store.read();
  const id = nextFleetMemberID(
    model.providerID,
    model.modelID,
    state.fleet.members.map((member) => member.id),
  );
  await store.upsertMember({
    id,
    role: "specialist",
    model: { providerID: model.providerID, modelID: model.modelID },
    agent: "plan",
    enabled: true,
    isolation: "shared",
  });
  await manageFleet(api, store, client);
  toast(api, `${id} added to the fleet.`, "success");
}

async function selectFleetLead(
  api: TuiPluginApi,
  store: StateStore,
  client: FleetClient,
) {
  const state = await store.read();
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.replace(
    () => (
      <DialogSelect
        title="Select fleet lead"
        current={state.fleet.leadID}
        options={state.fleet.members
          .filter((member) => member.enabled)
          .map((member) => ({
            title: member.id,
            value: member.id,
            description: `${member.role} · ${member.model.providerID}/${member.model.modelID}`,
            onSelect() {
              void store.setLead(member.id)
                .then(() => manageFleet(api, store, client))
                .then(() => toast(api, `${member.id} is now LEAD.`, "success"))
                .catch((error) => toast(api, String(error), "error"));
            },
          }))}
      />
    ),
    () => void manageFleet(api, store, client),
  );
}

async function selectFleetRemoval(
  api: TuiPluginApi,
  store: StateStore,
  client: FleetClient,
) {
  const state = await store.read();
  const removable = state.fleet.members.filter((member) =>
    member.id !== state.fleet.leadID
  );
  if (removable.length === 0) return manageFleet(api, store, client);
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.replace(
    () => (
      <DialogSelect
        title="Remove model seat"
        options={removable.map((member) => ({
          title: member.id,
          value: member.id,
          description: `${member.model.providerID}/${member.model.modelID}`,
          onSelect() {
            void store.removeMember(member.id)
              .then(() => manageFleet(api, store, client))
              .then(() => toast(api, `${member.id} removed.`, "success"))
              .catch((error) => toast(api, String(error), "error"));
          },
        }))}
      />
    ),
    () => void manageFleet(api, store, client),
  );
}

export function nextFleetMemberID(
  providerID: string,
  modelID: string,
  memberIDs: string[],
) {
  const used = new Set(memberIDs);
  const provider = slug(providerID) || "model";
  if (!used.has(provider)) return provider;
  const model = slug(modelID) || "seat";
  const base = `${provider}-${model}`;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function slug(value: string) {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function selectCollaboration(
  api: TuiPluginApi,
  store: StateStore,
  options: MultiModelOptions,
  composer: ComposerController,
) {
  const state = await store.read();
  if (state.fleet.members.length === 0)
    return toast(api, "Fleet is empty.", "warning");
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
          const prompt = composer.ref(api.route.current);
          if (!prompt) {
            toast(api, "Open /collab from a session composer.", "warning");
            return;
          }
          prompt.set({
            ...prompt.current,
            input: collaborationComposerInput(mode),
          });
          prompt.focus();
          api.ui.dialog.clear();
        },
      }))}
    />
  ));
}

export function collaborationComposerInput(mode: CollabMode) {
  return `/collab ${mode} `;
}

async function selectWorkflow(
  api: TuiPluginApi,
  store: StateStore,
  composer: ComposerController,
) {
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
        description: `${workflowSummary(definition)} · ${definition.description ?? "No description"}`,
        onSelect() {
          if (definition.kind === "script") {
            const prompt = composer.ref(api.route.current);
            if (!prompt) {
              toast(
                api,
                `Use /workflow ${definition.name} from the native composer to approve this script.`,
                "warning",
              );
              return;
            }
            prompt.set({
              ...prompt.current,
              input: `/workflow ${definition.name} `,
            });
            prompt.focus();
            api.ui.dialog.clear();
            return;
          }
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
