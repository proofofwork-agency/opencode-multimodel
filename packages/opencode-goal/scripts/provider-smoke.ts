import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalService, httpJudge } from "../src/index.ts";
import { parseOptions } from "../src/options.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const baseUrl = flag("baseUrl", "http://127.0.0.1:4096")!.replace(/\/$/, "");
const modelSpec = flag("model", "zai-coding-plan/glm-4.6")!;
const [providerID, modelID] = modelSpec.split("/");
const timeoutMs = Number(flag("timeout", "300")) * 1_000;
const keep = args.includes("--keep");

if (!providerID || !modelID) {
  console.error("--model must be providerID/modelID");
  process.exit(2);
}

const directory = await mkdtemp(join(tmpdir(), "goal-provider-smoke-"));
const query = `?directory=${encodeURIComponent(directory)}`;

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}${query}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

const model = { id: modelID, providerID, variant: undefined };
const created = await api("/session", {
  method: "POST",
  body: JSON.stringify({ title: "goal-provider-smoke", model }),
});
const sessionID = created.id;
if (!sessionID) throw new Error("session create returned no id");

const client = {
  async prompt(input: { sessionID: string; text: string }) {
    const response = await api(`/session/${input.sessionID}/message`, {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID, modelID },
        parts: [{ type: "text", text: input.text }],
      }),
    });
    const info = response.info ?? {};
    if (info.error) throw new Error(`model error: ${JSON.stringify(info.error)}`);
    const parts: Array<Record<string, unknown>> = response.parts ?? [];
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
    const hadTools = parts.some((part) =>
      part.type === "tool" || "tool" in part || "toolName" in part
    );
    const tokens = info.tokens ?? {};
    return {
      text,
      hadTools,
      tokens: tokens.total ??
        (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0),
      outputTokens: tokens.output,
    };
  },
  async messages(id: string) {
    const response = await api(`/session/${id}/message`);
    const messages = Array.isArray(response) ? response : response.data ?? [];
    return messages.map((item: Record<string, unknown>) => ({
      role: (item.info as Record<string, unknown> | undefined)?.role,
      parts: item.parts ?? [],
    }));
  },
  async session(id: string) {
    const response = await api(`/session/${id}`);
    return {
      busy: response.status === "busy",
      model: response.model,
      agent: response.agent,
    };
  },
  async abort(id: string) {
    await api(`/session/${id}/abort`, { method: "POST" });
  },
  judge(prompt: string) {
    return httpJudge({ baseUrl, directory, prompt, model, title: "goal-smoke-judge" });
  },
};

const goals = new GoalService({
  ...parseOptions({
    databasePath: join(directory, ".opencode", "goal.sqlite"),
    snapshotDir: join(directory, ".opencode", "goals"),
    minDelayMs: 500,
  }),
  directory,
  client,
});

const OBJECTIVE =
  "Create the file SMOKE_GOAL.md in the current directory containing exactly the text goal-smoke-ok (no other content), then finish. Do not modify anything else.";
const CHECK = 'test "$(cat SMOKE_GOAL.md 2>/dev/null)" = goal-smoke-ok';

const startedAt = Date.now();
let outcome = "PASS";
let detail = "";
try {
  await goals.apply(sessionID, {
    action: "set",
    objective: OBJECTIVE,
    checks: [CHECK],
  }, { start: true, agent: "build" });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await goals.handleIdle(sessionID).catch(() => undefined);
    const goal = goals.get(sessionID);
    if (!goal || goal.status !== "active") break;
    const check = await fetch(
      `http://127.0.0.1:4096/session/${sessionID}/message${query}`,
      { signal: AbortSignal.timeout(20_000) },
    ).catch(() => undefined);
    void check;
    const probe = Bun.spawnSync({
      cmd: ["/bin/sh", "-c", CHECK],
      cwd: directory,
    });
    if (probe.exitCode === 0) {
      const claimed = await goals.completeFromModel(sessionID, {
        summary: "Host check verified SMOKE_GOAL.md content.",
        evidence:
          `Host check passed (${CHECK}, exit 0). SMOKE_GOAL.md contains goal-smoke-ok.`,
        criteria: [
          { criterion: "SMOKE_GOAL.md exists with exact content", evidence: [CHECK] },
        ],
        checks: [{ command: CHECK, result: "passed" }],
      });
      if (claimed.approved) break;
      if (goals.get(sessionID)?.status !== "active") break;
    }
  }

  const goal = goals.get(sessionID);
  const tokens = goal?.tokensUsed ?? 0;
  if (goal?.status === "complete" && tokens > 0) {
    detail = `state=complete judge=${goal.lastVerdict?.verdict} tokens=${tokens} turns=${goal.turns}`;
  } else {
    outcome = "FAIL";
    detail = `state=${goal?.status ?? "none"} pause=${goal?.pauseReason ?? "-"} tokens=${tokens} turns=${goal?.turns ?? 0} verdict=${goal?.lastVerdict?.verdict ?? "-"} blocker=${goal?.blocker?.slice(0, 120) ?? "-"}`;
  }
} catch (error) {
  outcome = "FAIL";
  detail = `error=${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
} finally {
  goals.close();
  await api(`/session/${sessionID}/abort`, { method: "POST" }).catch(() => undefined);
  if (!keep) await rm(directory, { recursive: true, force: true });
}

const hostVersion = await fetch(`${baseUrl}/doc`)
  .then(() => "live")
  .catch(() => "unknown");

console.log(JSON.stringify({
  outcome,
  host: `opencode ${hostVersion}`,
  model: modelSpec,
  sessionID,
  seconds: Math.round((Date.now() - startedAt) / 1000),
  detail,
}));
process.exit(outcome === "PASS" ? 0 : 1);
