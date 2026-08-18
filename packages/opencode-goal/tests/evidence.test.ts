import { describe, expect, test } from "bun:test";
import { inspectClaim, serializeClaim } from "../src/evidence.ts";
import type { Goal } from "../src/types.ts";

function goal(partial: Partial<Goal> = {}): Goal {
  return {
    sessionID: "ses",
    goalID: "g1",
    objective: "ship",
    status: "active",
    checks: [],
    requiredChecks: [],
    tokensUsed: 0,
    timeUsedSeconds: 0,
    turns: 0,
    autoTurns: 0,
    lastHadTools: false,
    continuationSuppressed: false,
    noToolStreak: 0,
    noProgressStreak: 0,
    wrapupSent: false,
    completable: true,
    dogfood: false,
    focused: true,
    autoPromote: false,
    history: [],
    checkpoints: [],
    toolTrace: [],
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("serializeClaim", () => {
  test("flattens summary, evidence, and criterion evidence pairs", () => {
    const text = serializeClaim({
      summary: "Tests are green.",
      evidence: "Ran npm test: 40 passing.",
      criteria: [
        { criterion: "tests pass", evidence: ["npm test exit 0"] },
        { criterion: "docs", evidence: [] },
      ],
    });
    expect(text).toContain("Tests are green.");
    expect(text).toContain("Ran npm test: 40 passing.");
    expect(text).toContain("tests pass: npm test exit 0");
    expect(text).not.toContain("docs:");
  });

  test("returns empty text for an empty claim", () => {
    expect(serializeClaim({})).toBe("");
  });
});

describe("inspectClaim", () => {
  test("rejects a claim that contains a failed check", () => {
    const audit = inspectClaim(goal(), {
      summary: "Everything is done and verified end to end.",
      checks: [{ command: "npm test", result: "failed" }],
    });
    expect(audit.approved).toBe(false);
    expect(audit.reason).toContain("failed check");
    expect(audit.reason).toContain("npm test");
  });

  test("rejects thin evidence", () => {
    const audit = inspectClaim(goal(), { summary: "done" });
    expect(audit.approved).toBe(false);
    expect(audit.reason).toContain("too thin");
  });

  test("approves a claim with concrete structured evidence", () => {
    const audit = inspectClaim(goal(), {
      summary: "All criteria verified against the repository.",
      criteria: [
        { criterion: "tests pass", evidence: ["npm test: 40 passing"] },
      ],
    });
    expect(audit.approved).toBe(true);
    expect(audit.reason).toContain("tests pass: npm test: 40 passing");
  });
});
