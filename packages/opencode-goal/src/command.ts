export type GoalCommand =
  | { action: "status" }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "clear" }
  | { action: "history" }
  | { action: "list" }
  | { action: "edit"; objective: string }
  | { action: "focus"; index: number }
  | { action: "sequence"; objectives: string[] }
  | { action: "contract"; file?: string }
  | { action: "contract-apply"; file?: string }
  | { action: "dogfood"; enabled?: boolean }
  | {
    action: "set";
    objective: string;
    tokenBudget?: number;
    verification?: string;
    constraints?: string;
    checks: string[];
    maxTurns?: number;
    maxDurationSeconds?: number;
    dogfood?: boolean;
  }
  | {
    action: "add";
    objective: string;
    tokenBudget?: number;
    verification?: string;
    constraints?: string;
    checks: string[];
    maxTurns?: number;
    maxDurationSeconds?: number;
    dogfood?: boolean;
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
  "history",
  "list",
  "edit",
  "focus",
  "add",
  "sequence",
  "contract",
  "dogfood",
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
  if (first === "history") return { action: "history" };
  if (first === "list" || first === "ls") return { action: "list" };
  if (first === "focus" || first === "use") {
    const raw = tokens[1];
    const index = raw ? Number(raw) : NaN;
    if (!Number.isInteger(index) || index < 1) {
      throw new GoalCommandError("Use /goal focus <number from /goal list>.");
    }
    return { action: "focus", index };
  }
  if (first === "sequence" || first === "seq") {
    const objectives = tokens.slice(1).join(" ")
      .split(/[;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (objectives.length < 2) {
      throw new GoalCommandError(
        "Sequence needs at least two objectives separated by ';' or newlines.",
      );
    }
    return { action: "sequence", objectives };
  }
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
  if (first === "edit") {
    const objective = tokens.slice(1).join(" ").trim();
    if (!objective) throw new GoalCommandError("Goal objective is required.");
    return { action: "edit", objective };
  }
  if (first === "contract") {
    const second = tokens[1]?.toLowerCase();
    const flags = parseFlags(tokens.slice(second === "apply" || second === "edit" ? 2 : 1));
    if (second === "apply" || second === "edit") {
      return { action: "contract-apply", file: flags.file };
    }
    return { action: "contract", file: flags.file };
  }
  if (first === "dogfood") {
    const second = tokens[1]?.toLowerCase();
    if (!second || second === "status") return { action: "dogfood" };
    if (second === "on" || second === "true" || second === "enable") {
      return { action: "dogfood", enabled: true };
    }
    if (second === "off" || second === "false" || second === "disable") {
      return { action: "dogfood", enabled: false };
    }
    throw new GoalCommandError(
      'Use /goal dogfood, /goal dogfood on, or /goal dogfood off.',
    );
  }

  const flags = parseFlags(tokens);
  if (!flags.objective) {
    throw new GoalCommandError("Goal objective is required.");
  }
  return {
    action: first === "add" ? "add" : "set",
    objective: flags.objective,
    tokenBudget: flags.tokenBudget,
    verification: flags.verification,
    constraints: flags.constraints,
    checks: flags.checks,
    maxTurns: flags.maxTurns,
    maxDurationSeconds: flags.maxDurationSeconds,
    dogfood: flags.dogfood,
  };
}

function parseFlags(tokens: string[]) {
  const objective: string[] = [];
  const checks: string[] = [];
  let tokenBudget: number | undefined;
  let verification: string | undefined;
  let constraints: string | undefined;
  let maxTurns: number | undefined;
  let maxDurationSeconds: number | undefined;
  let file: string | undefined;
  let dogfood: boolean | undefined;
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
    if (flag === "no-dogfood") {
      dogfood = false;
      continue;
    }
    const value = tokens[index + 1];
    if (flag === "dogfood") {
      if (value && !value.startsWith("--") && isOnOff(value)) {
        dogfood = parseOnOff(value);
        index += 1;
      } else {
        dogfood = true;
      }
      continue;
    }
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
    if (flag === "max-turns") {
      maxTurns = parsePositiveInt(value, "max-turns", 1, 1_000);
      continue;
    }
    if (flag === "max-minutes") {
      maxDurationSeconds = parsePositiveInt(value, "max-minutes", 1, 1_440) * 60;
      continue;
    }
    if (flag === "file") {
      file = value;
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
    maxTurns,
    maxDurationSeconds,
    file,
    dogfood,
  };
}

function isOnOff(value: string) {
  return ["on", "off", "true", "false", "enable", "disable"].includes(
    value.trim().toLowerCase(),
  );
}

function parseOnOff(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "on" || normalized === "true" || normalized === "enable";
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

function parsePositiveInt(
  raw: string,
  flag: string,
  minimum: number,
  maximum: number,
) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new GoalCommandError(
      `--${flag} must be an integer between ${minimum} and ${maximum}.`,
    );
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
