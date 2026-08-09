export class AgentBudget {
  readonly total: number;
  private used = 0;

  constructor(total: number) {
    if (!Number.isInteger(total) || total < 1)
      throw new Error("Agent budget must be a positive integer.");
    this.total = Math.min(total, 64);
  }

  get spent() {
    return this.used;
  }

  get remaining() {
    return this.total - this.used;
  }

  spend(label: string) {
    if (this.used >= this.total) {
      throw new Error(
        `${label}: agent-call budget exhausted (${this.used}/${this.total}).`,
      );
    }
    this.used += 1;
  }

  snapshot() {
    return { total: this.total, spent: this.used, remaining: this.remaining };
  }
}

export function defaultAgentBudget(
  mode: string,
  workers: number,
  juryRounds: 1 | 2,
) {
  if (mode === "lead") return 1;
  if (mode === "pair" || mode === "handoff") return 3;
  if (mode === "round") return workers + 1;
  if (mode === "orchestrate") return workers + 2;
  if (mode === "jury" || mode === "panel" || mode === "deliberate")
    return workers * juryRounds + 1;
  return workers + 1;
}
