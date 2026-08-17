import type {
  WorkflowArgument,
  WorkflowArguments,
  WorkflowPhase,
} from "./workflow-api.ts";

const MODULE_SPECIFIERS = [
  "opencode-multimodel/workflow",
  "@opencode-ai/plugin",
  "@opencode-ai/plugin/workflow",
];

const FORBIDDEN = [
  /\bprocess\b/,
  /\bfetch\s*\(/,
  /\brequire\s*\(/,
  /\bBun\b/,
  /\bDeno\b/,
  /\bchild_process\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bglobalThis\b/,
];

export type ExtractedWorkflowMeta = {
  name?: string;
  description?: string;
  whenToUse?: string;
  phases?: WorkflowPhase[];
  arguments?: WorkflowArguments;
};

export function isModuleWorkflowSource(source: string) {
  return MODULE_SPECIFIERS.some((specifier) =>
    source.includes(`from "${specifier}"`) ||
    source.includes(`from '${specifier}'`)
  ) || /export\s+default\s+workflow\s*\(/.test(source);
}

export function validateModuleWorkflowSource(source: string) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /(?:^|[^:])\/\/.*$/gm,
    "",
  );
  const forbidden = FORBIDDEN.find((pattern) => pattern.test(stripped));
  if (forbidden) {
    throw new Error(
      `Module workflows may not use ${String(forbidden)}. Use ctx.agent, ctx.shell, ctx.parallel, and ctx.pipeline.`,
    );
  }
  const imports = [...stripped.matchAll(
    /(?:import|export)\s+[\s\S]*?from\s+["']([^"']+)["']/g,
  )];
  for (const match of imports) {
    const specifier = match[1]!;
    if (!MODULE_SPECIFIERS.includes(specifier)) {
      throw new Error(
        `Module workflows may only import ${MODULE_SPECIFIERS.join(", ")}. Found ${specifier}.`,
      );
    }
  }
}

export function extractWorkflowMeta(source: string): ExtractedWorkflowMeta {
  return {
    name: stringField(source, "name"),
    description: stringField(source, "description"),
    whenToUse: stringField(source, "whenToUse"),
    phases: extractPhases(source),
    arguments: extractArguments(source),
  };
}

export function parseWorkflowArgs(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to key=value parsing.
    }
  }
  const args: Record<string, unknown> = {};
  const pattern =
    /(?:--)?([A-Za-z_][\w-]*)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)/g;
  let found = false;
  for (const match of trimmed.matchAll(pattern)) {
    found = true;
    args[match[1]!] = unquote(match[2]!);
  }
  return found ? args : { input: trimmed };
}

export function coerceWorkflowArgs(
  declared: WorkflowArguments | undefined,
  raw: Record<string, unknown>,
) {
  const output = { ...raw };
  if (!declared) return output;
  for (const [key, spec] of Object.entries(declared)) {
    if (output[key] === undefined && spec.default !== undefined) {
      output[key] = spec.default;
    }
    if (output[key] === undefined) continue;
    output[key] = coerceArgument(key, spec, output[key]);
  }
  return output;
}

function coerceArgument(key: string, spec: WorkflowArgument, value: unknown) {
  if (spec.type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`Workflow argument ${key} must be a finite number.`);
    }
    return number;
  }
  if (spec.type === "boolean") {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw new Error(`Workflow argument ${key} must be true or false.`);
  }
  if (spec.type === "string") return String(value);
  return value;
}

function stringField(source: string, key: string) {
  return source.match(
    new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`),
  )?.[1];
}

function extractPhases(source: string): WorkflowPhase[] | undefined {
  const block = source.match(/phases\s*:\s*\[([\s\S]*?)\]/)?.[1];
  if (block === undefined) return undefined;
  const phases: WorkflowPhase[] = [];
  const token =
    /\{\s*title\s*:\s*["']([^"']+)["'](?:[\s\S]*?model\s*:\s*["']([^"']+)["'])?[\s\S]*?\}|["']([^"']+)["']/g;
  for (const match of block.matchAll(token)) {
    if (match[3]) phases.push(match[3]);
    else {
      phases.push(
        match[2] ? { title: match[1]!, model: match[2] } : match[1]!,
      );
    }
  }
  return phases.length > 0 ? phases : undefined;
}

function extractArguments(source: string): WorkflowArguments | undefined {
  const block = source.match(/arguments\s*:\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (block === undefined) return undefined;
  const args: WorkflowArguments = {};
  for (const match of block.matchAll(
    /\b([A-Za-z_][\w-]*)\s*:\s*\{([\s\S]*?)\}/g,
  )) {
    const body = match[2]!;
    args[match[1]!] = {
      type: body.match(/type\s*:\s*["'](string|number|boolean)["']/)?.[1] as
        | WorkflowArgument["type"]
        | undefined,
      description: body.match(/description\s*:\s*["']([^"']+)["']/)?.[1],
      default: defaultValue(body),
    };
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

function defaultValue(body: string) {
  const match = body.match(
    /default\s*:\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|true|false|-?\d+(?:\.\d+)?)/,
  );
  if (!match) return undefined;
  const raw = match[1]!;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"') || raw.startsWith("'")) return unquote(raw);
  return Number(raw);
}

function unquote(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  }
  return value;
}
