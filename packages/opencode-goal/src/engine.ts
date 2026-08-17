import { multimodelRunGate } from "./bridge.ts";
import {
  parseGoalCommand,
  type GoalCommand,
} from "./command.ts";
import {
  auditCompletion,
  formatAudit,
  type EvidenceClaim,
} from "./evidence.ts";
import { judgePrompt, parseJudgeOutput, type JudgeResult } from "./judge.ts";
import type { GoalOptions } from "./options.ts";
import {
  adaptGoalClient,
  childrenAreBusy,
  isGoalRuntimePrompt,
  lastAssistantText,
  lastAssistantTurn,
  tokenTotal,
  turnHadTools,
  type GoalClient,
} from "./opencode.ts";
import {
  decideContinuation,
  sameObjective,
  shouldSuppressNextContinuation,
} from "./policy.ts";
import {
  budgetLimitPrompt,
  completionBudgetReport,
  continuationPrompt,
  formatGoalStatus,
  startPrompt,
} from "./prompts.ts";
import { GoalSnapshotStore } from "./snapshot.ts";
import { GoalStore, resolvePath } from "./store.ts";
import type { Goal, GoalVerdict } from "./types.ts";

export type GoalServiceOptions = GoalOptions & {
  directory: string;
  client?: GoalClient;
  now?: () => number;
  runHostCheck?: typeof import("./evidence.ts").runCheck;
  evaluate?: (input: {
    goal: Goal;
    transcript: string;
    hostAudit?: string;
    evidence?: string;
  }) => Promise<JudgeResult | undefined>;
};

export class GoalService {
  readonly store: GoalStore;
  readonly snapshots: GoalSnapshotStore;
  private readonly client?: GoalClient;
  private readonly options: GoalServiceOptions;
  private readonly lastPromptAt = new Map<string, number>();
  private readonly promptFailures = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly humanTurns = new Map<string, number>();

  constructor(options: GoalServiceOptions) {
    this.options = options;
    this.store = new GoalStore(
      resolvePath(options.directory, options.databasePath),
    );
    this.snapshots = new GoalSnapshotStore(
      resolvePath(options.directory, options.snapshotDir),
    );
    this.client = options.client;
  }

  get(sessionID: string) {
    return this.store.get(sessionID);
  }

  noteHumanMessage(sessionID: string, text: string) {
    if (!text.trim() || isGoalRuntimePrompt(text)) return;
    this.humanTurns.set(sessionID, (this.humanTurns.get(sessionID) ?? 0) + 1);
    const goal = this.store.get(sessionID);
    if (!goal || goal.status !== "active") return;
    this.persist(
      this.store.update(sessionID, goal.goalID, {
        continuationSuppressed: false,
        noToolStreak: 0,
      }),
    );
  }

  async handleCommand(sessionID: string, raw: string) {
    return this.apply(sessionID, parseGoalCommand(raw), { start: true });
  }

  async apply(
    sessionID: string,
    command: GoalCommand,
    options: { start?: boolean } = {},
  ) {
    if (command.action === "status") {
      return formatGoalStatus(this.store.get(sessionID));
    }
    if (command.action === "clear") {
      this.store.clear(sessionID);
      this.snapshots.remove(sessionID);
      this.humanTurns.delete(sessionID);
      return "Goal cleared.";
    }
    if (command.action === "pause") {
      const goal = requireGoal(this.store.get(sessionID));
      const next = this.persist(
        this.store.update(sessionID, goal.goalID, {
          status: "paused",
          pauseReason: "user",
          continuationSuppressed: false,
        }),
      );
      return formatGoalStatus(next);
    }
    if (command.action === "resume") {
      const goal = requireGoal(this.store.get(sessionID));
      if (goal.status === "complete" || goal.status === "impossible") {
        throw new Error(
          `${goal.status} goals cannot be resumed. Set a new goal.`,
        );
      }
      const next = this.persist(
        this.store.update(sessionID, goal.goalID, {
          status: "active",
          pauseReason: undefined,
          continuationSuppressed: false,
          noToolStreak: 0,
          blocker: undefined,
        }),
      );
      if (options.start !== false) await this.prompt(next, "continuation");
      return formatGoalStatus(this.store.get(sessionID) ?? next);
    }
    if (command.action === "budget") {
      const goal = requireGoal(this.store.get(sessionID));
      const next = this.persist(
        this.store.update(sessionID, goal.goalID, {
          tokenBudget: command.tokenBudget,
        }),
      );
      return formatGoalStatus(next);
    }
    const current = this.store.get(sessionID);
    if (current && sameObjective(current.objective, command.objective)) {
      const next = this.persist(
        this.store.update(sessionID, current.goalID, {
          tokenBudget: command.tokenBudget ?? current.tokenBudget,
          verification: command.verification ?? current.verification,
          constraints: command.constraints ?? current.constraints,
          checks: command.checks.length > 0 ? command.checks : current.checks,
        }),
      );
      return formatGoalStatus(next);
    }
    const created = this.persist(this.store.replace({
      sessionID,
      objective: command.objective,
      tokenBudget: command.tokenBudget,
      verification: command.verification,
      constraints: command.constraints,
      checks: command.checks,
    }));
    if (options.start !== false) await this.prompt(created, "start");
    return formatGoalStatus(this.store.get(sessionID) ?? created);
  }

  async createFromModel(
    sessionID: string,
    input: {
      objective: string;
      tokenBudget?: number;
      verification?: string;
      constraints?: string;
      checks?: string[];
    },
  ) {
    if (this.store.get(sessionID)) {
      throw new Error(
        "A goal already exists on this thread. Clear or replace it from /goal.",
      );
    }
    return this.persist(this.store.replace({
      sessionID,
      ...input,
      checks: input.checks ?? [],
    }));
  }

  async completeFromModel(sessionID: string, claim: EvidenceClaim) {
    const goal = requireGoal(this.store.get(sessionID));
    if (goal.status !== "active" && goal.status !== "budget_limited") {
      throw new Error(`Goal is ${goal.status} and cannot be marked complete.`);
    }
    const audit = await auditCompletion(goal, claim, {
      cwd: this.options.directory,
      timeoutMs: this.options.checkTimeoutMs,
      runHostChecks: this.options.runHostChecks,
      requireHostProof: this.options.requireHostProof,
      run: this.options.runHostCheck,
    });
    const judged = await this.evaluate(goal, {
      transcript: claim.evidence ?? claim.summary ?? "",
      hostAudit: formatAudit(audit),
      evidence: claim.evidence ?? claim.summary,
    });
    if (judged?.verdict === "impossible") {
      const next = this.markImpossible(goal, judged.reason, claim);
      return { approved: false, goal: next, reason: judged.reason };
    }
    if (!audit.approved || judged?.verdict !== "met") {
      const reason = !audit.approved
        ? audit.reason
        : judged?.reason ??
          "Independent judge did not confirm completion.";
      const next = this.persist(
        this.store.update(sessionID, goal.goalID, {
          blocker: reason,
          lastEvidence: claim.evidence ?? claim.summary,
          lastVerdict: judged
            ? { verdict: judged.verdict, reason: judged.reason, at: this.now() }
            : goal.lastVerdict,
          continuationSuppressed: false,
        }),
      );
      return { approved: false, goal: next, reason };
    }
    const completed = this.persist(
      this.store.update(sessionID, goal.goalID, {
        status: "complete",
        lastEvidence: audit.reason,
        blocker: undefined,
        continuationSuppressed: true,
        lastVerdict: {
          verdict: "met",
          reason: judged.reason,
          at: this.now(),
        },
      }),
    );
    return {
      approved: true,
      goal: completed,
      reason: judged.reason,
      completionBudgetReport: completionBudgetReport(completed),
    };
  }

  async maybeContinue(sessionID: string, input: {
    agent?: string;
    busy?: boolean;
    queuedUserInput?: boolean;
    childrenBusy?: boolean;
  } = {}) {
    if (this.inflight.has(sessionID)) {
      return { action: "skip" as const, reason: "in-flight" };
    }
    const goal = this.store.get(sessionID);
    const now = this.now();
    const decision = decideContinuation({
      goal,
      now,
      lastPromptAt: this.lastPromptAt.get(sessionID),
      minDelayMs: this.options.minDelayMs,
      busy: input.busy === true,
      planMode: isPlanAgent(input.agent),
      queuedUserInput: input.queuedUserInput === true,
      pluginRunActive: multimodelRunGate(
        this.options.directory,
        sessionID,
        this.options.multimodelDatabasePath,
      ).active,
      childrenBusy: input.childrenBusy === true,
      promptFailures: this.promptFailures.get(sessionID) ?? 0,
      maxPromptFailures: this.options.maxPromptFailures,
      noToolTurnsBeforeSuppress: this.options.noToolTurnsBeforeSuppress,
    });
    if (!goal) return decision;
    if (decision.action === "impossible") {
      this.markImpossible(goal, decision.reason);
      return decision;
    }
    if (decision.action === "complete") {
      const result = await this.completeFromModel(sessionID, {
        evidence: goal.lastEvidence ?? goal.lastVerdict?.reason,
        summary: goal.lastVerdict?.reason,
      });
      if (result.approved) return decision;
      const latest = this.store.get(sessionID);
      if (latest?.status === "paused") {
        await this.apply(sessionID, { action: "resume" }, { start: false });
      }
      await this.prompt(this.store.get(sessionID) ?? goal, "continuation");
      return { action: "continue" as const, kind: "continuation" as const };
    }
    if (decision.action === "skip") return decision;
    if (decision.kind === "budget_limit") {
      await this.prompt(goal, "budget_limit");
      return decision;
    }
    await this.prompt(goal, "continuation");
    return decision;
  }

  async handleIdle(sessionID: string) {
    const session = await this.client?.session?.(sessionID);
    if (session?.busy) {
      return { action: "skip" as const, reason: "busy" };
    }
    const queuedUserInput = this.consumeQueuedHuman(sessionID);
    const childrenBusy = await this.childrenBusy(sessionID);
    await this.accountLatestTurn(sessionID);
    await this.refreshVerdict(sessionID);
    return this.maybeContinue(sessionID, {
      agent: session?.agent,
      queuedUserInput,
      childrenBusy,
    });
  }

  async handleInterrupt(sessionID: string) {
    const goal = this.store.get(sessionID);
    if (!goal || goal.status !== "active") return goal;
    return this.persist(
      this.store.update(sessionID, goal.goalID, {
        status: "paused",
        pauseReason: "interrupt",
      }),
    );
  }

  async handleResume(sessionID: string) {
    const goal = this.store.get(sessionID);
    if (
      !goal ||
      goal.status !== "paused" ||
      goal.pauseReason !== "interrupt" ||
      !this.options.autoResumeInterrupted
    ) return goal;
    return this.persist(
      this.store.update(sessionID, goal.goalID, {
        status: "active",
        pauseReason: undefined,
        continuationSuppressed: false,
      }),
    );
  }

  close() {
    this.store.close();
  }

  private consumeQueuedHuman(sessionID: string) {
    const pending = this.humanTurns.get(sessionID) ?? 0;
    if (pending > 0) {
      this.humanTurns.set(sessionID, pending - 1);
    }
    return pending > 1;
  }

  private async childrenBusy(sessionID: string) {
    if (!this.client?.children) return false;
    const children = await this.client.children(sessionID);
    if (children.length === 0) return false;
    const statuses = await this.client.statuses?.(sessionID) ?? {};
    return childrenAreBusy(children, statuses);
  }

  private async refreshVerdict(sessionID: string) {
    const goal = this.store.get(sessionID);
    if (!goal || goal.status !== "active") return;
    const messages = await this.client?.messages?.(sessionID) ?? [];
    const transcript = lastAssistantText(messages);
    const judged = await this.evaluate(goal, { transcript });
    if (!judged) return;
    this.persist(
      this.store.update(sessionID, goal.goalID, {
        lastVerdict: {
          verdict: judged.verdict,
          reason: judged.reason,
          at: this.now(),
        },
        lastEvidence: transcript || goal.lastEvidence,
      }),
    );
  }

  private async evaluate(
    goal: Goal,
    input: { transcript: string; hostAudit?: string; evidence?: string },
  ): Promise<JudgeResult | undefined> {
    if (this.options.evaluate) {
      return this.options.evaluate({ goal, ...input });
    }
    if (this.options.judge === false) {
      return { verdict: "met", reason: "Judge disabled." };
    }
    if (this.client?.judge) {
      try {
        const session = await this.client.session?.(goal.sessionID);
        const raw = await this.client.judge(judgePrompt({ goal, ...input }), {
          model: session?.model,
        });
        return parseJudgeOutput(raw);
      } catch (error) {
        return {
          verdict: "not_met",
          reason: `Independent judge failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    return {
      verdict: "not_met",
      reason: "Independent judge did not confirm completion.",
    };
  }

  private markImpossible(
    goal: Goal,
    reason: string,
    claim?: EvidenceClaim,
  ) {
    return this.persist(
      this.store.update(goal.sessionID, goal.goalID, {
        status: "impossible",
        blocker: reason,
        lastEvidence: claim?.evidence ?? claim?.summary ?? goal.lastEvidence,
        lastVerdict: { verdict: "impossible", reason, at: this.now() },
        continuationSuppressed: true,
      }),
    );
  }

  private async prompt(
    goal: Goal,
    kind: NonNullable<Goal["lastPromptKind"]>,
  ) {
    if (!this.client) {
      this.persist(
        this.store.update(goal.sessionID, goal.goalID, {
          lastPromptKind: kind,
        }),
      );
      return;
    }
    if (!this.store.tryLock(goal.sessionID)) return;
    this.inflight.add(goal.sessionID);
    const text = kind === "start"
      ? startPrompt(goal)
      : kind === "budget_limit"
      ? budgetLimitPrompt(goal)
      : continuationPrompt(goal);
    try {
      const result = await this.client.prompt({
        sessionID: goal.sessionID,
        text,
      });
      this.lastPromptAt.set(goal.sessionID, this.now());
      this.promptFailures.set(goal.sessionID, 0);
      const accounted = this.store.account(goal.sessionID, goal.goalID, {
        tokens: result.tokens,
        turn: true,
      });
      const current = accounted ?? this.store.get(goal.sessionID) ?? goal;
      const streak = result.hadTools || kind !== "continuation"
        ? 0
        : current.noToolStreak + 1;
      this.persist(
        this.store.update(current.sessionID, current.goalID, {
          lastHadTools: result.hadTools,
          noToolStreak: streak,
          continuationSuppressed: shouldSuppressNextContinuation({
            hadTools: result.hadTools,
            wasContinuation: kind === "continuation",
            streak,
            threshold: this.options.noToolTurnsBeforeSuppress,
          }),
          lastPromptKind: kind,
        }),
      );
    } catch (error) {
      const failures = (this.promptFailures.get(goal.sessionID) ?? 0) + 1;
      this.promptFailures.set(goal.sessionID, failures);
      if (failures >= this.options.maxPromptFailures) {
        this.persist(
          this.store.update(goal.sessionID, goal.goalID, {
            status: "paused",
            pauseReason: "blocked",
            blocker: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      throw error;
    } finally {
      this.store.unlock(goal.sessionID);
      this.inflight.delete(goal.sessionID);
    }
  }

  private async accountLatestTurn(sessionID: string) {
    const goal = this.store.get(sessionID);
    if (!goal || !this.client?.messages) return;
    const messages = await this.client.messages(sessionID);
    const turn = lastAssistantTurn(messages);
    if (!turn) return;
    this.store.account(sessionID, goal.goalID, {
      tokens: tokenTotal(turn.tokens),
    });
    if (goal.lastPromptKind === "continuation") {
      const hadTools = turnHadTools(turn);
      const streak = hadTools ? 0 : goal.noToolStreak + 1;
      this.persist(
        this.store.update(sessionID, goal.goalID, {
          lastHadTools: hadTools,
          noToolStreak: streak,
          continuationSuppressed: shouldSuppressNextContinuation({
            hadTools,
            wasContinuation: true,
            streak,
            threshold: this.options.noToolTurnsBeforeSuppress,
          }),
        }),
      );
    }
  }

  private persist(goal: Goal | undefined) {
    if (!goal) throw new Error("Goal update lost a race with a newer goal.");
    this.snapshots.write(goal);
    return goal;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}

export function createGoalService(
  directory: string,
  options: GoalOptions,
  client?: unknown,
  transport?: { baseUrl?: string },
) {
  return new GoalService({
    ...options,
    directory,
    client: client
      ? adaptGoalClient(client, {
        baseUrl: transport?.baseUrl,
        directory,
      })
      : undefined,
  });
}

function requireGoal(goal: Goal | undefined) {
  if (!goal) throw new Error("No goal is set.");
  return goal;
}

function isPlanAgent(agent?: string) {
  return agent?.trim().toLowerCase() === "plan";
}
