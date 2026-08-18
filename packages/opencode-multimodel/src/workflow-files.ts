import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { MultiModelOptions } from "./options.ts";
import { validateWorkflowScript } from "./script.ts";
import type { StateStore } from "./state.ts";
import { workflowSourceHash } from "./state.ts";
import type { WorkflowDefinition } from "./types.ts";
import { validateWorkflow } from "./workflow.ts";
import {
  extractWorkflowMeta,
  isModuleWorkflowSource,
  validateModuleWorkflowSource,
} from "./workflow-meta.ts";

export async function loadWorkflowDirectories(
  store: StateStore,
  directory: string,
  options: MultiModelOptions["workflows"],
) {
  const files: string[] = [];
  for (const configured of options.directories) {
    const root = isAbsolute(configured) ? configured : resolve(directory, configured);
    const directoryExists = await stat(root).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    if (!directoryExists) continue;
    for await (const file of new Bun.Glob("**/*.{json,js,ts}").scan({
      cwd: root,
      absolute: true,
      onlyFiles: true,
    })) files.push(file);
  }
  let loaded = 0;
  for (const file of files.sort()) {
    try {
      await loadWorkflowFile(store, file, options);
      loaded += 1;
    } catch (error) {
      // One invalid file must not unload the whole plugin: skip it and
      // record a load-failure event so the board shows why it is missing.
      await store.appendEvent(
        `workflow-load-${basename(file)}`,
        "workflow.load.failed",
        {
          file,
          error: error instanceof Error ? error.message : String(error),
        },
      ).catch(() => undefined);
    }
  }
  return loaded;
}

async function loadWorkflowFile(
  store: StateStore,
  file: string,
  options: MultiModelOptions["workflows"],
) {
  if (file.endsWith(".json")) {
    const definition = parseWorkflowDefinition(await Bun.file(file).text());
    if (definition.kind === "script") {
      if (!options.scripts) return;
      definition.sourceHash = validateWorkflowScript(definition.source).sourceHash;
    } else if (definition.kind !== "module") {
      validateWorkflow(definition);
    }
    await store.saveWorkflow(definition);
    return;
  }
  const source = await Bun.file(file).text();
  if (isModuleWorkflowSource(source)) {
    validateModuleWorkflowSource(source);
    const meta = extractWorkflowMeta(source);
    await store.saveWorkflow({
      kind: "module",
      name: meta.name ?? basename(file).replace(/\.(?:js|ts)$/, ""),
      description: meta.description,
      whenToUse: meta.whenToUse,
      phases: meta.phases,
      arguments: meta.arguments,
      path: file,
      source,
      sourceHash: workflowSourceHash(source),
    });
    return;
  }
  if (!options.scripts) return;
  const definition = {
    kind: "script" as const,
    name: scriptName(source) ?? basename(file).replace(/\.(?:js|ts)$/, ""),
    source,
    sourceHash: validateWorkflowScript(source).sourceHash,
  };
  await store.saveWorkflow(definition);
}

export function parseWorkflowDefinition(value: string): WorkflowDefinition {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workflow definition must be a JSON object.");
  }
  const input = parsed as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new Error("Workflow name is required.");
  }
  if (input.kind === "script") {
    if (typeof input.source !== "string") {
      throw new Error("Script workflow source is required.");
    }
    return {
      kind: "script",
      name: input.name,
      description: typeof input.description === "string"
        ? input.description
        : undefined,
      source: input.source,
    };
  }
  if (input.kind !== undefined && input.kind !== "dag") {
    throw new Error('Workflow kind must be "dag" or "script".');
  }
  if (!Array.isArray(input.steps)) {
    throw new Error("DAG workflow steps are required.");
  }
  return { ...input, kind: "dag" } as WorkflowDefinition;
}

function scriptName(source: string) {
  return source.match(
    /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*["']([^"']+)["']/m,
  )?.[1];
}
