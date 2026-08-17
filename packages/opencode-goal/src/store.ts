import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { parseCheckpoints, parseHistory } from "./history.ts";
import type { Goal, GoalStatus, GoalVerdict, PauseReason } from "./types.ts";
import {
  defaultGoalFields,
  GOAL_STATUSES,
  JUDGE_VERDICTS,
  isTerminalStatus,
} from "./types.ts";

export const LOCK_TTL_MS = 90_000;
export const LOCK_HARD_TTL_MS = 600_000;

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type GoalRow = {
  session_id: string;
  goal_id: string;
  objective: string;
  status: GoalStatus;
  verification: string | null;
  constraints: string | null;
  checks_json: string;
  required_checks_json: string | null;
  token_budget: number | null;
  max_turns: number | null;
  max_duration_seconds: number | null;
  tokens_used: number;
  time_used_seconds: number;
  turns: number;
  auto_turns: number | null;
  last_had_tools: number;
  continuation_suppressed: number;
  pause_reason: PauseReason | null;
  last_evidence: string | null;
  blocker: string | null;
  last_verdict: string | null;
  last_verdict_reason: string | null;
  last_verdict_at: number | null;
  no_tool_streak: number;
  no_progress_streak: number | null;
  wrapup_sent: number | null;
  completable: number | null;
  dogfood: number | null;
  last_prompt_kind: Goal["lastPromptKind"] | null;
  last_prompt_agent: string | null;
  steer_until: number | null;
  contract_path: string | null;
  contract_hash: string | null;
  history_json: string | null;
  checkpoints_json: string | null;
  focused: number;
  auto_promote: number;
  created_at: number;
  updated_at: number;
};

type OwnerID = `${string}-${string}-${string}-${string}-${string}`;

export class GoalStore {
  readonly path: string;
  private readonly database: Database;
  private owner: OwnerID = crypto.randomUUID();

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.database = new Database(this.path, { create: true, strict: true });
    chmodSync(this.path, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.createSchema();
    this.database
      .query("UPDATE goal_locks SET pid = ? WHERE owner = ?")
      .run(process.pid, this.owner);
  }

  get ownerID() {
    return this.owner;
  }

  setOwner(owner: string) {
    const next = owner as OwnerID;
    if (next === this.owner) return;
    this.database
      .query("UPDATE goal_locks SET pid = ?, owner = ? WHERE owner = ?")
      .run(process.pid, next, this.owner);
    this.owner = next;
  }

  registerService() {
    this.database
      .query(
        `INSERT INTO goal_services (owner, pid, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner) DO UPDATE SET pid = excluded.pid,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run(this.owner, process.pid, Date.now(), Date.now());
  }

  adoptServiceOwner() {
    const rows = this.database
      .query<{ owner: string; pid: number }, []>(
        "SELECT owner, pid FROM goal_services ORDER BY started_at DESC",
      )
      .all();
    for (const row of rows) {
      if (row.pid > 0 && row.pid !== process.pid && processAlive(row.pid)) {
        return row.owner;
      }
    }
    return undefined;
  }

  get(sessionID: string) {
    const row = this.database
      .query<GoalRow, [string]>(
        `SELECT * FROM thread_goals WHERE session_id = ?
         ORDER BY focused DESC, updated_at DESC LIMIT 1`,
      )
      .get(sessionID);
    return row ? hydrate(row) : undefined;
  }

  listForSession(sessionID: string) {
    return this.database
      .query<GoalRow, [string]>(
        "SELECT * FROM thread_goals WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionID)
      .map(hydrate);
  }

  nextQueued(sessionID: string) {
    const row = this.database
      .query<GoalRow, [string]>(
        `SELECT * FROM thread_goals
         WHERE session_id = ? AND auto_promote = 1
           AND status = 'paused' AND pause_reason = 'queued'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(sessionID);
    return row ? hydrate(row) : undefined;
  }

  focusGoal(sessionID: string, goalID: string) {
    return this.transaction(() => {
      this.database
        .query("UPDATE thread_goals SET focused = 0 WHERE session_id = ?")
        .run(sessionID);
      const updated = this.database
        .query(
          "UPDATE thread_goals SET focused = 1, updated_at = ? WHERE session_id = ? AND goal_id = ?",
        )
        .run(Date.now(), sessionID, goalID);
      if (updated.changes === 0) return undefined;
      return this.get(sessionID);
    });
  }

  listActive() {
    return this.database
      .query<GoalRow, []>(
        "SELECT * FROM thread_goals WHERE status = 'active' ORDER BY updated_at DESC",
      )
      .all()
      .map(hydrate);
  }

  listContinuable() {
    return this.database
      .query<GoalRow, []>(
        `SELECT * FROM thread_goals
         WHERE focused = 1
           AND (status IN ('active', 'budget_limited')
                OR (status = 'paused' AND pause_reason IN ('interrupt', 'recovery')))
         ORDER BY updated_at DESC`,
      )
      .all()
      .map(hydrate);
  }

  importMissing(goal: Goal) {
    const existing = this.database
      .query<{ goal_id: string }, [string, string]>(
        "SELECT goal_id FROM thread_goals WHERE session_id = ? AND goal_id = ?",
      )
      .get(goal.sessionID, goal.goalID);
    if (existing) return this.get(goal.sessionID);
    this.upsert(goal);
    return goal;
  }

  clearForeignLocks() {
    this.expireStaleLocks();
  }

  expireStaleLocks() {
    const now = Date.now();
    type StaleRow = {
      session_id: string;
      owner: string;
      pid: number | null;
      updated_at: number;
    };
    const candidates = this.database
      .query<StaleRow, [number]>(
        "SELECT session_id, owner, pid, updated_at FROM goal_locks WHERE updated_at < ?",
      )
      .all(now - LOCK_TTL_MS);
    for (const row of candidates) {
      const age = now - row.updated_at;
      if (row.pid !== null && row.pid > 0 && age < LOCK_HARD_TTL_MS) {
        if (row.pid === process.pid || processAlive(row.pid)) continue;
      }
      this.unlockBy(row.session_id, row.owner);
    }
  }

  replace(input: {
    sessionID: string;
    objective: string;
    tokenBudget?: number;
    verification?: string;
    constraints?: string;
    checks?: string[];
    maxTurns?: number;
    maxDurationSeconds?: number;
    status?: GoalStatus;
    pauseReason?: PauseReason;
    dogfood?: boolean;
    lastPromptAgent?: string;
  }) {
    return this.transaction(() => {
      this.database
        .query("DELETE FROM thread_goals WHERE session_id = ? AND focused = 1")
        .run(input.sessionID);
      return this.createGoal(input);
    });
  }

  insert(input: {
    sessionID: string;
    objective: string;
    tokenBudget?: number;
    verification?: string;
    constraints?: string;
    checks?: string[];
    maxTurns?: number;
    maxDurationSeconds?: number;
    status?: GoalStatus;
    pauseReason?: PauseReason;
    dogfood?: boolean;
    lastPromptAgent?: string;
    focused?: boolean;
    autoPromote?: boolean;
  }) {
    return this.transaction(() => this.createGoal(input));
  }

  private createGoal(input: {
    sessionID: string;
    objective: string;
    tokenBudget?: number;
    verification?: string;
    constraints?: string;
    checks?: string[];
    maxTurns?: number;
    maxDurationSeconds?: number;
    status?: GoalStatus;
    pauseReason?: PauseReason;
    dogfood?: boolean;
    lastPromptAgent?: string;
    focused?: boolean;
    autoPromote?: boolean;
  }) {
    const lastCreated = this.database
      .query<{ last: number | null }, [string]>(
        "SELECT MAX(created_at) AS last FROM thread_goals WHERE session_id = ?",
      )
      .get(input.sessionID)?.last;
    const now = Math.max(Date.now(), (lastCreated ?? 0) + 1);
    const checks = input.checks ?? [];
    const goal: Goal = {
      sessionID: input.sessionID,
      goalID: crypto.randomUUID(),
      objective: input.objective,
      status: input.status ?? "active",
      verification: input.verification,
      constraints: input.constraints,
      checks,
      ...defaultGoalFields(),
      requiredChecks: [...checks],
      dogfood: input.dogfood ?? true,
      focused: input.focused ?? true,
      autoPromote: input.autoPromote ?? false,
      tokenBudget: input.tokenBudget,
      maxTurns: input.maxTurns,
      maxDurationSeconds: input.maxDurationSeconds,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      turns: 0,
      lastHadTools: false,
      continuationSuppressed: false,
      noToolStreak: 0,
      pauseReason: input.pauseReason,
      lastPromptAgent: input.lastPromptAgent,
      createdAt: now,
      updatedAt: now,
    };
    if (goal.focused) {
      this.database
        .query("UPDATE thread_goals SET focused = 0 WHERE session_id = ?")
        .run(input.sessionID);
    }
    this.upsert(goal);
    return goal;
  }

  update(
    sessionID: string,
    expectedGoalID: string,
    patch: Partial<
      Omit<Goal, "sessionID" | "goalID" | "createdAt" | "objective">
    > & { objective?: string },
  ) {
    return this.transaction(() => {
      const current = this.get(sessionID);
      if (!current || current.goalID !== expectedGoalID) return undefined;
      const next: Goal = {
        ...current,
        ...patch,
        checks: patch.checks ?? current.checks,
        requiredChecks: patch.requiredChecks ?? current.requiredChecks,
        history: patch.history ?? current.history,
        checkpoints: patch.checkpoints ?? current.checkpoints,
        updatedAt: Date.now(),
      };
      if (
        next.status === "active" &&
        next.tokenBudget !== undefined &&
        next.tokensUsed >= next.tokenBudget
      ) {
        next.status = "budget_limited";
        next.pauseReason = "budget";
      }
      this.upsert(next);
      return next;
    });
  }

  account(
    sessionID: string,
    expectedGoalID: string,
    delta: { tokens?: number; seconds?: number; turn?: boolean; autoTurn?: boolean },
  ) {
    return this.transaction(() => {
      const current = this.get(sessionID);
      if (!current || current.goalID !== expectedGoalID) return undefined;
      if (current.status !== "active" && current.status !== "budget_limited") {
        return current;
      }
      const tokensUsed = current.tokensUsed + Math.max(0, delta.tokens ?? 0);
      const timeUsedSeconds = current.timeUsedSeconds +
        Math.max(0, delta.seconds ?? 0);
      const turns = current.turns + (delta.turn ? 1 : 0);
      const autoTurns = current.autoTurns + (delta.autoTurn ? 1 : 0);
      let status = current.status;
      let pauseReason = current.pauseReason;
      if (
        current.status === "active" &&
        current.tokenBudget !== undefined &&
        tokensUsed >= current.tokenBudget
      ) {
        status = "budget_limited";
        pauseReason = "budget";
      }
      const next: Goal = {
        ...current,
        tokensUsed,
        timeUsedSeconds,
        turns,
        autoTurns,
        status,
        pauseReason,
        updatedAt: Date.now(),
      };
      this.upsert(next);
      return next;
    });
  }

  clear(sessionID: string) {
    this.database
      .query("DELETE FROM thread_goals WHERE session_id = ?")
      .run(sessionID);
  }

  tryLock(sessionID: string) {
    const now = Date.now();
    this.expireStaleLocks();
    const existing = this.database
      .query<{ owner: string; pid: number | null; updated_at: number }, [string]>(
        "SELECT owner, pid, updated_at FROM goal_locks WHERE session_id = ?",
      )
      .get(sessionID);
    if (existing && existing.owner !== this.owner) return false;
    if (existing) {
      this.heartbeat(sessionID);
      return true;
    }
    try {
      this.database
        .query(
          "INSERT INTO goal_locks (session_id, owner, pid, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(sessionID, this.owner, process.pid, now);
      return true;
    } catch {
      const owner = this.database
        .query<{ owner: string }, [string]>(
          "SELECT owner FROM goal_locks WHERE session_id = ?",
        )
        .get(sessionID)?.owner;
      return owner === this.owner;
    }
  }

  foreignOwnerLive(sessionID: string) {
    const now = Date.now();
    const row = this.database
      .query<{ owner: string; pid: number | null; updated_at: number }, [string]>(
        "SELECT owner, pid, updated_at FROM goal_locks WHERE session_id = ?",
      )
      .get(sessionID);
    if (!row || row.owner === this.owner) return false;
    if (now - row.updated_at < LOCK_TTL_MS) return true;
    return row.pid !== null && row.pid > 0 &&
      now - row.updated_at < LOCK_HARD_TTL_MS && processAlive(row.pid);
  }

  heartbeat(sessionID: string) {
    this.database
      .query(
        "UPDATE goal_locks SET updated_at = ? WHERE session_id = ? AND owner = ?",
      )
      .run(Date.now(), sessionID, this.owner);
  }

  unlock(sessionID: string) {
    this.unlockBy(sessionID, this.owner);
  }

  private unlockBy(sessionID: string, owner: string) {
    this.database
      .query("DELETE FROM goal_locks WHERE session_id = ? AND owner = ?")
      .run(sessionID, owner);
  }

  close() {
    this.database
      .query("DELETE FROM goal_locks WHERE owner = ?")
      .run(this.owner);
    this.database.close(false);
  }

  private upsert(goal: Goal) {
    if (!GOAL_STATUSES.includes(goal.status)) {
      throw new Error(`Invalid goal status ${goal.status}.`);
    }
    this.database.query(
      `INSERT INTO thread_goals (
        session_id, goal_id, objective, status, verification, constraints,
        checks_json, required_checks_json, token_budget, max_turns,
        max_duration_seconds, tokens_used, time_used_seconds, turns, auto_turns,
        last_had_tools, continuation_suppressed, no_tool_streak,
        no_progress_streak, wrapup_sent, completable, dogfood, pause_reason,
        last_evidence, blocker, last_verdict, last_verdict_reason,
        last_verdict_at, last_prompt_kind, last_prompt_agent, steer_until,
        contract_path, contract_hash, history_json, checkpoints_json,
        focused, auto_promote, created_at, updated_at
      ) VALUES (${Array.from({ length: 39 }, () => "?").join(", ")})
      ON CONFLICT(session_id, goal_id) DO UPDATE SET
        goal_id = excluded.goal_id,
        objective = excluded.objective,
        status = excluded.status,
        verification = excluded.verification,
        constraints = excluded.constraints,
        checks_json = excluded.checks_json,
        required_checks_json = excluded.required_checks_json,
        token_budget = excluded.token_budget,
        max_turns = excluded.max_turns,
        max_duration_seconds = excluded.max_duration_seconds,
        tokens_used = excluded.tokens_used,
        time_used_seconds = excluded.time_used_seconds,
        turns = excluded.turns,
        auto_turns = excluded.auto_turns,
        last_had_tools = excluded.last_had_tools,
        continuation_suppressed = excluded.continuation_suppressed,
        no_tool_streak = excluded.no_tool_streak,
        no_progress_streak = excluded.no_progress_streak,
        wrapup_sent = excluded.wrapup_sent,
        completable = excluded.completable,
        dogfood = excluded.dogfood,
        pause_reason = excluded.pause_reason,
        last_evidence = excluded.last_evidence,
        blocker = excluded.blocker,
        last_verdict = excluded.last_verdict,
        last_verdict_reason = excluded.last_verdict_reason,
        last_verdict_at = excluded.last_verdict_at,
        last_prompt_kind = excluded.last_prompt_kind,
        last_prompt_agent = excluded.last_prompt_agent,
        steer_until = excluded.steer_until,
        contract_path = excluded.contract_path,
        contract_hash = excluded.contract_hash,
        history_json = excluded.history_json,
        checkpoints_json = excluded.checkpoints_json,
        focused = excluded.focused,
        auto_promote = excluded.auto_promote,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
    ).run(
      goal.sessionID,
      goal.goalID,
      goal.objective,
      goal.status,
      goal.verification ?? null,
      goal.constraints ?? null,
      JSON.stringify(goal.checks),
      JSON.stringify(goal.requiredChecks),
      goal.tokenBudget ?? null,
      goal.maxTurns ?? null,
      goal.maxDurationSeconds ?? null,
      goal.tokensUsed,
      goal.timeUsedSeconds,
      goal.turns,
      goal.autoTurns,
      goal.lastHadTools ? 1 : 0,
      goal.continuationSuppressed ? 1 : 0,
      goal.noToolStreak,
      goal.noProgressStreak,
      goal.wrapupSent ? 1 : 0,
      goal.completable ? 1 : 0,
      goal.dogfood ? 1 : 0,
      goal.pauseReason ?? null,
      goal.lastEvidence ?? null,
      goal.blocker ?? null,
      goal.lastVerdict?.verdict ?? null,
      goal.lastVerdict?.reason ?? null,
      goal.lastVerdict?.at ?? null,
      goal.lastPromptKind ?? null,
      goal.lastPromptAgent ?? null,
      goal.steerUntil ?? null,
      goal.contractPath ?? null,
      goal.contractHash ?? null,
      JSON.stringify(goal.history),
      JSON.stringify(goal.checkpoints),
      goal.focused ? 1 : 0,
      goal.autoPromote ? 1 : 0,
      goal.createdAt,
      goal.updatedAt,
    );
  }

  private transaction<T>(fn: () => T) {
    return this.database.transaction(fn)();
  }

  private createSchema() {
    const locks = this.database
      .query<{ sql: string | null }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("goal_locks")?.sql;
    if (locks && !locks.includes("pid")) {
      // Lock rows are ephemeral; a one-time drop is safe and keeps the
      // upgrade path simple across releases that predate pid tracking.
      this.database.exec("DROP TABLE goal_locks");
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS goal_locks (
        session_id TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        pid INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS goal_services (
        owner TEXT PRIMARY KEY NOT NULL,
        pid INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
    `);
    this.migrateGoalsTable();
  }

  private migrateGoalsTable() {
    const exists = this.database
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("thread_goals");
    if (!exists) {
      this.database.exec(GOALS_DDL);
      return;
    }
    const sql = this.database
      .query<{ sql: string | null }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("thread_goals")?.sql ?? "";
    if (
      !sql.includes("'unmet'") ||
      !sql.includes("contract_hash") ||
      !sql.includes("dogfood") ||
      !sql.includes("auto_promote") ||
      !sql.includes("PRIMARY KEY (session_id, goal_id)")
    ) {
      this.rebuildGoalsTable();
      return;
    }
  }

  private rebuildGoalsTable() {
    this.database.exec("ALTER TABLE thread_goals RENAME TO thread_goals_legacy");
    this.database.exec(GOALS_DDL);
    const legacy = this.database
      .query<{ name: string }, []>("PRAGMA table_info(thread_goals_legacy)")
      .all()
      .map((column) => column.name);
    const has = (name: string) => legacy.includes(name);
    const rows = this.database.query<Record<string, unknown>, []>(
      "SELECT * FROM thread_goals_legacy",
    ).all();
    for (const row of rows) {
      const hydrated = hydrate({
        session_id: String(row.session_id),
        goal_id: String(row.goal_id),
        objective: String(row.objective),
        status: row.status as GoalStatus,
        verification: (row.verification as string | null) ?? null,
        constraints: (row.constraints as string | null) ?? null,
        checks_json: String(row.checks_json ?? "[]"),
        required_checks_json: has("required_checks_json")
          ? String(row.required_checks_json ?? "[]")
          : null,
        token_budget: (row.token_budget as number | null) ?? null,
        max_turns: has("max_turns") ? (row.max_turns as number | null) ?? null : null,
        max_duration_seconds: has("max_duration_seconds")
          ? (row.max_duration_seconds as number | null) ?? null
          : null,
        tokens_used: Number(row.tokens_used ?? 0),
        time_used_seconds: Number(row.time_used_seconds ?? 0),
        turns: Number(row.turns ?? 0),
        auto_turns: has("auto_turns") ? Number(row.auto_turns ?? 0) : 0,
        last_had_tools: Number(row.last_had_tools ?? 0),
        continuation_suppressed: Number(row.continuation_suppressed ?? 0),
        pause_reason: (row.pause_reason as PauseReason | null) ?? null,
        last_evidence: (row.last_evidence as string | null) ?? null,
        blocker: (row.blocker as string | null) ?? null,
        last_verdict: (row.last_verdict as string | null) ?? null,
        last_verdict_reason: (row.last_verdict_reason as string | null) ?? null,
        last_verdict_at: (row.last_verdict_at as number | null) ?? null,
        no_tool_streak: Number(row.no_tool_streak ?? 0),
        no_progress_streak: has("no_progress_streak")
          ? Number(row.no_progress_streak ?? 0)
          : 0,
        wrapup_sent: has("wrapup_sent") ? Number(row.wrapup_sent ?? 0) : 0,
        completable: has("completable") ? Number(row.completable ?? 0) : 0,
        dogfood: has("dogfood") ? Number(row.dogfood ?? 1) : 1,
        last_prompt_kind: (row.last_prompt_kind as Goal["lastPromptKind"] | null) ??
          null,
        last_prompt_agent: has("last_prompt_agent")
          ? (row.last_prompt_agent as string | null) ?? null
          : null,
        steer_until: (row.steer_until as number | null) ?? null,
        contract_path: has("contract_path")
          ? (row.contract_path as string | null) ?? null
          : null,
        contract_hash: has("contract_hash")
          ? (row.contract_hash as string | null) ?? null
          : null,
        history_json: has("history_json")
          ? (row.history_json as string | null) ?? "[]"
          : "[]",
        checkpoints_json: has("checkpoints_json")
          ? (row.checkpoints_json as string | null) ?? "[]"
          : "[]",
        focused: has("focused") ? Number(row.focused ?? 1) : 1,
        auto_promote: has("auto_promote") ? Number(row.auto_promote ?? 0) : 0,
        created_at: Number(row.created_at ?? 0),
        updated_at: Number(row.updated_at ?? 0),
      });
      this.upsert(hydrated);
    }
    this.database.exec("DROP TABLE thread_goals_legacy");
  }
}

const GOALS_DDL = `
      CREATE TABLE IF NOT EXISTS thread_goals (
        session_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'budget_limited', 'complete', 'impossible', 'unmet')),
        verification TEXT,
        constraints TEXT,
        checks_json TEXT NOT NULL DEFAULT '[]',
        required_checks_json TEXT NOT NULL DEFAULT '[]',
        token_budget INTEGER,
        max_turns INTEGER,
        max_duration_seconds INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        auto_turns INTEGER NOT NULL DEFAULT 0,
        last_had_tools INTEGER NOT NULL DEFAULT 0,
        continuation_suppressed INTEGER NOT NULL DEFAULT 0,
        no_tool_streak INTEGER NOT NULL DEFAULT 0,
        no_progress_streak INTEGER NOT NULL DEFAULT 0,
        wrapup_sent INTEGER NOT NULL DEFAULT 0,
        completable INTEGER NOT NULL DEFAULT 0,
        dogfood INTEGER NOT NULL DEFAULT 1,
        pause_reason TEXT,
        last_evidence TEXT,
        blocker TEXT,
        last_verdict TEXT,
        last_verdict_reason TEXT,
        last_verdict_at INTEGER,
        last_prompt_kind TEXT,
        last_prompt_agent TEXT,
        steer_until INTEGER,
        contract_path TEXT,
        contract_hash TEXT,
        history_json TEXT NOT NULL DEFAULT '[]',
        checkpoints_json TEXT NOT NULL DEFAULT '[]',
        focused INTEGER NOT NULL DEFAULT 1,
        auto_promote INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, goal_id)
      );
    `;

export function resolvePath(directory: string, path: string) {
  return isAbsolute(path) ? path : resolve(directory, path);
}

function hydrate(row: GoalRow): Goal {
  const checks = parseChecks(row.checks_json);
  const checkpoints = parseCheckpoints(row.checkpoints_json);
  return {
    sessionID: row.session_id,
    goalID: row.goal_id,
    objective: row.objective,
    status: row.status,
    verification: row.verification ?? undefined,
    constraints: row.constraints ?? undefined,
    checks,
    requiredChecks: parseChecks(row.required_checks_json ?? JSON.stringify(checks)),
    tokenBudget: row.token_budget ?? undefined,
    maxTurns: row.max_turns ?? undefined,
    maxDurationSeconds: row.max_duration_seconds ?? undefined,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    turns: row.turns,
    autoTurns: row.auto_turns ?? 0,
    lastHadTools: row.last_had_tools === 1,
    continuationSuppressed: row.continuation_suppressed === 1,
    noToolStreak: row.no_tool_streak ?? 0,
    noProgressStreak: row.no_progress_streak ?? 0,
    wrapupSent: row.wrapup_sent === 1,
    completable: row.completable === 1,
    dogfood: row.dogfood !== 0,
    pauseReason: row.pause_reason ?? undefined,
    lastEvidence: row.last_evidence ?? undefined,
    blocker: row.blocker ?? undefined,
    lastVerdict: hydrateVerdict(row),
    lastPromptKind: row.last_prompt_kind ?? undefined,
    lastPromptAgent: row.last_prompt_agent ?? undefined,
    steerUntil: row.steer_until ?? undefined,
    contractPath: row.contract_path ?? undefined,
    contractHash: row.contract_hash ?? undefined,
    history: parseHistory(row.history_json),
    checkpoints,
    lastCheckpoint: checkpoints.at(-1),
    focused: row.focused === 1,
    autoPromote: row.auto_promote === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateVerdict(row: GoalRow): GoalVerdict | undefined {
  if (
    !row.last_verdict ||
    !JUDGE_VERDICTS.includes(row.last_verdict as GoalVerdict["verdict"]) ||
    !row.last_verdict_reason
  ) return undefined;
  return {
    verdict: row.last_verdict as GoalVerdict["verdict"],
    reason: row.last_verdict_reason,
    at: row.last_verdict_at ?? 0,
  };
}

function parseChecks(raw: string) {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export { isTerminalStatus };
