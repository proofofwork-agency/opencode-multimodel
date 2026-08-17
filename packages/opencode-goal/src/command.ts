export type GoalCommand =
  | { action: "status" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "clear" }
  | {
    action: "set";
    objective: string;
    tokenBudget?: number;
    verification?: string;
    constraints?: string;
    checks: string[];
  }
  | {
    action: "budget";
    tokenBudget?: number;
  };

const CONTROL = new Set([
  "status",
  "pause",
  "resume",
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel",
  "budget",
]);

export class GoalCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalCommandError";
  }
}

export function parseGoalCommand(raw: string): GoalCommand {
  const tokens = tokenize(unwrap(raw.trim()));
  if (tokens.length === 0) return { action: "status" };

  const first = tokens[0]!.toLowerCase();
  if (first === "status") return { action: "status" };
  if (first === "pause") return { action: "pause" };
  if (first === "resume") return { action: "resume" };
  if (
    first === "clear" ||
    first === "stop" ||
    first === "off" ||
    first === "reset" ||
    first === "none" ||
    first === "cancel"
  ) return { action: "clear" };
  if (first === "budget") {
    if (tokens.length === 1) return { action: "budget" };
    return { action: "budget", tokenBudget: parseBudget(tokens[1]!) };
  }

  const flags = parseFlags(tokens);
  if (!flags.objective) {
    throw new GoalCommandError("Goal objective is required.");
  }
  return {
    action: "set",
    objective: flags.objective,
    tokenBudget: flags.tokenBudget,
    verification: flags.verification,
    constraints: flags.constraints,
    checks: flags.checks,
  };
}

function parseFlags(tokens: string[]) {
  const objective: string[] = [];
  const checks: string[] = [];
  let tokenBudget: number | undefined;
  let verification: string | undefined;
  let constraints: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const flag = normalizeFlag(token);
    if (!flag) {
      if (CONTROL.has(token.toLowerCase()) && objective.length === 0) {
        throw new GoalCommandError(`Unknown goal control "${token}".`);
      }
      objective.push(token);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new GoalCommandError(`Flag ${flag} requires a value.`);
    }
    index += 1;
    if (flag === "budget" || flag === "token-budget" || flag === "max-tokens") {
      tokenBudget = parseBudget(value);
      continue;
    }
    if (flag === "check" || flag === "verify-cmd") {
      checks.push(value);
      continue;
    }
    if (flag === "verify" || flag === "success" || flag === "accept") {
      verification = joinMaybe(verification, value);
      continue;
    }
    if (flag === "constraint" || flag === "constraints" || flag === "non-goal") {
      constraints = joinMaybe(constraints, value);
      continue;
    }
    throw new GoalCommandError(`Unknown flag --${flag}.`);
  }
  return {
    objective: objective.join(" ").trim(),
    tokenBudget,
    verification,
    constraints,
    checks,
  };
}

export function parseBudget(raw: string) {
  const match = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    throw new GoalCommandError(
      `Token budget must be a positive integer, optionally with a k or m suffix.`,
    );
  }
  const amount = Number(match[1]);
  const suffix = match[2];
  const value = suffix === "m"
    ? Math.round(amount * 1_000_000)
    : suffix === "k"
    ? Math.round(amount * 1_000)
    : Math.round(amount);
  if (!Number.isInteger(value) || value < 1) {
    throw new GoalCommandError("Token budget must be a positive integer.");
  }
  return value;
}

function normalizeFlag(token: string) {
  if (token.startsWith("--")) return token.slice(2).toLowerCase();
  return undefined;
}

function joinMaybe(current: string | undefined, next: string) {
  return current ? `${current}; ${next}` : next;
}

function unwrap(input: string) {
  if (
    input.length >= 2 &&
    ((input.startsWith('"') && input.endsWith('"')) ||
      (input.startsWith("'") && input.endsWith("'")))
  ) {
    return input.slice(1, -1);
  }
  return input;
}

function tokenize(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    if (char === "=" && current.startsWith("--")) {
      tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) throw new GoalCommandError("Unclosed quote in /goal arguments.");
  if (current) tokens.push(current);
  return tokens;
}
