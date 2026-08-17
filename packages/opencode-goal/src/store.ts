import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { Goal, GoalStatus, GoalVerdict, PauseReason } from "./types.ts";
import { GOAL_STATUSES, JUDGE_VERDICTS, isTerminalStatus } from "./types.ts";

type GoalRow = {
  session_id: string;
  goal_id: string;
  objective: string;
  status: GoalStatus;
  verification: string | null;
  constraints: string | null;
  checks_json: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  turns: number;
  last_had_tools: number;
  continuation_suppressed: number;
  pause_reason: PauseReason | null;
  last_evidence: string | null;
  blocker: string | null;
  last_verdict: string | null;
  last_verdict_reason: string | null;
  last_verdict_at: number | null;
  no_tool_streak: number;
  last_prompt_kind: Goal["lastPromptKind"] | null;
  created_at: number;
  updated_at: number;
};

export class GoalStore {
  readonly path: string;
  private readonly database: Database;
  private readonly owner = crypto.randomUUID();

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
  }

  get(sessionID: string) {
    const row = this.database
      .query<GoalRow, [string]>("SELECT * FROM thread_goals WHERE session_id = ?")
      .get(sessionID);
    return row ? hydrate(row) : undefined;
  }

  listActive() {
    return this.database
      .query<GoalRow, []>(
        "SELECT * FROM thread_goals WHERE status = 'active' ORDER BY updated_at DESC",
      )
      .all()
      .map(hydrate);
  }

  replace(input: {
    sessionID: string;
    objective: string;
    tokenBudget?: number;
    verification?: string;
    constraints?: string;
    checks?: string[];
  }) {
    const now = Date.now();
    const goal: Goal = {
      sessionID: input.sessionID,
      goalID: crypto.randomUUID(),
      objective: input.objective,
      status: "active",
      verification: input.verification,
      constraints: input.constraints,
      checks: input.checks ?? [],
      tokenBudget: input.tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      turns: 0,
      lastHadTools: false,
      continuationSuppressed: false,
      noToolStreak: 0,
      createdAt: now,
      updatedAt: now,
    };
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
    delta: { tokens?: number; seconds?: number; turn?: boolean },
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
    this.database
      .query(
        `DELETE FROM goal_locks WHERE session_id = ? AND updated_at < ?`,
      )
      .run(sessionID, now - 30_000);
    try {
      this.database
        .query(
          `INSERT INTO goal_locks (session_id, owner, updated_at) VALUES (?, ?, ?)`,
        )
        .run(sessionID, this.owner, now);
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

  heartbeat(sessionID: string) {
    this.database
      .query(
        "UPDATE goal_locks SET updated_at = ? WHERE session_id = ? AND owner = ?",
      )
      .run(Date.now(), sessionID, this.owner);
  }

  unlock(sessionID: string) {
    this.database
      .query("DELETE FROM goal_locks WHERE session_id = ? AND owner = ?")
      .run(sessionID, this.owner);
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
        checks_json, token_budget, tokens_used, time_used_seconds, turns,
        last_had_tools, continuation_suppressed, no_tool_streak, pause_reason,
        last_evidence, blocker, last_verdict, last_verdict_reason,
        last_verdict_at, last_prompt_kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        goal_id = excluded.goal_id,
        objective = excluded.objective,
        status = excluded.status,
        verification = excluded.verification,
        constraints = excluded.constraints,
        checks_json = excluded.checks_json,
        token_budget = excluded.token_budget,
        tokens_used = excluded.tokens_used,
        time_used_seconds = excluded.time_used_seconds,
        turns = excluded.turns,
        last_had_tools = excluded.last_had_tools,
        continuation_suppressed = excluded.continuation_suppressed,
        no_tool_streak = excluded.no_tool_streak,
        pause_reason = excluded.pause_reason,
        last_evidence = excluded.last_evidence,
        blocker = excluded.blocker,
        last_verdict = excluded.last_verdict,
        last_verdict_reason = excluded.last_verdict_reason,
        last_verdict_at = excluded.last_verdict_at,
        last_prompt_kind = excluded.last_prompt_kind,
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
      goal.tokenBudget ?? null,
      goal.tokensUsed,
      goal.timeUsedSeconds,
      goal.turns,
      goal.lastHadTools ? 1 : 0,
      goal.continuationSuppressed ? 1 : 0,
      goal.noToolStreak,
      goal.pauseReason ?? null,
      goal.lastEvidence ?? null,
      goal.blocker ?? null,
      goal.lastVerdict?.verdict ?? null,
      goal.lastVerdict?.reason ?? null,
      goal.lastVerdict?.at ?? null,
      goal.lastPromptKind ?? null,
      goal.createdAt,
      goal.updatedAt,
    );
  }

  private transaction<T>(fn: () => T) {
    return this.database.transaction(fn)();
  }

  private createSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS goal_locks (
        session_id TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        updated_at INTEGER NOT NULL
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
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(thread_goals)")
        .all()
        .map((column) => column.name),
    );
    const needed = [
      "no_tool_streak",
      "last_verdict",
      "last_verdict_reason",
      "last_verdict_at",
    ];
    for (const column of needed) {
      if (columns.has(column)) continue;
      if (column === "no_tool_streak") {
        this.database.exec(
          "ALTER TABLE thread_goals ADD COLUMN no_tool_streak INTEGER NOT NULL DEFAULT 0",
        );
      } else if (column === "last_verdict_at") {
        this.database.exec(
          "ALTER TABLE thread_goals ADD COLUMN last_verdict_at INTEGER",
        );
      } else {
        this.database.exec(`ALTER TABLE thread_goals ADD COLUMN ${column} TEXT`);
      }
    }
    try {
      this.database.exec(
        "INSERT INTO thread_goals (session_id, goal_id, objective, status, checks_json, tokens_used, time_used_seconds, turns, last_had_tools, continuation_suppressed, no_tool_streak, created_at, updated_at) VALUES ('__migrate__', 'x', 'x', 'impossible', '[]', 0, 0, 0, 0, 0, 0, 0, 0)",
      );
      this.database.exec(
        "DELETE FROM thread_goals WHERE session_id = '__migrate__'",
      );
    } catch {
      this.database.exec("ALTER TABLE thread_goals RENAME TO thread_goals_legacy");
      this.database.exec(GOALS_DDL);
      this.database.exec(`
        INSERT INTO thread_goals (
          session_id, goal_id, objective, status, verification, constraints,
          checks_json, token_budget, tokens_used, time_used_seconds, turns,
          last_had_tools, continuation_suppressed, no_tool_streak, pause_reason,
          last_evidence, blocker, last_verdict, last_verdict_reason,
          last_verdict_at, last_prompt_kind, created_at, updated_at
        )
        SELECT
          session_id, goal_id, objective, status, verification, constraints,
          checks_json, token_budget, tokens_used, time_used_seconds, turns,
          last_had_tools, continuation_suppressed,
          COALESCE(no_tool_streak, 0), pause_reason, last_evidence, blocker,
          last_verdict, last_verdict_reason, last_verdict_at, last_prompt_kind,
          created_at, updated_at
        FROM thread_goals_legacy
      `);
      this.database.exec("DROP TABLE thread_goals_legacy");
    }
  }
}

const GOALS_DDL = `
      CREATE TABLE IF NOT EXISTS thread_goals (
        session_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'budget_limited', 'complete', 'impossible')),
        verification TEXT,
        constraints TEXT,
        checks_json TEXT NOT NULL DEFAULT '[]',
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        last_had_tools INTEGER NOT NULL DEFAULT 0,
        continuation_suppressed INTEGER NOT NULL DEFAULT 0,
        no_tool_streak INTEGER NOT NULL DEFAULT 0,
        pause_reason TEXT,
        last_evidence TEXT,
        blocker TEXT,
        last_verdict TEXT,
        last_verdict_reason TEXT,
        last_verdict_at INTEGER,
        last_prompt_kind TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `;

export function resolvePath(directory: string, path: string) {
  return isAbsolute(path) ? path : resolve(directory, path);
}

function hydrate(row: GoalRow): Goal {
  return {
    sessionID: row.session_id,
    goalID: row.goal_id,
    objective: row.objective,
    status: row.status,
    verification: row.verification ?? undefined,
    constraints: row.constraints ?? undefined,
    checks: parseChecks(row.checks_json),
    tokenBudget: row.token_budget ?? undefined,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    turns: row.turns,
    lastHadTools: row.last_had_tools === 1,
    continuationSuppressed: row.continuation_suppressed === 1,
    noToolStreak: row.no_tool_streak ?? 0,
    pauseReason: row.pause_reason ?? undefined,
    lastEvidence: row.last_evidence ?? undefined,
    blocker: row.blocker ?? undefined,
    lastVerdict: hydrateVerdict(row),
    lastPromptKind: row.last_prompt_kind ?? undefined,
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
