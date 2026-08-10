import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  CollaborationRun,
  ComposerMode,
  DagWorkflowDefinition,
  DurableRun,
  Fleet,
  FleetMember,
  LedgerEvent,
  PersistedState,
  RunStatus,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
  WorkspaceRecord,
} from "./types.ts";

const TERMINAL = ["completed", "failed", "cancelled", "stopped"] as const;
const EMPTY_FLEET: Fleet = { leadID: "lead", members: [] };

type StateStoreOptions = {
  legacyPath?: string;
  retention?: { runs: number; events: number };
};

type RunRow = {
  id: string;
  kind: "workflow" | "collaboration";
  definition: string;
  workflow_kind: "dag" | "script" | null;
  session_id: string;
  message_id: string | null;
  input: string;
  status: RunStatus;
  mode: string | null;
  participants: string;
  final: string | null;
  error: string | null;
  background: number;
  source_hash: string | null;
  created_at: number;
  updated_at: number;
};

type StepRow = {
  step_id: string;
  status: WorkflowStepRun["status"];
  member_id: string;
  output: string | null;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
};

export class StateStore {
  readonly path: string;
  private readonly database: Database;
  private readonly owner = crypto.randomUUID();
  private readonly retention: { runs: number; events: number };
  private readonly ready: Promise<void>;

  constructor(path: string, options: StateStoreOptions = {}) {
    this.path = resolve(path);
    this.retention = options.retention ?? { runs: 100, events: 10_000 };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.database = new Database(this.path, { create: true, strict: true });
    chmodSync(this.path, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.createSchema();
    this.secureDatabaseFiles();
    this.ready = this.initialize(options.legacyPath);
  }

  async read(): Promise<PersistedState> {
    await this.ready;
    return {
      version: 2,
      fleet: this.readFleet(),
      workflows: this.listWorkflowsSync(),
      runs: this.listRunsSync(),
      events: this.listEventsSync(),
      workspaces: this.listWorkspacesSync(),
    };
  }

  async initializeFleet(fleet: Fleet) {
    await this.ready;
    this.transaction(() => {
      const count = this.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM fleet_members")
        .get()?.count ?? 0;
      if (count > 0) return;
      this.writeFleet(normalizeFleet(fleet));
      this.appendEventSync(undefined, "fleet.initialized", {
        members: fleet.members.map((member) => member.id),
      });
    });
  }

  async setLead(leadID: string) {
    await this.ready;
    this.transaction(() => {
      if (!this.memberExists(leadID)) {
        throw new Error(`Fleet member ${leadID} does not exist.`);
      }
      this.setMeta("fleet.lead", leadID);
      this.appendEventSync(undefined, "fleet.lead", { memberID: leadID });
    });
  }

  async upsertMember(member: FleetMember) {
    await this.ready;
    this.transaction(() => {
      this.database.query(
        `INSERT INTO fleet_members (
          id, role, provider_id, model_id, agent, system, enabled, isolation, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          role = excluded.role,
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          agent = excluded.agent,
          system = excluded.system,
          enabled = excluded.enabled,
          isolation = excluded.isolation,
          updated_at = excluded.updated_at`,
      ).run(
        member.id,
        member.role,
        member.model.providerID,
        member.model.modelID,
        member.agent ?? null,
        member.system ?? null,
        member.enabled ? 1 : 0,
        member.isolation ?? "shared",
        Date.now(),
      );
      if (!this.memberExists(this.meta("fleet.lead") ?? "")) {
        this.setMeta("fleet.lead", member.id);
      }
      this.appendEventSync(undefined, "fleet.member.saved", {
        memberID: member.id,
        enabled: member.enabled,
        isolation: member.isolation ?? "shared",
      });
    });
  }

  async enableMember(memberID: string, enabled: boolean) {
    await this.ready;
    const changed = this.database
      .query("UPDATE fleet_members SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, Date.now(), memberID).changes;
    if (changed === 0) throw new Error(`Fleet member ${memberID} does not exist.`);
    await this.appendEvent(undefined, "fleet.member.enabled", {
      memberID,
      enabled,
    });
  }

  async removeMember(memberID: string) {
    await this.ready;
    this.transaction(() => {
      this.database.query("DELETE FROM fleet_members WHERE id = ?").run(memberID);
      if (this.meta("fleet.lead") === memberID) {
        const next = this.database
          .query<{ id: string }, []>(
            "SELECT id FROM fleet_members ORDER BY updated_at, id LIMIT 1",
          )
          .get()?.id ?? "lead";
        this.setMeta("fleet.lead", next);
      }
      this.appendEventSync(undefined, "fleet.member.removed", { memberID });
    });
  }

  async saveWorkflow(definition: WorkflowDefinition) {
    await this.ready;
    const source = definition.kind === "script" ? definition.source : null;
    const sourceHash = definition.kind === "script"
      ? definition.sourceHash ?? workflowSourceHash(definition.source)
      : null;
    this.transaction(() => {
      this.database.query(
        `INSERT INTO workflows (
          name, kind, description, definition_json, source, source_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          kind = excluded.kind,
          description = excluded.description,
          definition_json = excluded.definition_json,
          source = excluded.source,
          source_hash = excluded.source_hash,
          updated_at = excluded.updated_at`,
      ).run(
        definition.name,
        definition.kind ?? "dag",
        definition.description ?? null,
        JSON.stringify(definition.kind === "script"
          ? { ...definition, sourceHash }
          : { ...definition, kind: "dag" }),
        source,
        sourceHash,
        Date.now(),
        Date.now(),
      );
      this.appendEventSync(undefined, "workflow.saved", {
        name: definition.name,
        kind: definition.kind ?? "dag",
        sourceHash,
      });
    });
  }

  async removeWorkflow(name: string) {
    await this.ready;
    this.database.query("DELETE FROM workflows WHERE name = ?").run(name);
    await this.appendEvent(undefined, "workflow.removed", { name });
  }

  async createRun(run: DurableRun, tool: string) {
    await this.ready;
    const idempotencyKey = run.messageID
      ? `${run.sessionID}\0${run.messageID}\0${tool}`
      : undefined;
    return this.transaction(() => {
      if (idempotencyKey) {
        const existing = this.database
          .query<{ id: string }, [string]>(
            "SELECT id FROM runs WHERE idempotency_key = ?",
          )
          .get(idempotencyKey);
        if (existing) return this.getRunSync(existing.id)!;
      }
      this.saveRunSync(run, idempotencyKey);
      this.appendEventSync(run.id, "run.created", {
        kind: run.kind,
        definition: run.definition,
        background: run.background === true,
      });
      this.acquireLeaseSync(run.id);
      this.pruneSync();
      return structuredClone(run);
    });
  }

  async saveRun(run: DurableRun) {
    await this.ready;
    this.transaction(() => {
      if (run.status === "running" || run.status === "paused") {
        this.acquireLeaseSync(run.id);
      } else {
        this.assertLeaseOwnerOrFreeSync(run.id);
      }
      this.saveRunSync(run);
      if (TERMINAL.includes(run.status as (typeof TERMINAL)[number]) ||
        run.status === "interrupted") this.releaseLeaseSync(run.id);
      this.appendEventSync(run.id, "run.updated", {
        status: run.status,
        steps: run.steps.map((step) => ({ id: step.id, status: step.status })),
      });
      this.pruneSync();
    });
    return run;
  }

  async getRun(runID: string) {
    await this.ready;
    return this.getRunSync(runID);
  }

  async listRuns(limit = 100) {
    await this.ready;
    return this.listRunsSync(limit);
  }

  async setRunControl(
    runID: string,
    control: "run" | "pause" | "stop",
  ) {
    await this.ready;
    const changed = this.database
      .query("UPDATE runs SET control = ?, updated_at = ? WHERE id = ?")
      .run(control, Date.now(), runID).changes;
    if (changed === 0) throw new Error(`Run ${runID} does not exist.`);
    await this.appendEvent(runID, `run.${control}.requested`, {});
  }

  async renewLease(runID: string) {
    await this.ready;
    if (!this.tryAcquireLeaseSync(runID)) {
      throw new Error(`Run ${runID} is leased by another plugin process.`);
    }
  }

  async claimLease(runID: string) {
    await this.ready;
    return this.transaction(() => this.tryAcquireLeaseSync(runID));
  }

  async getRunControl(runID: string) {
    await this.ready;
    return this.database
      .query<{ control: "run" | "pause" | "stop" }, [string]>(
        "SELECT control FROM runs WHERE id = ?",
      )
      .get(runID)?.control ?? "stop";
  }

  async appendEvent(runID: string | undefined, type: string, data: unknown) {
    await this.ready;
    this.transaction(() => {
      this.appendEventSync(runID, type, data);
      this.pruneEventsSync();
    });
  }

  async saveChildSession(
    key: string,
    input: {
      parentSessionID: string;
      memberID: string;
      providerID: string;
      modelID: string;
      agent?: string;
      sessionID: string;
      workspaceID?: string;
    },
  ) {
    await this.ready;
    this.database.query(
      `INSERT INTO child_sessions (
        key, parent_session_id, member_id, provider_id, model_id, agent,
        session_id, workspace_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        session_id = excluded.session_id,
        workspace_id = excluded.workspace_id,
        updated_at = excluded.updated_at`,
    ).run(
      key,
      input.parentSessionID,
      input.memberID,
      input.providerID,
      input.modelID,
      input.agent ?? null,
      input.sessionID,
      input.workspaceID ?? null,
      Date.now(),
    );
  }

  async getChildSession(key: string) {
    await this.ready;
    return this.database
      .query<{ session_id: string; workspace_id: string | null }, [string]>(
        "SELECT session_id, workspace_id FROM child_sessions WHERE key = ?",
      )
      .get(key);
  }

  async deleteChildSessionsForWorkspace(workspaceID: string) {
    await this.ready;
    this.database
      .query("DELETE FROM child_sessions WHERE workspace_id = ?")
      .run(workspaceID);
  }

  async saveAgentCall(input: {
    runID: string;
    stepID?: string;
    callIndex: number;
    memberID: string;
    prompt: string;
    options: unknown;
    status: "running" | "completed" | "failed" | "cancelled";
    sessionID?: string;
    output?: string;
    error?: string;
  }) {
    await this.ready;
    this.transaction(() => {
      this.database.query(
        `INSERT INTO agent_calls (
          run_id, step_id, call_index, member_id, prompt, options_json, status,
          child_session_id, output, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, call_index) DO UPDATE SET
          step_id = excluded.step_id,
          member_id = excluded.member_id,
          prompt = excluded.prompt,
          options_json = excluded.options_json,
          status = excluded.status,
          child_session_id = excluded.child_session_id,
          output = excluded.output,
          error = excluded.error,
          updated_at = excluded.updated_at`,
      ).run(
        input.runID,
        input.stepID ?? null,
        input.callIndex,
        input.memberID,
        input.prompt,
        JSON.stringify(input.options),
        input.status,
        input.sessionID ?? null,
        input.output ?? null,
        input.error ?? null,
        Date.now(),
        Date.now(),
      );
      this.appendEventSync(input.runID, `agent.${input.status}`, {
        stepID: input.stepID,
        callIndex: input.callIndex,
        memberID: input.memberID,
        childSessionID: input.sessionID,
        error: input.error,
      });
    });
  }

  async cachedAgentCalls(runID: string) {
    await this.ready;
    return this.database
      .query<{
        call_index: number;
        member_id: string;
        prompt: string;
        options_json: string;
        child_session_id: string | null;
        output: string | null;
        status: string;
      }, [string]>(
        `SELECT call_index, member_id, prompt, options_json, child_session_id,
          output, status FROM agent_calls WHERE run_id = ? ORDER BY call_index`,
      )
      .all(runID);
  }

  async deleteAgentCallsFrom(runID: string, callIndex: number) {
    await this.ready;
    this.database
      .query("DELETE FROM agent_calls WHERE run_id = ? AND call_index >= ?")
      .run(runID, callIndex);
    await this.appendEvent(runID, "agent.cache.truncated", { callIndex });
  }

  async saveWorkspace(workspace: WorkspaceRecord) {
    await this.ready;
    this.database.query(
      `INSERT INTO workspaces (
        id, run_id, member_id, directory, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        directory = excluded.directory,
        status = excluded.status,
        updated_at = excluded.updated_at`,
    ).run(
      workspace.id,
      workspace.runID ?? null,
      workspace.memberID,
      workspace.directory ?? null,
      workspace.status,
      workspace.createdAt,
      workspace.updatedAt,
    );
    await this.appendEvent(workspace.runID, "workspace.saved", {
      workspaceID: workspace.id,
      memberID: workspace.memberID,
      status: workspace.status,
    });
  }

  async listWorkspaces(runID?: string) {
    await this.ready;
    return this.listWorkspacesSync(runID);
  }

  async markWorkspaceRemoved(id: string) {
    await this.ready;
    this.database
      .query("UPDATE workspaces SET status = 'removed', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  async getSessionMode(sessionID: string) {
    await this.ready;
    return this.database
      .query<{
        mode: ComposerMode;
        collaboration_mode: string | null;
        workflow_name: string | null;
      }, [string]>(
        `SELECT mode, collaboration_mode, workflow_name
         FROM session_modes WHERE session_id = ?`,
      )
      .get(sessionID);
  }

  async setSessionMode(
    sessionID: string,
    mode: ComposerMode,
    selection?: string,
  ) {
    await this.ready;
    this.database.query(
      `INSERT INTO session_modes (
        session_id, mode, collaboration_mode, workflow_name, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        mode = excluded.mode,
        collaboration_mode = excluded.collaboration_mode,
        workflow_name = excluded.workflow_name,
        updated_at = excluded.updated_at`,
    ).run(
      sessionID,
      mode,
      mode === "team" ? selection ?? null : null,
      mode === "workflow" ? selection ?? null : null,
      Date.now(),
    );
  }

  async close() {
    await this.ready;
    this.database.close(false);
  }

  private createSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fleet_members (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        agent TEXT,
        system TEXT,
        enabled INTEGER NOT NULL,
        isolation TEXT NOT NULL DEFAULT 'shared',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_modes (
        session_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        collaboration_mode TEXT,
        workflow_name TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        description TEXT,
        definition_json TEXT NOT NULL,
        source TEXT,
        source_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        definition TEXT NOT NULL,
        workflow_kind TEXT,
        session_id TEXT NOT NULL,
        message_id TEXT,
        idempotency_key TEXT UNIQUE,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT,
        participants TEXT NOT NULL DEFAULT '[]',
        final TEXT,
        error TEXT,
        background INTEGER NOT NULL DEFAULT 0,
        source_hash TEXT,
        control TEXT NOT NULL DEFAULT 'run',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_steps (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        member_id TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        PRIMARY KEY (run_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS agent_calls (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id TEXT,
        call_index INTEGER NOT NULL,
        member_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        options_json TEXT NOT NULL,
        status TEXT NOT NULL,
        child_session_id TEXT,
        output TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, call_index)
      );
      CREATE TABLE IF NOT EXISTS child_sessions (
        key TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        agent TEXT,
        session_id TEXT NOT NULL,
        workspace_id TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        member_id TEXT NOT NULL,
        directory TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_status_updated ON runs(status, updated_at);
      CREATE INDEX IF NOT EXISTS events_run_id ON events(run_id, id);
      CREATE INDEX IF NOT EXISTS workspaces_run_id ON workspaces(run_id);
    `);
  }

  private secureDatabaseFiles() {
    [this.path, `${this.path}-wal`, `${this.path}-shm`]
      .filter(existsSync)
      .forEach((path) => chmodSync(path, 0o600));
  }

  private async initialize(legacyPath?: string) {
    await this.importLegacy(legacyPath);
    this.transaction(() => {
      const now = Date.now();
      const interrupted = this.database
        .query<{ id: string }, [number]>(
          `SELECT runs.id FROM runs
           LEFT JOIN leases ON leases.run_id = runs.id
           WHERE runs.status IN ('pending', 'running', 'paused')
             AND (leases.expires_at IS NULL OR leases.expires_at < ?)`,
        )
        .all(now);
      interrupted.forEach((run) => {
        this.database
          .query("UPDATE runs SET status = 'interrupted', updated_at = ? WHERE id = ?")
          .run(now, run.id);
        this.database
          .query("UPDATE run_steps SET status = 'interrupted' WHERE run_id = ? AND status = 'running'")
          .run(run.id);
        this.appendEventSync(run.id, "run.interrupted", {
          reason: "process lease expired",
        });
      });
      this.database.query("DELETE FROM leases WHERE expires_at < ?").run(now);
      this.pruneSync();
    });
  }

  private async importLegacy(legacyPath?: string) {
    if (this.meta("legacy.imported")) return;
    const path = legacyPath ?? this.path.replace(/\.sqlite$/, ".json");
    const file = Bun.file(path);
    const exists = await file.exists();
    const value: unknown = exists ? await file.json() : undefined;
    this.transaction(() => {
      if (this.meta("legacy.imported")) return;
      if (value !== undefined) {
        const state = normalizeLegacyState(value);
        this.writeFleet(state.fleet);
        state.workflows.forEach((workflow) => this.saveWorkflowSync(workflow));
        state.runs.forEach((run) => this.saveRunSync(run));
        this.appendEventSync(undefined, "legacy.imported", {
          path,
          workflows: state.workflows.length,
          runs: state.runs.length,
        });
      }
      this.setMeta("legacy.imported", exists ? path : "none");
    });
  }

  private transaction<Value>(change: () => Value) {
    return this.database.transaction(change)();
  }

  private readFleet(): Fleet {
    const members = this.database
      .query<{
        id: string;
        role: string;
        provider_id: string;
        model_id: string;
        agent: string | null;
        system: string | null;
        enabled: number;
        isolation: "shared" | "worktree";
      }, []>(
        `SELECT id, role, provider_id, model_id, agent, system, enabled, isolation
         FROM fleet_members ORDER BY updated_at, id`,
      )
      .all()
      .map((member) => ({
        id: member.id,
        role: member.role,
        model: { providerID: member.provider_id, modelID: member.model_id },
        agent: member.agent ?? undefined,
        system: member.system ?? undefined,
        enabled: member.enabled === 1,
        isolation: member.isolation,
      }));
    const selected = this.meta("fleet.lead") ?? members[0]?.id ?? "lead";
    return {
      leadID: members.some((member) => member.id === selected)
        ? selected
        : members[0]?.id ?? "lead",
      members,
    };
  }

  private writeFleet(fleet: Fleet) {
    this.database.exec("DELETE FROM fleet_members");
    fleet.members.forEach((member) => {
      this.database.query(
        `INSERT INTO fleet_members (
          id, role, provider_id, model_id, agent, system, enabled, isolation, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        member.id,
        member.role,
        member.model.providerID,
        member.model.modelID,
        member.agent ?? null,
        member.system ?? null,
        member.enabled ? 1 : 0,
        member.isolation ?? "shared",
        Date.now(),
      );
    });
    this.setMeta("fleet.lead", fleet.leadID);
  }

  private saveWorkflowSync(definition: WorkflowDefinition) {
    const sourceHash = definition.kind === "script"
      ? definition.sourceHash ?? workflowSourceHash(definition.source)
      : null;
    this.database.query(
      `INSERT INTO workflows (
        name, kind, description, definition_json, source, source_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        kind = excluded.kind,
        description = excluded.description,
        definition_json = excluded.definition_json,
        source = excluded.source,
        source_hash = excluded.source_hash,
        updated_at = excluded.updated_at`,
    ).run(
      definition.name,
      definition.kind ?? "dag",
      definition.description ?? null,
      JSON.stringify(definition.kind === "script"
        ? { ...definition, sourceHash }
        : { ...definition, kind: "dag" }),
      definition.kind === "script" ? definition.source : null,
      sourceHash,
      Date.now(),
      Date.now(),
    );
  }

  private listWorkflowsSync() {
    return this.database
      .query<{ definition_json: string }, []>(
        "SELECT definition_json FROM workflows ORDER BY name",
      )
      .all()
      .map((row) => JSON.parse(row.definition_json) as WorkflowDefinition);
  }

  private saveRunSync(run: DurableRun, idempotencyKey?: string) {
    this.database.query(
      `INSERT INTO runs (
        id, kind, definition, workflow_kind, session_id, message_id,
        idempotency_key, input, status, mode, participants, final, error,
        background, source_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        participants = excluded.participants,
        final = excluded.final,
        error = excluded.error,
        background = excluded.background,
        source_hash = excluded.source_hash,
        updated_at = excluded.updated_at`,
    ).run(
      run.id,
      run.kind,
      run.definition,
      run.kind === "workflow" ? run.workflowKind : null,
      run.sessionID,
      run.messageID ?? null,
      idempotencyKey ?? null,
      run.input,
      run.status,
      run.kind === "collaboration" ? run.mode : null,
      JSON.stringify(run.kind === "collaboration" ? run.participants : []),
      run.final ?? null,
      run.error ?? null,
      run.background ? 1 : 0,
      run.kind === "workflow" ? run.sourceHash ?? null : null,
      run.createdAt,
      run.updatedAt,
    );
    this.database.query("DELETE FROM run_steps WHERE run_id = ?").run(run.id);
    run.steps.forEach((step, index) => {
      this.database.query(
        `INSERT INTO run_steps (
          run_id, step_index, step_id, status, member_id, output, error,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        index,
        step.id,
        step.status,
        step.memberID,
        step.output ?? null,
        step.error ?? null,
        step.startedAt ?? null,
        step.completedAt ?? null,
      );
    });
  }

  private getRunSync(runID: string) {
    const row = this.database
      .query<RunRow, [string]>(
        `SELECT id, kind, definition, workflow_kind, session_id, message_id,
          input, status, mode, participants, final, error, background,
          source_hash, created_at, updated_at
         FROM runs WHERE id = ?`,
      )
      .get(runID);
    return row ? this.hydrateRun(row) : undefined;
  }

  private listRunsSync(limit = 100) {
    return this.database
      .query<RunRow, [number]>(
        `SELECT id, kind, definition, workflow_kind, session_id, message_id,
          input, status, mode, participants, final, error, background,
          source_hash, created_at, updated_at
         FROM runs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => this.hydrateRun(row));
  }

  private hydrateRun(row: RunRow): DurableRun {
    const steps = this.database
      .query<StepRow, [string]>(
        `SELECT step_id, status, member_id, output, error, started_at, completed_at
         FROM run_steps WHERE run_id = ? ORDER BY step_index`,
      )
      .all(row.id)
      .map((step) => ({
        id: step.step_id,
        status: step.status,
        memberID: step.member_id,
        output: step.output ?? undefined,
        error: step.error ?? undefined,
        startedAt: step.started_at ?? undefined,
        completedAt: step.completed_at ?? undefined,
      }));
    const common = {
      id: row.id,
      definition: row.definition,
      sessionID: row.session_id,
      messageID: row.message_id ?? undefined,
      input: row.input,
      status: row.status,
      steps,
      final: row.final ?? undefined,
      error: row.error ?? undefined,
      background: row.background === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.kind === "workflow") {
      return {
        ...common,
        kind: "workflow",
        workflowKind: row.workflow_kind ?? "dag",
        sourceHash: row.source_hash ?? undefined,
      } satisfies WorkflowRun;
    }
    return {
      ...common,
      kind: "collaboration",
      mode: row.mode as CollaborationRun["mode"],
      participants: JSON.parse(row.participants) as string[],
    } satisfies CollaborationRun;
  }

  private listEventsSync() {
    return this.database
      .query<{
        id: number;
        run_id: string | null;
        type: string;
        data_json: string;
        created_at: number;
      }, [number]>(
        `SELECT id, run_id, type, data_json, created_at
         FROM events ORDER BY id DESC LIMIT ?`,
      )
      .all(this.retention.events)
      .reverse()
      .map((event) => ({
        id: event.id,
        runID: event.run_id ?? undefined,
        type: event.type,
        data: JSON.parse(event.data_json) as unknown,
        createdAt: event.created_at,
      } satisfies LedgerEvent));
  }

  private appendEventSync(runID: string | undefined, type: string, data: unknown) {
    this.database
      .query("INSERT INTO events (run_id, type, data_json, created_at) VALUES (?, ?, ?, ?)")
      .run(runID ?? null, type, JSON.stringify(data), Date.now());
  }

  private listWorkspacesSync(runID?: string) {
    const rows = runID
      ? this.database.query<{
        id: string;
        run_id: string | null;
        member_id: string;
        directory: string | null;
        status: WorkspaceRecord["status"];
        created_at: number;
        updated_at: number;
      }, [string]>(
        `SELECT id, run_id, member_id, directory, status, created_at, updated_at
         FROM workspaces WHERE run_id = ? ORDER BY created_at`,
      ).all(runID)
      : this.database.query<{
        id: string;
        run_id: string | null;
        member_id: string;
        directory: string | null;
        status: WorkspaceRecord["status"];
        created_at: number;
        updated_at: number;
      }, []>(
        `SELECT id, run_id, member_id, directory, status, created_at, updated_at
         FROM workspaces ORDER BY created_at`,
      ).all();
    return rows.map((workspace) => ({
      id: workspace.id,
      runID: workspace.run_id ?? undefined,
      memberID: workspace.member_id,
      directory: workspace.directory ?? undefined,
      status: workspace.status,
      createdAt: workspace.created_at,
      updatedAt: workspace.updated_at,
    }));
  }

  private acquireLeaseSync(runID: string) {
    if (this.tryAcquireLeaseSync(runID)) return;
    throw new Error(`Run ${runID} is leased by another plugin process.`);
  }

  private tryAcquireLeaseSync(runID: string) {
    const now = Date.now();
    return this.database.query(
      `INSERT INTO leases (run_id, owner, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         owner = excluded.owner,
         expires_at = excluded.expires_at
       WHERE leases.owner = excluded.owner OR leases.expires_at < ?`,
    ).run(runID, this.owner, now + 60_000, now).changes > 0;
  }

  private releaseLeaseSync(runID: string) {
    this.database
      .query("DELETE FROM leases WHERE run_id = ? AND owner = ?")
      .run(runID, this.owner);
  }

  private assertLeaseOwnerOrFreeSync(runID: string) {
    const owner = this.database
      .query<{ owner: string }, [string]>(
        "SELECT owner FROM leases WHERE run_id = ?",
      )
      .get(runID)?.owner;
    if (!owner || owner === this.owner) return;
    throw new Error(`Run ${runID} is leased by another plugin process.`);
  }

  private pruneSync() {
    this.database.query(
      `DELETE FROM runs WHERE id IN (
        SELECT id FROM runs
        WHERE status IN ('completed', 'failed', 'cancelled', 'stopped')
        ORDER BY updated_at DESC LIMIT -1 OFFSET ?
      )`,
    ).run(this.retention.runs);
    this.pruneEventsSync();
  }

  private pruneEventsSync() {
    this.database.query(
      `DELETE FROM events WHERE id IN (
        SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET ?
      )`,
    ).run(this.retention.events);
  }

  private memberExists(memberID: string) {
    return !!this.database
      .query<{ id: string }, [string]>("SELECT id FROM fleet_members WHERE id = ?")
      .get(memberID);
  }

  private meta(key: string) {
    return this.database
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(key)?.value;
  }

  private setMeta(key: string, value: string) {
    this.database
      .query(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}

export function defaultDatabasePath(directory: string) {
  return resolve(directory, ".opencode", "multimodel.sqlite");
}

/** @deprecated Use defaultDatabasePath. */
export function defaultStatePath(directory: string) {
  return resolve(directory, ".opencode", "multimodel.json");
}

export function resolveDatabasePath(directory: string, path: string) {
  return isAbsolute(path) ? path : resolve(directory, path);
}

export function stateDirectory(path: string) {
  return dirname(path);
}

export function workflowSourceHash(source: string) {
  return new Bun.CryptoHasher("sha256")
    .update(normalizeWorkflowSource(source))
    .digest("hex");
}

export function normalizeWorkflowSource(source: string) {
  return source.replace(/\r\n?/g, "\n").trim();
}

function normalizeLegacyState(value: unknown): {
  fleet: Fleet;
  workflows: WorkflowDefinition[];
  runs: WorkflowRun[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Legacy multimodel state must be a JSON object.");
  }
  const input = value as {
    fleet?: unknown;
    workflows?: unknown;
    runs?: unknown;
  };
  const fleet = normalizeFleet(input.fleet);
  const workflows = Array.isArray(input.workflows)
    ? input.workflows.filter(isLegacyWorkflow).map((workflow) => ({
      ...workflow,
      kind: "dag" as const,
    }))
    : [];
  const runs = Array.isArray(input.runs)
    ? input.runs.filter(isLegacyRun).map((run) => ({
      ...run,
      kind: "workflow" as const,
      workflowKind: "dag" as const,
      status: run.status === "running" || run.status === "pending"
        ? "interrupted" as const
        : run.status,
      steps: run.steps.map((step) => ({
        ...step,
        status: step.status === "running" ? "interrupted" as const : step.status,
      })),
    }))
    : [];
  return { fleet, workflows, runs };
}

function normalizeFleet(value: unknown): Fleet {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return structuredClone(EMPTY_FLEET);
  }
  const input = value as Partial<Fleet>;
  const members = Array.isArray(input.members)
    ? input.members.filter(isMember).map((member) => ({
      ...member,
      isolation: member.isolation ?? "shared" as const,
    }))
    : [];
  const leadID = typeof input.leadID === "string" &&
      members.some((member) => member.id === input.leadID)
    ? input.leadID
    : members[0]?.id ?? "lead";
  return { leadID, members };
}

function isMember(value: unknown): value is FleetMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<FleetMember>;
  return (
    typeof item.id === "string" &&
    typeof item.role === "string" &&
    typeof item.enabled === "boolean" &&
    !!item.model &&
    typeof item.model.providerID === "string" &&
    typeof item.model.modelID === "string"
  );
}

function isLegacyWorkflow(value: unknown): value is DagWorkflowDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as { name?: unknown; steps?: unknown };
  return typeof item.name === "string" && Array.isArray(item.steps);
}

function isLegacyRun(value: unknown): value is Omit<WorkflowRun, "kind" | "workflowKind"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as { id?: unknown; definition?: unknown; steps?: unknown };
  return (
    typeof item.id === "string" &&
    typeof item.definition === "string" &&
    Array.isArray(item.steps)
  );
}
