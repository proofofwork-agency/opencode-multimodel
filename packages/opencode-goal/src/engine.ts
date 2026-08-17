import { multimodelRunGate } from "./bridge.ts";
import {
  parseGoalCommand,
  type GoalCommand,
} from "./command.ts";
import {
  applyUserContract,
  freezeGoalContract,
  proveHost,
  type ContractRuntimeOptions,
} from "./contract-runtime.ts";
import { readContractFile, verifyContractHash } from "./contract.ts";
import { type EvidenceClaim, inspectClaim } from "./evidence.ts";
import { formatHistory, pushHistory, recordCheckpoint } from "./history.ts";
import { noProgressShouldPause } from "./limits.ts";
import { judgePrompt, parseJudgeOutput, type JudgeResult } from "./judge.ts";
import { isRestrictedAgent, type GoalOptions } from "./options.ts";
import {
  adaptGoalClient,
  childrenAreBusy,
  isGoalRuntimePrompt,
  lastAssistantText,
  lastAssistantTurn,
  parseModelRef,
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
  formatContractStatus,
  formatGoalList,
  formatGoalReceipt,
  formatGoalStatus,
  startPrompt,
} from "./prompts.ts";
import { GoalSnapshotStore } from "./snapshot.ts";
import { GoalStore, resolvePath } from "./store.ts";
import {
  goalFromSnapshot,
  type Goal,
  type GoalVerdict,
} from "./types.ts";

export type GoalServiceOptions = ContractRuntimeOptions & {
  now?: () => number;
};

export class GoalOwnedError extends Error {
  readonly code = "session_owned_elsewhere";
  constructor() {
    super(
      "Another OpenCode process owns this session's goal. Close that process or fork the session, then retry.",
    );
    this.name = "GoalOwnedError";
  }
}

export class GoalService {
  readonly store: GoalStore;
  readonly snapshots: GoalSnapshotStore;
  private readonly client?: GoalClient;
  private readonly options: GoalServiceOptions;
  private readonly lastPromptAt = new Map<string, number>();
  private readonly promptFailures = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly humanTurns = new Map<string, number>();
  private readonly judgeFailures = new Map<string, number>();
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>();

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
    if (this.store.foreignOwnerLive(sessionID)) return;
    this.humanTurns.set(sessionID, (this.humanTurns.get(sessionID) ?? 0) + 1);
    const goal = this.store.get(sessionID);
    if (!goal || goal.status !== "active") return;
    if (this.options.steerWithoutPause) {
      this.persist(this.store.update(sessionID, goal.goalID, {
        continuationSuppressed: false,
        noToolStreak: 0,
      }));
      return;
    }
    this.persist(pushHistory(
      this.mustUpdate(sessionID, goal.goalID, {
        status: "paused",
        pauseReason: "user",
        continuationSuppressed: false,
        noToolStreak: 0,
      }),
      "paused",
      "Paused after a user message.",
    ));
  }

  async handleCommand(sessionID: string, raw: string) {
    return this.apply(sessionID, parseGoalCommand(raw), { start: true });
  }

  async apply(
    sessionID: string,
    command: GoalCommand,
    options: { start?: boolean; steer?: boolean; agent?: string } = {},
  ) {
    const mutating = command.action !== "status" &&
      command.action !== "history" &&
      command.action !== "contract" &&
      command.action !== "list" &&
      !(command.action === "dogfood" && command.enabled === undefined);
    if (mutating) this.ensureOwned(sessionID);
    if (command.action === "status") {
      return formatGoalStatus(this.store.get(sessionID));
    }
    if (command.action === "history") {
      return formatHistory(this.store.get(sessionID));
    }
    if (command.action === "list") {
      return formatGoalList(this.store.listForSession(sessionID));
    }
    if (command.action === "focus") {
      const goals = this.store.listForSession(sessionID);
      const target = goals[command.index - 1];
      if (!target) {
        throw new Error(`No goal #${command.index}. Use /goal list.`);
      }
      const focused = this.store.focusGoal(sessionID, target.goalID);
      if (!focused) throw new Error("Focus update lost a race with a newer goal.");
      let next = this.persist(focused);
      if (next.pauseReason === "queued" || next.pauseReason === undefined) {
        if (next.status !== "active" && next.status !== "complete" &&
          next.status !== "impossible" && next.status !== "unmet"
        ) {
          next = this.persist(pushHistory(
            this.mustUpdate(sessionID, next.goalID, {
              status: "active",
              pauseReason: undefined,
              continuationSuppressed: false,
              noToolStreak: 0,
              noProgressStreak: 0,
            }),
            "resumed",
            "Focused from the goal list.",
          ));
        }
      }
      if (options.start !== false && next.status === "active") {
        await this.takeOver(sessionID, options.steer !== false);
        await this.prompt(next, "continuation");
      }
      return formatGoalReceipt(this.store.get(sessionID) ?? next, "updated");
    }
    if (command.action === "sequence") {
      const agent = await this.resolveAgent(sessionID, options.agent);
      const restricted = isRestrictedAgent(agent, this.options);
      const created: Goal[] = [];
      for (const [index, objective] of command.objectives.entries()) {
        created.push(this.store.insert({
          sessionID,
          objective,
          status: index === 0
            ? restricted ? "paused" : "active"
            : "paused",
          pauseReason: index === 0
            ? restricted ? "plan" : undefined
            : "queued",
          focused: index === 0,
          autoPromote: true,
          lastPromptAgent: agent,
        }));
      }
      for (const goal of created) {
        await freezeGoalContract({
          goal,
          options: this.options,
          persist: (item) => this.persist(item),
        });
      }
      if (options.start !== false && created[0]!.status === "active") {
        await this.takeOver(sessionID, options.steer !== false);
        await this.prompt(this.store.get(sessionID) ?? created[0]!, "start");
      }
      return formatGoalList(this.store.listForSession(sessionID));
    }
    if (command.action === "contract") {
      return formatContractStatus(this.store.get(sessionID));
    }
    if (command.action === "dogfood") {
      const goal = requireGoal(this.store.get(sessionID));
      if (command.enabled === undefined) {
        return formatContractStatus(goal);
      }
      const next = this.persist(pushHistory({
        ...goal,
        dogfood: command.enabled,
      }, "updated", command.enabled ? "Dogfood enabled." : "Dogfood disabled."));
      if (command.enabled) {
        return freezeGoalContract({
          goal: next,
          options: this.options,
          persist: (item) => this.persist(item),
        }).then((frozen) => formatContractStatus(frozen));
      }
      return formatContractStatus(next);
    }
    if (command.action === "contract-apply") {
      const goal = requireGoal(this.store.get(sessionID));
      return applyUserContract({
        goal,
        file: command.file,
        options: this.options,
        persist: (next) => this.persist(next),
      });
    }
    if (command.action === "clear") {
      this.store.clear(sessionID);
      this.snapshots.remove(sessionID);
      this.humanTurns.delete(sessionID);
      this.clearWatchdog(sessionID);
      this.store.unlock(sessionID);
      return formatGoalReceipt(undefined, "cleared");
    }
    if (command.action === "pause") {
      const goal = requireGoal(this.store.get(sessionID));
      const next = this.persist(pushHistory(
        this.mustUpdate(sessionID, goal.goalID, {
          status: "paused",
          pauseReason: "user",
          continuationSuppressed: false,
        }),
        "paused",
        "Paused by user.",
      ));
      return formatGoalReceipt(next, "paused");
    }
    if (command.action === "resume") {
      const agent = await this.resolveAgent(sessionID, options.agent);
      if (isRestrictedAgent(agent, this.options)) {
        throw new Error(
          "cannot resume the goal while the session is in Plan mode; switch to Build and resume from there",
        );
      }
      const goal = requireGoal(this.store.get(sessionID));
      if (goal.status === "complete" || goal.status === "impossible") {
        throw new Error(
          `${goal.status} goals cannot be resumed. Set a new goal.`,
        );
      }
      const next = this.persist(pushHistory(
        this.mustUpdate(sessionID, goal.goalID, {
          status: "active",
          pauseReason: undefined,
          continuationSuppressed: false,
          noToolStreak: 0,
          noProgressStreak: 0,
          blocker: undefined,
          lastPromptAgent: agent ?? goal.lastPromptAgent,
        }),
        "resumed",
        "Resumed by user.",
      ));
      if (options.start !== false) {
        await this.takeOver(sessionID, options.steer !== false);
        await this.prompt(next, "continuation");
      }
      return formatGoalReceipt(this.store.get(sessionID) ?? next, "resumed");
    }
    if (command.action === "budget") {
      const goal = requireGoal(this.store.get(sessionID));
      const next = this.persist(
        this.store.update(sessionID, goal.goalID, {
          tokenBudget: command.tokenBudget,
        }),
      );
      return formatGoalReceipt(next, "budget");
    }
    if (command.action === "edit") {
      const goal = requireGoal(this.store.get(sessionID));
      const next = this.persist(pushHistory(
        this.mustUpdate(sessionID, goal.goalID, {
          objective: command.objective,
        }),
        "updated",
        "Objective edited.",
      ));
      if (options.start !== false) {
        await this.takeOver(sessionID, options.steer !== false);
        await this.prompt(next, "continuation");
      }
      return formatGoalReceipt(next, "edited");
    }
    if (command.action === "add") {
      const agent = await this.resolveAgent(sessionID, options.agent);
      const restricted = isRestrictedAgent(agent, this.options);
      const previous = this.store.get(sessionID);
      if (previous && previous.status === "active") {
        this.persist(pushHistory(
          this.mustUpdate(sessionID, previous.goalID, {
            status: "paused",
            pauseReason: undefined,
            continuationSuppressed: false,
          }),
          "paused",
          "Backgrounded by /goal add.",
        ));
      }
      const created = this.persist(pushHistory(
        this.store.insert({
          sessionID,
          objective: command.objective,
          tokenBudget: command.tokenBudget,
          verification: command.verification,
          constraints: command.constraints,
          checks: command.checks,
          maxTurns: command.maxTurns ?? this.options.defaultMaxTurns,
          maxDurationSeconds: command.maxDurationSeconds ??
            this.options.defaultMaxDurationSeconds,
          status: restricted ? "paused" : "active",
          pauseReason: restricted ? "plan" : undefined,
          dogfood: command.dogfood ?? this.options.dogfood,
          lastPromptAgent: agent,
        }),
        "created",
        "Goal added and focused.",
      ));
      const frozen = await freezeGoalContract({
        goal: created,
        options: this.options,
        persist: (item) => this.persist(item),
      });
      if (options.start !== false && frozen.status === "active") {
        await this.takeOver(sessionID, options.steer !== false);
        await this.prompt(frozen, "start");
      }
      return formatGoalReceipt(this.store.get(sessionID) ?? frozen, "set");
    }
    const current = this.store.get(sessionID);
    if (current && sameObjective(current.objective, command.objective)) {
      const next = this.persist(
        this.store.update(sessionID, current.goalID, {
          tokenBudget: command.tokenBudget ?? current.tokenBudget,
          verification: command.verification ?? current.verification,
          constraints: command.constraints ?? current.constraints,
          checks: command.checks.length > 0 ? command.checks : current.checks,
          requiredChecks: command.checks.length > 0
            ? command.checks
            : current.requiredChecks,
          maxTurns: command.maxTurns ?? current.maxTurns,
          maxDurationSeconds: command.maxDurationSeconds ??
            current.maxDurationSeconds,
          dogfood: command.dogfood ?? current.dogfood,
        }),
      );
      await freezeGoalContract({
        goal: next,
        options: this.options,
        persist: (item) => this.persist(item),
      });
      if (options.start !== false) {
        await this.takeOver(sessionID, options.steer !== false);
        await this.prompt(this.store.get(sessionID) ?? next, "start");
      }
      return formatGoalReceipt(this.store.get(sessionID) ?? next, "updated");
    }
    const agent = await this.resolveAgent(sessionID, options.agent);
    const restricted = isRestrictedAgent(agent, this.options);
    const created = this.persist(pushHistory(
      this.store.replace({
        sessionID,
        objective: command.objective,
        tokenBudget: command.tokenBudget,
        verification: command.verification,
        constraints: command.constraints,
        checks: command.checks,
        maxTurns: command.maxTurns ?? this.options.defaultMaxTurns,
        maxDurationSeconds: command.maxDurationSeconds ??
          this.options.defaultMaxDurationSeconds,
        status: restricted ? "paused" : "active",
        pauseReason: restricted ? "plan" : undefined,
        dogfood: command.dogfood ?? this.options.dogfood,
        lastPromptAgent: agent,
      }),
      "created",
      restricted
        ? "Created paused in plan mode."
        : "Goal created.",
    ));
    const frozen = await freezeGoalContract({
      goal: created,
      options: this.options,
      persist: (item) => this.persist(item),
    });
    if (options.start !== false && frozen.status === "active") {
      await this.takeOver(sessionID, options.steer !== false);
      await this.prompt(frozen, "start");
    }
    return formatGoalReceipt(this.store.get(sessionID) ?? frozen, "set");
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
    agent?: string,
  ) {
    this.ensureOwned(sessionID);
    if (this.store.listForSession(sessionID).length > 0) {
      throw new Error(
        "A goal already exists on this thread. Clear or replace it from /goal.",
      );
    }
    const created = this.persist(pushHistory(
      this.store.replace({
        sessionID,
        ...input,
        checks: input.checks ?? [],
        maxTurns: this.options.defaultMaxTurns,
        maxDurationSeconds: this.options.defaultMaxDurationSeconds,
        status: isRestrictedAgent(agent, this.options) ? "paused" : "active",
        pauseReason: isRestrictedAgent(agent, this.options) ? "plan" : undefined,
        dogfood: this.options.dogfood,
      }),
      "created",
      "Created from model at user request.",
    ));
    return freezeGoalContract({
      goal: created,
      options: this.options,
      persist: (item) => this.persist(item),
    });
  }

  async completeFromModel(sessionID: string, claim: EvidenceClaim) {
    this.ensureOwned(sessionID);
    const goal = requireGoal(this.store.get(sessionID));
    if (goal.status !== "active" && goal.status !== "budget_limited") {
      throw new Error(`Goal is ${goal.status} and cannot be marked complete.`);
    }
    if (goal.dogfood && goal.contractPath && goal.contractHash) {
      if (!verifyContractHash(goal.contractPath, goal.contractHash)) {
        const next = this.persist(pushHistory(
          this.mustUpdate(sessionID, goal.goalID, {
            status: "paused",
            pauseReason: "audit",
            blocker: "Frozen contract hash mismatch.",
          }),
          "error",
          "Contract hash mismatch; completion refused.",
        ));
        return { approved: false, goal: next, reason: next.blocker };
      }
    }
    const local = inspectClaim(goal, claim);
    if (!local.approved) {
      const next = this.persist(
        this.store.update(sessionID, goal.goalID, {
          blocker: local.reason,
          lastEvidence: claim.evidence ?? claim.summary,
          continuationSuppressed: false,
        }),
      );
      return { approved: false, goal: next, reason: local.reason };
    }
    const host = await proveHost({
      goal,
      claim,
      options: this.options,
      persist: (item) => this.persist(item),
    });
    const contractText = goal.contractPath && verifyContractHash(
      goal.contractPath,
      goal.contractHash ?? "",
    )
      ? readContractFile(goal.contractPath)
      : undefined;
    const judged = await this.evaluate(goal, {
      transcript: claim.evidence ?? claim.summary ?? "",
      hostAudit: host.reason,
      evidence: claim.evidence ?? claim.summary,
      contract: contractText,
    });
    if (judged?.verdict === "impossible") {
      const next = this.markImpossible(goal, judged.reason, claim);
      return { approved: false, goal: next, reason: judged.reason };
    }
    if (!host.approved || judged?.verdict !== "met") {
      const reason = !host.approved
        ? host.reason
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
    const completed = this.persist(pushHistory(
      this.mustUpdate(sessionID, goal.goalID, {
        status: "complete",
        lastEvidence: host.reason,
        blocker: undefined,
        continuationSuppressed: true,
        lastVerdict: {
          verdict: "met",
          reason: judged.reason,
          at: this.now(),
        },
      }),
      "completed",
      judged.reason,
    ));
    const promoted = this.promoteNext(sessionID);
    return {
      approved: true,
      goal: completed,
      reason: promoted
        ? `${judged.reason} Sequence promoted: ${promoted.objective}`
        : judged.reason,
      completionBudgetReport: completionBudgetReport(promoted ?? completed),
    };
  }

  private promoteNext(sessionID: string) {
    const queued = this.store.nextQueued(sessionID);
    if (!queued) return undefined;
    const focused = this.store.focusGoal(sessionID, queued.goalID);
    if (!focused) return undefined;
    const next = this.persist(pushHistory(
      this.mustUpdate(sessionID, queued.goalID, {
        status: "active",
        pauseReason: undefined,
        continuationSuppressed: false,
        noToolStreak: 0,
        noProgressStreak: 0,
      }),
      "resumed",
      "Promoted from the goal sequence.",
    ));
    void this.prompt(next, "start").catch(() => undefined);
    return next;
  }

  async markUnmet(sessionID: string, blocker: string) {
    this.ensureOwned(sessionID);
    const goal = requireGoal(this.store.get(sessionID));
    if (goal.status !== "active" && goal.status !== "budget_limited") {
      throw new Error(`Goal is ${goal.status} and cannot be marked unmet.`);
    }
    const reason = blocker.trim();
    if (reason.length < 8) {
      throw new Error("unmet requires a concrete blocker.");
    }
    const next = this.persist(pushHistory(
      this.mustUpdate(sessionID, goal.goalID, {
        status: "unmet",
        blocker: reason,
        continuationSuppressed: true,
      }),
      "unmet",
      reason,
    ));
    return next;
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
    if (this.store.foreignOwnerLive(sessionID)) {
      return { action: "skip" as const, reason: "session-owned-elsewhere" };
    }
    this.store.tryLock(sessionID);
    const goal = this.store.get(sessionID);
    const now = this.now();
    const decision = decideContinuation({
      goal,
      now,
      lastPromptAt: this.lastPromptAt.get(sessionID),
      minDelayMs: this.options.minDelayMs,
      busy: input.busy === true,
      planMode: isRestrictedAgent(input.agent, this.options),
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
      wrapupRatio: this.options.wrapupRatio,
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
      await this.prompt(this.store.get(sessionID) ?? goal, "continuation");
      return { action: "continue" as const, kind: "continuation" as const };
    }
    if (decision.action === "skip") return decision;
    if (decision.kind === "budget_limit") {
      this.persist(pushHistory(this.mustUpdate(sessionID, goal.goalID, {
        wrapupSent: true,
        status: "budget_limited",
        pauseReason: "budget",
      }), "limited", "Budget wrap-up sent; goal is budget-limited."));
      await this.prompt(this.store.get(sessionID) ?? goal, "budget_limit");
      return decision;
    }
    await this.prompt(goal, "continuation");
    return decision;
  }

  async handleIdle(sessionID: string) {
    this.clearWatchdog(sessionID);
    if (this.store.foreignOwnerLive(sessionID)) {
      return { action: "skip" as const, reason: "session-owned-elsewhere" };
    }
    const session = await this.client?.session?.(sessionID);
    if (session?.busy) {
      this.armWatchdog(sessionID);
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
    if (this.store.foreignOwnerLive(sessionID)) return goal;
    if (goal.steerUntil && this.now() < goal.steerUntil) return goal;
    return this.persist(pushHistory(
      this.mustUpdate(sessionID, goal.goalID, {
        status: "paused",
        pauseReason: "interrupt",
      }),
      "paused",
      "Paused after interrupt.",
    ));
  }

  async takeOver(sessionID: string, enabled = true) {
    if (!enabled || !this.client?.abort) return false;
    if (this.store.foreignOwnerLive(sessionID)) return false;
    const goal = this.store.get(sessionID);
    if (goal) {
      this.persist(
        this.store.update(sessionID, goal.goalID, {
          steerUntil: this.now() + 8_000,
          continuationSuppressed: false,
        }),
      );
    }
    await this.client.abort(sessionID).catch(() => undefined);
    return true;
  }

  async handleResume(sessionID: string) {
    if (this.store.foreignOwnerLive(sessionID)) {
      return this.store.get(sessionID);
    }
    let goal = this.store.get(sessionID) ?? this.importSnapshot(sessionID);
    if (goal && this.shouldAutoResume(goal)) {
      goal = this.reopen(goal, "Session reopened; continuing the persisted goal.");
    }
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) {
      return goal;
    }
    await this.handleIdle(sessionID).catch(() => undefined);
    return this.store.get(sessionID) ?? goal;
  }

  async recoverActive() {
    this.store.clearForeignLocks();
    this.importMissingSnapshots();
    for (const goal of this.store.listContinuable()) {
      if (!this.shouldAutoResume(goal)) continue;
      if (!this.store.tryLock(goal.sessionID)) continue;
      this.reopen(goal, "Recovered after crash or restart; continuing.");
      await this.handleIdle(goal.sessionID).catch(() => undefined);
    }
  }

  private shouldAutoResume(goal: Goal) {
    if (goal.status === "active" || goal.status === "budget_limited") return true;
    if (goal.status !== "paused") return false;
    if (goal.pauseReason === "recovery") return true;
    return goal.pauseReason === "interrupt" && this.options.autoResumeInterrupted;
  }

  private reopen(goal: Goal, detail: string) {
    const status = goal.status === "budget_limited" ? "budget_limited" : "active";
    return this.persist(pushHistory({
      ...goal,
      status,
      pauseReason: status === "budget_limited" ? "budget" : undefined,
      continuationSuppressed: false,
      noToolStreak: 0,
      blocker: status === "budget_limited" ? goal.blocker : undefined,
    }, "resumed", detail));
  }

  private importSnapshot(sessionID: string) {
    const snapshot = this.snapshots.read(sessionID);
    if (!snapshot) return undefined;
    return this.store.importMissing(goalFromSnapshot(snapshot));
  }

  private importMissingSnapshots() {
    for (const snapshot of this.snapshots.list()) {
      this.store.importMissing(goalFromSnapshot(snapshot));
    }
  }

  armWatchdog(sessionID: string) {
    this.clearWatchdog(sessionID);
    const seconds = this.options.maxTurnTimeSeconds;
    if (!seconds) return;
    const timer = setTimeout(() => {
      this.watchdogs.delete(sessionID);
      void this.watchdogFire(sessionID);
    }, seconds * 1000);
    this.watchdogs.set(sessionID, timer);
  }

  private async watchdogFire(sessionID: string) {
    try {
      const session = await this.client?.session?.(sessionID);
      if (session?.busy) {
        this.armWatchdog(sessionID);
        return;
      }
      await this.maybeContinue(sessionID);
    } catch {
      // Watchdog is best effort; idle events remain the primary driver.
    }
  }

  private async resolveAgent(sessionID: string, agent?: string) {
    if (agent !== undefined) return agent;
    if (!this.client?.session) return undefined;
    try {
      return (await this.client.session(sessionID))?.agent;
    } catch {
      return undefined;
    }
  }

  clearWatchdog(sessionID: string) {
    const timer = this.watchdogs.get(sessionID);
    if (!timer) return;
    clearTimeout(timer);
    this.watchdogs.delete(sessionID);
  }

  close() {
    for (const sessionID of this.watchdogs.keys()) this.clearWatchdog(sessionID);
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
    const unusable = judged.verdict === "not_met" &&
      (judged.reason.includes("unusable") || judged.reason.includes("no text") ||
        judged.reason.includes("Judge failed"));
    const failures = unusable
      ? (this.judgeFailures.get(sessionID) ?? 0) + 1
      : 0;
    this.judgeFailures.set(sessionID, failures);
    if (failures >= 3) {
      this.persist(pushHistory(
        this.mustUpdate(sessionID, goal.goalID, {
          status: "paused",
          pauseReason: "audit",
          blocker: "Independent judge repeatedly returned unusable output.",
        }),
        "error",
        "Judge unavailable; paused instead of looping.",
      ));
      return;
    }
    this.persist(recordCheckpoint(
      this.mustUpdate(sessionID, goal.goalID, {
        lastVerdict: {
          verdict: judged.verdict,
          reason: judged.reason,
          at: this.now(),
        },
        lastEvidence: transcript || goal.lastEvidence,
      }),
      transcript,
    ));
  }

  private async evaluate(
    goal: Goal,
    input: {
      transcript: string;
      hostAudit?: string;
      evidence?: string;
      contract?: string;
    },
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
        const model = this.options.judgeModel
          ? parseModelRef(this.options.judgeModel)
          : undefined;
        const judge = this.client.judge;
        const ask = () =>
          judge!(judgePrompt({ goal, ...input }), {
            model: model ?? session?.model,
          });
        let raw = await ask();
        let parsed = parseJudgeOutput(raw);
        if (parsed.verdict === "not_met" && /no text|unusable/.test(parsed.reason)) {
          raw = await ask();
          parsed = parseJudgeOutput(raw);
        }
        return parsed;
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
    return this.persist(pushHistory(
      this.mustUpdate(goal.sessionID, goal.goalID, {
        status: "impossible",
        blocker: reason,
        lastEvidence: claim?.evidence ?? claim?.summary ?? goal.lastEvidence,
        lastVerdict: { verdict: "impossible", reason, at: this.now() },
        continuationSuppressed: true,
      }),
      "impossible",
      reason,
    ));
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
        synthetic: true,
        agent: goal.lastPromptAgent,
      });
      this.lastPromptAt.set(goal.sessionID, this.now());
      this.promptFailures.set(goal.sessionID, 0);
      const accounted = this.store.account(goal.sessionID, goal.goalID, {
        tokens: result.tokens,
        turn: true,
        autoTurn: kind === "continuation",
      });
      const current = accounted ?? this.store.get(goal.sessionID) ?? goal;
      const streak = result.hadTools || kind !== "continuation"
        ? 0
        : current.noToolStreak + 1;
      const outputTokens = result.outputTokens;
      const lowProgress = kind === "continuation" &&
        outputTokens !== undefined &&
        outputTokens < this.options.noProgressTokenThreshold;
      const noProgressStreak = lowProgress
        ? current.noProgressStreak + 1
        : 0;
      const pausedForProgress = noProgressShouldPause({
        outputTokens,
        threshold: this.options.noProgressTokenThreshold,
        streak: noProgressStreak,
        maxStreak: this.options.maxNoProgressTurns,
        reservedContinuation: kind === "continuation",
      });
      this.persist(
        this.store.update(current.sessionID, current.goalID, {
          lastHadTools: result.hadTools,
          noToolStreak: streak,
          noProgressStreak,
          continuationSuppressed: shouldSuppressNextContinuation({
            hadTools: result.hadTools,
            wasContinuation: kind === "continuation",
            streak,
            threshold: this.options.noToolTurnsBeforeSuppress,
          }),
          lastPromptKind: kind,
          ...(pausedForProgress
            ? {
              status: "paused" as const,
              pauseReason: "no_progress" as const,
              blocker: "Repeated low-progress continuation turns.",
            }
            : {}),
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

  private ensureOwned(sessionID: string) {
    if (!this.store.tryLock(sessionID)) throw new GoalOwnedError();
  }

  private mustUpdate(...args: Parameters<GoalStore["update"]>) {
    const next = this.store.update(...args);
    if (!next) throw new Error("Goal update lost a race with a newer goal.");
    return next;
  }

  private persist(goal: Goal | undefined) {
    if (!goal) throw new Error("Goal update lost a race with a newer goal.");
    const stored = this.store.update(goal.sessionID, goal.goalID, goal);
    const next = stored ?? goal;
    if (next.focused !== false) this.snapshots.write(next);
    return next;
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

export type { GoalVerdict };
