import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { resolvePath } from "./store.ts";

export type PluginRunGate = {
  active: boolean;
  runID?: string;
  kind?: string;
  status?: string;
};

export function multimodelRunGate(
  directory: string,
  sessionID: string,
  databasePath: string,
): PluginRunGate {
  const path = resolvePath(directory, databasePath);
  if (!existsSync(path)) return { active: false };
  try {
    const database = new Database(path, { readonly: true });
    try {
      const row = database
        .query<{
          id: string;
          kind: string;
          status: string;
        }, [string]>(
          `SELECT id, kind, status FROM runs
           WHERE session_id = ?
             AND status IN ('pending', 'running', 'paused')
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(sessionID);
      if (!row) return { active: false };
      return {
        active: true,
        runID: row.id,
        kind: row.kind,
        status: row.status,
      };
    } finally {
      database.close(false);
    }
  } catch {
    return { active: false };
  }
}

export function isCodexDelegateModel(
  providerID?: string,
  modelID?: string,
) {
  const provider = providerID?.trim().toLowerCase() ?? "";
  const model = modelID?.trim().toLowerCase() ?? "";
  return provider === "codex-delegate" ||
    provider.startsWith("codex-delegate") ||
    model.startsWith("codex-delegate/");
}

export function delegatePrompt(base: string, goalBlock?: string) {
  if (!goalBlock) return base;
  if (base.includes("<untrusted_objective>")) return base;
  return `${goalBlock}\n\n${base}`;
}
