import { collaborate } from "./collaborate.ts";
import type { MultiModelOptions } from "./options.ts";
import { runScriptWorkflow } from "./script.ts";
import { StateStore, workflowSourceHash } from "./state.ts";
import type {
  AgentRunner,
  CollaborationRun,
  CollabActivity,
  CollabMode,
  DurableRun,
  Fleet,
  WorkflowDefinition,
  WorkflowRun,
} from "./types.ts";
import { isDagWorkflow, isWorkflowRun } from "./types.ts";
import { runWorkflow } from "./workflow.ts";

type ActiveRun = {
  controller: AbortController;
  promise: Promise<DurableRun>;
  heartbeat: ReturnType<typeof setInterval>;
};

type CollaborationStart = {
  sessionID: string;
  messageID?: string;
  prompt: string;
  mode: CollabMode;
  participants?: string[];
  handoffTo?: string;
  juryRounds?: 1 | 2;
  background?: boolean;
  signal?: AbortSignal;
  onActivity?: (event: CollabActivity) => void;
};

type WorkflowStart = {
  sessionID: string;
  messageID?: string;
  definition: WorkflowDefinition;
  input: string;
  background?: boolean;
  signal?: AbortSignal;
};

export class RunService {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly store: StateStore,
    private readonly runner: AgentRunner,
    private readonly options: MultiModelOptions,
  ) {}

  async startCollaboration(input: CollaborationStart) {
    const fleet = (await this.store.read()).fleet;
    const participants = selectParticipants(fleet, input.participants);
    const now = Date.now();
    const pending: CollaborationRun = {
      id: `collab_${crypto.randomUUID()}`,
      kind: "collaboration",
      definition: input.mode,
      sessionID: input.sessionID,
      messageID: input.messageID,
      input: input.prompt,
      status: "pending",
      mode: input.mode,
      participants,
      steps: participants.map((memberID) => ({
        id: memberID,
        status: "pending",
        memberID,
      })),
      background: input.background,
      createdAt: now,
      updatedAt: now,
    };
    const run = await this.store.createRun(pending, "multimodel_collab");
    if (run.id !== pending.id) return this.resultForExisting(run);
    const promise = this.executeCollaboration(pending, fleet, input);
    this.track(pending.id, promise.controller, promise.run);
    if (input.background) return pending;
    return promise.run;
  }

  async startWorkflow(input: WorkflowStart) {
    const state = await this.store.read();
    const now = Date.now();
    const pending: WorkflowRun = {
      id: `workflow_${crypto.randomUUID()}`,
      kind: "workflow",
      workflowKind: input.definition.kind ?? "dag",
      definition: input.definition.name,
      sessionID: input.sessionID,
      messageID: input.messageID,
      input: input.input,
      status: "pending",
      steps: isDagWorkflow(input.definition)
        ? input.definition.steps.map((step) => ({
          id: step.id,
          status: "pending",
          memberID: step.memberID ?? state.fleet.leadID,
        }))
        : [],
      background: input.background,
      sourceHash: input.definition.kind === "script"
        ? workflowSourceHash(input.definition.source)
        : undefined,
      createdAt: now,
      updatedAt: now,
    };
    const run = await this.store.createRun(pending, "multimodel_workflow");
    if (run.id !== pending.id) return this.resultForExisting(run);
    const promise = this.executeWorkflow(
      pending,
      state.fleet,
      input.definition,
      input.signal,
    );
    this.track(pending.id, promise.controller, promise.run);
    if (input.background) return pending;
    return promise.run;
  }

  async resume(runID: string) {
    const current = await this.store.getRun(runID);
    if (!current) throw new Error(`Run ${runID} does not exist.`);
    const active = this.active.get(runID);
    if (active) {
      await this.store.setRunControl(runID, "run");
      return current;
    }
    if (current.kind === "collaboration") {
      await this.claimResumeLease(runID);
      const state = await this.store.read();
      await this.store.setRunControl(runID, "run");
      const promise = this.executeCollaboration(current, state.fleet, {
        sessionID: current.sessionID,
        messageID: current.messageID,
        prompt: current.input,
        mode: current.mode,
        participants: current.participants,
        background: current.background,
      });
      this.track(runID, promise.controller, promise.run);
      return current;
    }
    const state = await this.store.read();
    const definition = state.workflows.find((item) =>
      item.name === current.definition
    );
    if (!definition) {
      throw new Error(`Workflow ${current.definition} no longer exists.`);
    }
    if (
      definition.kind === "script" &&
      current.sourceHash !== workflowSourceHash(definition.source)
    ) {
      throw new Error(
        `Workflow ${definition.name} changed since this run. Start a new run and approve its new source hash.`,
      );
    }
    await this.claimResumeLease(runID);
    await this.store.setRunControl(runID, "run");
    const promise = this.executeWorkflow(current, state.fleet, definition);
    this.track(runID, promise.controller, promise.run);
    return current;
  }

  async pause(runID: string) {
    await this.requireRun(runID);
    await this.store.setRunControl(runID, "pause");
  }

  async stop(runID: string) {
    const run = await this.requireRun(runID);
    await this.store.setRunControl(runID, "stop");
    this.active.get(runID)?.controller.abort("Run stopped by user.");
    await this.runner.cancel?.(run.sessionID, run.id);
  }

  async cancel(runID: string) {
    const run = await this.requireRun(runID);
    await this.store.setRunControl(runID, "stop");
    this.active.get(runID)?.controller.abort("Run cancelled by user.");
    await this.runner.cancel?.(run.sessionID, run.id);
  }

  async steer(runID: string, prompt: string) {
    const run = await this.requireRun(runID);
    await this.store.appendEvent(runID, "run.steered", { prompt });
    await this.runner.steer?.(run.sessionID, prompt, run.id);
  }

  async restartAgent(runID: string, stepID: string) {
    const run = await this.requireRun(runID);
    if (!isWorkflowRun(run)) {
      throw new Error("restart-agent is only available for workflow runs.");
    }
    const index = run.steps.findIndex((step) => step.id === stepID);
    if (index === -1) throw new Error(`Run ${runID} has no step ${stepID}.`);
    run.steps.slice(index).forEach((step) => {
      step.status = "pending";
      step.output = undefined;
      step.error = undefined;
      step.startedAt = undefined;
      step.completedAt = undefined;
    });
    run.status = "interrupted";
    run.error = undefined;
    await this.store.deleteAgentCallsFrom(runID, index);
    await this.store.saveRun(run);
    await this.store.appendEvent(runID, "agent.restart.requested", { stepID });
    return this.resume(runID);
  }

  async cleanupWorkspaces(runID?: string) {
    return this.runner.cleanupWorkspaces?.(runID) ?? 0;
  }

  async dispose() {
    this.active.forEach((run) => {
      clearInterval(run.heartbeat);
      run.controller.abort("Plugin disposed.");
    });
    await Promise.allSettled(
      [...this.active.values()].map((run) => run.promise),
    );
    this.active.clear();
  }

  private executeCollaboration(
    run: CollaborationRun,
    fleet: Fleet,
    input: CollaborationStart,
  ) {
    const controller = linkedController(input.signal);
    const execute = (async () => {
      run.status = "running";
      run.error = undefined;
      await this.store.saveRun(run);
      await this.waitUntilRunnable(run, controller.signal);
      try {
        const result = await collaborate(
          this.runner,
          fleet,
          run.sessionID,
          run.input,
          {
            mode: run.mode,
            participants: run.participants,
            handoffTo: input.handoffTo,
            juryRounds: input.juryRounds,
            maxWorkers: this.options.maxWorkers,
            maxParallel: this.options.maxParallel,
            signal: controller.signal,
            runID: run.id,
            onActivity: (event) => {
              input.onActivity?.(event);
              void this.store.appendEvent(run.id, "collaboration.activity", event);
            },
          },
        );
        run.status = "completed";
        run.final = result.final.text;
        run.participants = result.participants;
        run.steps = result.participants.map((memberID) => {
          const reply = [...result.replies]
            .reverse()
            .find((item) => item.memberID === memberID);
          return {
            id: memberID,
            status: reply?.error ? "failed" as const : "completed" as const,
            memberID,
            output: reply?.text,
            error: reply?.error,
            completedAt: Date.now(),
          };
        });
      } catch (error) {
        run.status = controller.signal.aborted
          ? abortedStatus(controller.signal)
          : "failed";
        run.error = error instanceof Error ? error.message : String(error);
      }
      run.updatedAt = Date.now();
      await this.store.saveRun(run);
      return run;
    })();
    return { controller, run: execute };
  }

  private executeWorkflow(
    run: WorkflowRun,
    fleet: Fleet,
    definition: WorkflowDefinition,
    signal?: AbortSignal,
  ) {
    const controller = linkedController(signal);
    const timeout = setTimeout(
      () => controller.abort(
        `Workflow timed out after ${this.options.workflows.timeoutMs} ms.`,
      ),
      this.options.workflows.timeoutMs,
    );
    const common = {
      signal: controller.signal,
      run,
      runID: run.id,
      messageID: run.messageID,
      background: run.background,
      maxAgentCalls: this.options.workflows.maxAgentCalls,
      maxParallel: this.options.maxParallel,
      timeoutMs: this.options.workflows.timeoutMs,
      beforeStep: (snapshot: WorkflowRun) =>
        this.waitUntilRunnable(snapshot, controller.signal),
      onUpdate: (snapshot: WorkflowRun) =>
        this.store.saveRun(snapshot).then(() => undefined),
    };
    const execution = definition.kind === "script"
      ? runScriptWorkflow(
        this.runner,
        fleet,
        run.sessionID,
        definition,
        run.input,
        common,
      )
      : runWorkflow(
        this.runner,
        fleet,
        run.sessionID,
        definition,
        run.input,
        common,
      );
    const execute = execution.then(async (finished) => {
      if (controller.signal.aborted && finished.status === "cancelled") {
        const reason = String(controller.signal.reason);
        finished.status = reason.toLowerCase().includes("timed out")
          ? "failed"
          : abortedStatus(controller.signal);
        if (finished.status === "failed") finished.error = reason;
        await this.store.saveRun(finished);
      }
      return finished;
    }).catch(async (error) => {
      run.status = controller.signal.aborted
        ? abortedStatus(controller.signal)
        : "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.updatedAt = Date.now();
      await this.store.saveRun(run);
      return run;
    }).finally(() => clearTimeout(timeout));
    return { controller, run: execute };
  }

  private async waitUntilRunnable(run: DurableRun, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      const control = await this.store.getRunControl(run.id);
      if (control === "stop") {
        throw new DOMException("Run stopped by user.", "AbortError");
      }
      if (control === "run") {
        if (run.status === "paused") {
          run.status = "running";
          await this.store.saveRun(run);
        }
        return;
      }
      if (run.status !== "paused") {
        run.status = "paused";
        await this.store.saveRun(run);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    }
  }

  private track(
    runID: string,
    controller: AbortController,
    promise: Promise<DurableRun>,
  ) {
    const heartbeat = setInterval(
      () => void this.store.renewLease(runID),
      10_000,
    );
    this.active.set(runID, { controller, promise, heartbeat });
    void promise
      .finally(() => {
        if (this.active.get(runID)?.promise !== promise) return;
        clearInterval(heartbeat);
        this.active.delete(runID);
      })
      .catch(() => undefined);
  }

  private async requireRun(runID: string) {
    const run = await this.store.getRun(runID);
    if (!run) throw new Error(`Run ${runID} does not exist.`);
    return run;
  }

  private async claimResumeLease(runID: string) {
    if (await this.store.claimLease(runID)) return;
    throw new Error(`Run ${runID} is active in another plugin process.`);
  }

  private resultForExisting(run: DurableRun) {
    if (run.status === "interrupted") return run;
    return run;
  }
}

function selectParticipants(fleet: Fleet, requested?: string[]) {
  const enabled = fleet.members.filter((member) => member.enabled);
  if (!requested?.length) return enabled.map((member) => member.id);
  const selected = requested.filter((id) =>
    enabled.some((member) => member.id === id)
  );
  if (selected.length !== requested.length) {
    const missing = requested.filter((id) => !selected.includes(id));
    throw new Error(`Missing or disabled fleet members: ${missing.join(", ")}.`);
  }
  if (!selected.includes(fleet.leadID)) selected.unshift(fleet.leadID);
  return selected;
}

function linkedController(signal?: AbortSignal) {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort(signal.reason);
  signal?.addEventListener("abort", () => controller.abort(signal.reason), {
    once: true,
  });
  return controller;
}

function abortedStatus(signal: AbortSignal): "cancelled" | "stopped" {
  return String(signal.reason).toLowerCase().includes("stopped")
    ? "stopped"
    : "cancelled";
}
