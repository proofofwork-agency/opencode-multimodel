import { mapLimit } from "./concurrency.ts";
import { collaborationSystem } from "./prompts.ts";
import { workflowSourceHash } from "./state.ts";
import type {
  AgentRunner,
  Fleet,
  ScriptWorkflowDefinition,
  WorkflowRun,
  WorkflowRunOptions,
} from "./types.ts";

const MAX_SOURCE_BYTES = 500_000;
const MAX_PARALLEL = 6;
const ALLOWED_CALLS = new Set([
  "args",
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "log",
]);
const FORBIDDEN = [
  /\bimport\b/,
  /\brequire\b/,
  /\bprocess\b/,
  /\bBun\b/,
  /\bglobalThis\b/,
  /\bglobal\b/,
  /\bDeno\b/,
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\beval\b/,
  /\bFunction\b/,
  /\bWebAssembly\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bconstructor\b/,
  /\bprototype\b/,
  /\b__proto__\b/,
];

type ScriptNode =
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "identifier"; name: string }
  | { type: "member"; object: ScriptNode; property: string }
  | { type: "array"; items: ScriptNode[] }
  | { type: "object"; entries: Array<[string, ScriptNode]> }
  | { type: "call"; name: string; args: ScriptNode[] };

type Token = {
  type: "identifier" | "string" | "number" | "punctuation" | "eof";
  value: string;
  offset: number;
};

export class ScriptWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptWorkflowError";
  }
}

export function validateWorkflowScript(source: string) {
  if (!source.trim()) throw new ScriptWorkflowError("Workflow source is empty.");
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new ScriptWorkflowError(
      `Workflow source exceeds ${MAX_SOURCE_BYTES} bytes.`,
    );
  }
  const forbidden = FORBIDDEN.find((pattern) => pattern.test(source));
  if (forbidden) {
    throw new ScriptWorkflowError(
      `Forbidden workflow capability ${forbidden}. Scripts may only use args, agent, parallel, pipeline, phase, and log.`,
    );
  }
  const expression = scriptExpression(source);
  const node = new Parser(tokenize(expression)).parse();
  if (!containsAgent(node)) {
    throw new ScriptWorkflowError("Workflow must call agent().");
  }
  return { node, sourceHash: workflowSourceHash(source) };
}

export async function runScriptWorkflow(
  runner: AgentRunner,
  fleet: Fleet,
  parentSessionID: string,
  definition: ScriptWorkflowDefinition,
  input: string,
  options: WorkflowRunOptions = {},
) {
  const validated = validateWorkflowScript(definition.source);
  const lead = fleet.members.find(
    (member) => member.id === fleet.leadID && member.enabled,
  );
  if (!lead) throw new Error(`Fleet lead ${fleet.leadID} is missing or disabled.`);
  const createdAt = Date.now();
  const run: WorkflowRun = options.run
    ? structuredClone(options.run)
    : {
      id: options.runID ?? `workflow_${crypto.randomUUID()}`,
      kind: "workflow",
      workflowKind: "script",
      definition: definition.name,
      sessionID: parentSessionID,
      messageID: options.messageID,
      input,
      status: "pending",
      steps: [],
      background: options.background,
      sourceHash: validated.sourceHash,
      createdAt,
      updatedAt: createdAt,
    };
  run.status = "running";
  run.error = undefined;
  run.sourceHash = validated.sourceHash;
  await publish(run, options);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const state = {
    calls: 0,
    indexes: indexAgentNodes(validated.node),
    logs: [] as string[],
    previous: undefined as unknown,
  };

  try {
    const value = await evaluate(validated.node, {
      runner,
      fleet,
      lead,
      parentSessionID,
      definition,
      run,
      options,
      signal,
      input,
      state,
    });
    run.status = "completed";
    run.final = outputText(value) ??
      [...run.steps].reverse().find((step) => step.output)?.output ??
      state.logs.at(-1) ??
      "Workflow completed.";
    await publish(run, options);
    return run;
  } catch (error) {
    const cancelled = signal.aborted;
    run.status = cancelled ? "cancelled" : "failed";
    run.error = timeout.aborted
      ? `Workflow exceeded ${options.timeoutMs ?? 300_000} ms.`
      : error instanceof Error ? error.message : String(error);
    run.steps
      .filter((step) => step.status === "running" || step.status === "pending")
      .forEach((step) => {
        step.status = "cancelled";
        step.error = run.error;
        step.completedAt = Date.now();
      });
    await publish(run, options);
    if (cancelled) await runner.cancel?.(parentSessionID, run.id);
    return run;
  }
}

type EvaluationContext = {
  runner: AgentRunner;
  fleet: Fleet;
  lead: Fleet["members"][number];
  parentSessionID: string;
  definition: ScriptWorkflowDefinition;
  run: WorkflowRun;
  options: WorkflowRunOptions;
  signal: AbortSignal;
  input: string;
  state: {
    calls: number;
    indexes: Map<ScriptNode, number>;
    logs: string[];
    previous: unknown;
  };
};

async function evaluate(
  node: ScriptNode,
  context: EvaluationContext,
): Promise<unknown> {
  context.signal.throwIfAborted();
  if (node.type === "literal") return node.value;
  if (node.type === "identifier") {
    if (node.name === "args") {
      return { input: context.input, previous: context.state.previous };
    }
    throw new ScriptWorkflowError(`Unknown identifier ${node.name}.`);
  }
  if (node.type === "member") {
    const value = await evaluate(node.object, context);
    if (!isRecord(value)) return undefined;
    return value[node.property];
  }
  if (node.type === "array") {
    const output = [];
    for (const item of node.items) output.push(await evaluate(item, context));
    return output;
  }
  if (node.type === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of node.entries) {
      output[key] = await evaluate(value, context);
    }
    return output;
  }
  if (node.name === "parallel") {
    const list = requireArrayNode(node.args[0], "parallel");
    const parallel = Math.min(
      MAX_PARALLEL,
      Math.max(1, context.options.maxParallel ?? MAX_PARALLEL),
    );
    const values = await mapLimit(list.items, parallel, (item) =>
      evaluate(item, context)
    );
    context.state.previous = values;
    return values;
  }
  if (node.name === "pipeline") {
    const list = requireArrayNode(node.args[0], "pipeline");
    const values = [];
    for (const item of list.items) {
      const value = await evaluate(item, context);
      values.push(value);
      context.state.previous = value;
    }
    return values;
  }
  if (node.name === "phase") {
    const label = String(await evaluateRequired(node.args[0], context, "phase"));
    context.state.logs.push(`phase:${label}`);
    if (!node.args[1]) return label;
    return evaluate(node.args[1], context);
  }
  if (node.name === "log") {
    const value = await evaluateRequired(node.args[0], context, "log");
    context.state.logs.push(outputText(value) ?? String(value));
    return value;
  }
  if (node.name === "args") {
    const key = node.args[0]
      ? String(await evaluate(node.args[0], context))
      : "input";
    if (key === "input") return context.input;
    if (key === "previous") return context.state.previous;
    return undefined;
  }
  if (node.name !== "agent") {
    throw new ScriptWorkflowError(`Unsupported call ${node.name}().`);
  }
  return runAgent(node, context);
}

async function runAgent(
  node: Extract<ScriptNode, { type: "call" }>,
  context: EvaluationContext,
) {
  const request = await evaluateRequired(node.args[0], context, "agent");
  const explicit = node.args[1] ? await evaluate(node.args[1], context) : {};
  const options = isRecord(request)
    ? request
    : isRecord(explicit) ? explicit : {};
  const prompt = isRecord(request)
    ? typeof request.prompt === "string" ? request.prompt : ""
    : String(request);
  if (!prompt.trim()) throw new ScriptWorkflowError("agent() requires a prompt.");
  const maxCalls = Math.min(64, context.options.maxAgentCalls ?? 64);
  if (context.state.calls >= maxCalls) {
    throw new ScriptWorkflowError(
      `Workflow exceeded its ${maxCalls} agent-call limit.`,
    );
  }
  context.state.calls += 1;
  const callIndex = context.state.indexes.get(node)!;
  const stepID = `agent_${callIndex + 1}`;
  const memberID = typeof options.memberID === "string"
    ? options.memberID
    : typeof options.agentId === "string" ? options.agentId : undefined;
  const member = memberID
    ? context.fleet.members.find((item) => item.id === memberID && item.enabled)
    : context.lead;
  if (!member) {
    throw new ScriptWorkflowError(
      `agent() selected missing or disabled fleet member ${memberID}.`,
    );
  }
  await context.options.beforeStep?.(structuredClone(context.run));
  context.signal.throwIfAborted();
  const step = context.run.steps[callIndex] ?? {
    id: stepID,
    status: "pending" as const,
    memberID: member.id,
  };
  context.run.steps[callIndex] = step;
  step.id = stepID;
  step.memberID = member.id;
  step.status = "running";
  step.error = undefined;
  step.startedAt = Date.now();
  await publish(context.run, context.options);
  try {
    const reply = await context.runner.run({
      parentSessionID: context.parentSessionID,
      member,
      prompt,
      system: [
        collaborationSystem(
          member,
          context.lead,
          context.fleet.members.filter((item) => item.enabled),
        ),
        `You are executing confined script workflow **${context.definition.name}**, call ${callIndex + 1}.`,
      ].join("\n\n"),
      signal: context.signal,
      runID: context.run.id,
      stepID,
      callIndex,
    });
    step.status = "completed";
    step.output = reply.text;
    step.completedAt = Date.now();
    await publish(context.run, context.options);
    return reply.text;
  } catch (error) {
    step.status = context.signal.aborted ? "cancelled" : "failed";
    step.error = error instanceof Error ? error.message : String(error);
    step.completedAt = Date.now();
    await publish(context.run, context.options);
    throw error;
  }
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse() {
    const node = this.expression();
    if (this.peek().value === ";") this.index += 1;
    if (this.peek().type !== "eof") this.fail("Unexpected trailing input");
    return node;
  }

  private expression(): ScriptNode {
    let node = this.primary();
    while (this.peek().value === ".") {
      this.index += 1;
      const property = this.consume("identifier").value;
      node = { type: "member", object: node, property };
    }
    if (this.peek().value !== "(") return node;
    if (node.type !== "identifier" || !ALLOWED_CALLS.has(node.name)) {
      this.fail("Only confined workflow functions may be called");
    }
    this.index += 1;
    const args: ScriptNode[] = [];
    while (this.peek().value !== ")") {
      args.push(this.expression());
      if (this.peek().value !== ",") break;
      this.index += 1;
    }
    this.expect(")");
    return { type: "call", name: node.name, args };
  }

  private primary(): ScriptNode {
    const token = this.peek();
    if (token.type === "string") {
      this.index += 1;
      return { type: "literal", value: token.value };
    }
    if (token.type === "number") {
      this.index += 1;
      return { type: "literal", value: Number(token.value) };
    }
    if (token.type === "identifier") {
      this.index += 1;
      if (token.value === "true" || token.value === "false") {
        return { type: "literal", value: token.value === "true" };
      }
      if (token.value === "null") return { type: "literal", value: null };
      if (token.value !== "args" && !ALLOWED_CALLS.has(token.value)) {
        this.fail(`Unknown identifier ${token.value}`, token);
      }
      return { type: "identifier", name: token.value };
    }
    if (token.value === "[") return this.array();
    if (token.value === "{") return this.object();
    if (token.value === "(") {
      this.index += 1;
      const node = this.expression();
      this.expect(")");
      return node;
    }
    this.fail("Expected a workflow expression", token);
  }

  private array(): ScriptNode {
    this.expect("[");
    const items: ScriptNode[] = [];
    while (this.peek().value !== "]") {
      items.push(this.expression());
      if (this.peek().value !== ",") break;
      this.index += 1;
    }
    this.expect("]");
    return { type: "array", items };
  }

  private object(): ScriptNode {
    this.expect("{");
    const entries: Array<[string, ScriptNode]> = [];
    while (this.peek().value !== "}") {
      const key = this.peek();
      if (key.type !== "identifier" && key.type !== "string") {
        this.fail("Expected an object key", key);
      }
      this.index += 1;
      this.expect(":");
      entries.push([key.value, this.expression()]);
      if (this.peek().value !== ",") break;
      this.index += 1;
    }
    this.expect("}");
    return { type: "object", entries };
  }

  private peek() {
    return this.tokens[this.index]!;
  }

  private consume(type: Token["type"]) {
    const token = this.peek();
    if (token.type !== type) this.fail(`Expected ${type}`, token);
    this.index += 1;
    return token;
  }

  private expect(value: string) {
    const token = this.peek();
    if (token.value !== value) this.fail(`Expected ${value}`, token);
    this.index += 1;
  }

  private fail(message: string, token = this.peek()): never {
    throw new ScriptWorkflowError(`${message} at offset ${token.offset}.`);
  }
}

function tokenize(source: string) {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index === -1) index = source.length;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new ScriptWorkflowError("Unterminated comment.");
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index++;
      let value = "";
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") {
          index += 1;
          const escaped = source[index];
          if (escaped === undefined) break;
          value += ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escaped] ?? escaped;
          index += 1;
          continue;
        }
        value += source[index++];
      }
      if (source[index] !== char) {
        throw new ScriptWorkflowError(`Unterminated string at offset ${start}.`);
      }
      index += 1;
      tokens.push({ type: "string", value, offset: start });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const start = index;
      index += 1;
      while (/[0-9.eE+_-]/.test(source[index] ?? "")) index += 1;
      const value = source.slice(start, index);
      if (!Number.isFinite(Number(value))) {
        throw new ScriptWorkflowError(`Invalid number ${value}.`);
      }
      tokens.push({ type: "number", value, offset: start });
      continue;
    }
    if (/[a-zA-Z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (/[a-zA-Z0-9_$-]/.test(source[index] ?? "")) index += 1;
      tokens.push({
        type: "identifier",
        value: source.slice(start, index),
        offset: start,
      });
      continue;
    }
    if ("()[]{},:.;".includes(char)) {
      tokens.push({ type: "punctuation", value: char, offset: index++ });
      continue;
    }
    throw new ScriptWorkflowError(
      `Unsupported syntax ${JSON.stringify(char)} at offset ${index}.`,
    );
  }
  tokens.push({ type: "eof", value: "", offset: source.length });
  return tokens;
}

function scriptExpression(source: string) {
  const withoutMeta = source
    .replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\}\s*;?/m, "")
    .trim();
  const exported = withoutMeta.replace(/^export\s+default\s+/, "").trim();
  const arrow = exported.indexOf("=>");
  if (arrow === -1) return exported;
  const body = exported.slice(arrow + 2).trim();
  if (!body.startsWith("{")) return body;
  const match = body.match(/^\{\s*return\s+([\s\S]*?);?\s*\}\s*;?$/);
  if (!match) {
    throw new ScriptWorkflowError(
      "Confined function bodies may contain only one return expression.",
    );
  }
  return match[1]!;
}

function containsAgent(node: ScriptNode): boolean {
  if (node.type === "call") {
    return node.name === "agent" || node.args.some(containsAgent);
  }
  if (node.type === "array") return node.items.some(containsAgent);
  if (node.type === "object") {
    return node.entries.some(([, value]) => containsAgent(value));
  }
  if (node.type === "member") return containsAgent(node.object);
  return false;
}

function indexAgentNodes(node: ScriptNode) {
  const indexes = new Map<ScriptNode, number>();
  const visit = (current: ScriptNode) => {
    if (current.type === "call") {
      if (current.name === "agent") indexes.set(current, indexes.size);
      current.args.forEach(visit);
      return;
    }
    if (current.type === "array") current.items.forEach(visit);
    if (current.type === "object") {
      current.entries.forEach(([, value]) => visit(value));
    }
    if (current.type === "member") visit(current.object);
  };
  visit(node);
  return indexes;
}

function requireArrayNode(node: ScriptNode | undefined, name: string) {
  if (node?.type === "array") return node;
  throw new ScriptWorkflowError(`${name}() requires an array literal.`);
}

async function evaluateRequired(
  node: ScriptNode | undefined,
  context: EvaluationContext,
  name: string,
) {
  if (!node) throw new ScriptWorkflowError(`${name}() requires an argument.`);
  return evaluate(node, context);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function outputText(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  return JSON.stringify(value, null, 2);
}

async function publish(run: WorkflowRun, options: WorkflowRunOptions) {
  run.updatedAt = Date.now();
  await options.onUpdate?.(structuredClone(run));
}
