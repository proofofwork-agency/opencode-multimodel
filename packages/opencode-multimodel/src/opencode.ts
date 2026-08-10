import type { OpencodeClient } from "@opencode-ai/sdk";
import type { StateStore } from "./state.ts";
import type {
  AgentReply,
  AgentRunner,
  Fleet,
  FleetMember,
  ModelRef,
  RunAgentInput,
} from "./types.ts";

type ClientResponse<Data> = {
  data?: Data;
  error?: unknown;
};

type AgentClient = {
  session: {
    create(input: {
      parentID?: string;
      title?: string;
      workspaceID?: string;
    }): Promise<ClientResponse<{ id: string }>>;
    prompt(input: {
      sessionID: string;
      model: ModelRef;
      agent?: string;
      system?: string;
      tools?: Record<string, boolean>;
      parts: Array<{ type: "text"; text: string }>;
    }): Promise<ClientResponse<{ info?: { error?: unknown }; parts: unknown[] }>>;
    abort(input: { sessionID: string }): Promise<ClientResponse<boolean>>;
  };
  provider?: {
    list(): Promise<ClientResponse<ProviderList>>;
  };
  experimental?: {
    workspace?: {
      create(input: {
        type: string;
        branch?: string | null;
      }): Promise<ClientResponse<{
        id: string;
        directory?: string | null;
      }>>;
      remove(input: { id: string }): Promise<ClientResponse<unknown>>;
    };
  };
};

type ProviderList = {
  all: Array<{
    id: string;
    name: string;
    models: Record<string, {
      id: string;
      name: string;
      capabilities?: { output?: { text?: boolean } };
    }>;
  }>;
  connected?: string[];
  default?: Record<string, string>;
};

type ActiveChild = {
  sessionID: string;
  member: FleetMember;
  runID?: string;
};

const BLOCKED_NESTED_ORCHESTRATION_TOOLS = {
  multimodel_collab: false,
  multimodel_fleet: false,
  multimodel_run: false,
  multimodel_workflow: false,
  codex_delegate: false,
  codex_review: false,
  codex_status: false,
  codex_steer: false,
  codex_cancel: false,
  codex_probe: false,
};

export function asOpenCodeClient(client: unknown) {
  return client as AgentClient;
}

export function adaptPluginClient(client: OpencodeClient): AgentClient {
  return {
    session: {
      create(input) {
        return client.session.create({
          body: {
            parentID: input.parentID,
            title: input.title,
          },
        });
      },
      prompt(input) {
        return client.session.prompt({
          path: { id: input.sessionID },
          body: {
            model: input.model,
            agent: input.agent,
            system: input.system,
            tools: input.tools,
            parts: input.parts,
          },
        });
      },
      abort(input) {
        return client.session.abort({ path: { id: input.sessionID } });
      },
    },
    provider: {
      list() {
        return client.provider.list();
      },
    },
  };
}

export class OpenCodeAgentRunner implements AgentRunner {
  private readonly sessions = new Map<string, {
    sessionID: string;
    workspaceID?: string;
  }>();
  private readonly active = new Map<string, Map<string, ActiveChild>>();

  constructor(
    private readonly client: AgentClient,
    private readonly store?: StateStore,
  ) {}

  async run(input: RunAgentInput): Promise<AgentReply> {
    input.signal?.throwIfAborted();
    const cached = await this.cached(input);
    if (cached) return cached;
    const key = sessionKey(input);
    const session = await this.findOrCreateSession(key, input);
    const active = this.active.get(input.parentSessionID) ??
      new Map<string, ActiveChild>();
    const activeKey = `${input.runID ?? ""}\0${session.sessionID}\0${crypto.randomUUID()}`;
    active.set(activeKey, {
      sessionID: session.sessionID,
      member: input.member,
      runID: input.runID,
    });
    this.active.set(input.parentSessionID, active);
    const abort = () => void this.client.session.abort({
      sessionID: session.sessionID,
    });
    input.signal?.addEventListener("abort", abort, { once: true });
    await this.recordCall(input, "running", session.sessionID);
    try {
      input.signal?.throwIfAborted();
      const response = await this.client.session.prompt({
        sessionID: session.sessionID,
        model: input.member.model,
        agent: input.member.agent,
        system: input.system,
        tools: BLOCKED_NESTED_ORCHESTRATION_TOOLS,
        parts: [{ type: "text", text: input.prompt }],
      });
      if (response.error) {
        throw new Error(`OpenCode prompt failed: ${describe(response.error)}`);
      }
      if (response.data?.info?.error) {
        throw new Error(
          `OpenCode model failed: ${describe(response.data.info.error)}`,
        );
      }
      const text = (response.data?.parts ?? [])
        .filter(isTextPart)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) {
        throw new Error(
          `OpenCode returned no text for fleet member ${input.member.id}.`,
        );
      }
      await this.recordCall(
        input,
        "completed",
        session.sessionID,
        text,
      );
      return {
        memberID: input.member.id,
        sessionID: session.sessionID,
        model: input.member.model,
        text,
      };
    } catch (error) {
      await this.recordCall(
        input,
        input.signal?.aborted ? "cancelled" : "failed",
        session.sessionID,
        undefined,
        describe(error),
      );
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
      active.delete(activeKey);
      if (active.size === 0) this.active.delete(input.parentSessionID);
    }
  }

  async cancel(parentSessionID: string, runID?: string) {
    const sessionIDs = new Set(
      [...(this.active.get(parentSessionID)?.values() ?? [])]
        .filter((child) => !runID || child.runID === runID)
        .map((child) => child.sessionID),
    );
    await Promise.all(
      [...sessionIDs].map((sessionID) =>
        this.client.session.abort({ sessionID }).catch(() => undefined)
      ),
    );
  }

  async steer(parentSessionID: string, prompt: string, runID?: string) {
    const children = [...(this.active.get(parentSessionID)?.values() ?? [])]
      .filter((child) => !runID || child.runID === runID)
      .filter((child, index, all) =>
        all.findIndex((item) => item.sessionID === child.sessionID) === index
      );
    if (children.length === 0) {
      throw new Error(`Run session ${parentSessionID} has no active child sessions.`);
    }
    const responses = await Promise.all(children.map((child) =>
      this.client.session.prompt({
        sessionID: child.sessionID,
        model: child.member.model,
        agent: child.member.agent,
        tools: BLOCKED_NESTED_ORCHESTRATION_TOOLS,
        parts: [{ type: "text", text: prompt }],
      })
    ));
    responses.forEach((response) => {
      if (response.error) {
        throw new Error(`OpenCode steer failed: ${describe(response.error)}`);
      }
      if (response.data?.info?.error) {
        throw new Error(
          `OpenCode steer model failed: ${describe(response.data.info.error)}`,
        );
      }
    });
  }

  async cleanupWorkspaces(runID?: string) {
    if (!this.store) return 0;
    const workspaces = (await this.store.listWorkspaces(runID)).filter(
      (workspace) => workspace.status !== "removed",
    );
    if (workspaces.length === 0) return 0;
    if (!this.client.experimental?.workspace) {
      throw new Error(
        "OpenCode's experimental workspace API is unavailable; no workspaces were removed.",
      );
    }
    for (const workspace of workspaces) {
      const response = await this.client.experimental.workspace.remove({
        id: workspace.id,
      });
      if (response.error) {
        throw new Error(
          `Could not remove workspace ${workspace.id}: ${describe(response.error)}`,
        );
      }
      await this.store.markWorkspaceRemoved(workspace.id);
      await this.store.deleteChildSessionsForWorkspace(workspace.id);
      [...this.sessions.entries()]
        .filter(([, session]) => session.workspaceID === workspace.id)
        .forEach(([key]) => this.sessions.delete(key));
    }
    return workspaces.length;
  }

  async close() {
    await Promise.all(
      [...this.active.keys()].map((parentSessionID) =>
        this.cancel(parentSessionID)
      ),
    );
    this.sessions.clear();
  }

  private async findOrCreateSession(key: string, input: RunAgentInput) {
    const local = this.sessions.get(key);
    if (local) return local;
    const persisted = await this.store?.getChildSession(key);
    if (persisted) {
      const session = {
        sessionID: persisted.session_id,
        workspaceID: persisted.workspace_id ?? undefined,
      };
      this.sessions.set(key, session);
      return session;
    }
    const workspace = await this.createWorkspace(input);
    const response = await this.client.session.create({
      parentID: input.parentSessionID,
      title: `Fleet: ${input.member.id} (${input.member.model.providerID}/${input.member.model.modelID})`,
      workspaceID: workspace?.id,
    });
    if (response.error) {
      throw new Error(
        `OpenCode child session failed: ${describe(response.error)}`,
      );
    }
    if (!response.data?.id) {
      throw new Error("OpenCode child session response had no id.");
    }
    const session = {
      sessionID: response.data.id,
      workspaceID: workspace?.id,
    };
    this.sessions.set(key, session);
    await this.store?.saveChildSession(key, {
      parentSessionID: input.parentSessionID,
      memberID: input.member.id,
      providerID: input.member.model.providerID,
      modelID: input.member.model.modelID,
      agent: input.member.agent,
      sessionID: response.data.id,
      workspaceID: workspace?.id,
    });
    return session;
  }

  private async createWorkspace(input: RunAgentInput) {
    if (input.member.isolation !== "worktree") return undefined;
    // Codex Delegate already owns its detached worktree. Nesting another
    // OpenCode workspace would make both cleanup and file ownership ambiguous.
    if (input.member.model.providerID === "codex-delegate") return undefined;
    if (!this.client.experimental?.workspace) {
      throw new Error(
        `Fleet member ${input.member.id} requires worktree isolation, but OpenCode's experimental workspace API is unavailable. Shared-checkout fallback is forbidden.`,
      );
    }
    const response = await this.client.experimental.workspace.create({
      type: "worktree",
      branch: null,
    });
    if (response.error || !response.data?.id) {
      throw new Error(
        `Could not create isolated workspace for ${input.member.id}: ${describe(response.error ?? "missing workspace id")}. Shared-checkout fallback is forbidden.`,
      );
    }
    const now = Date.now();
    await this.store?.saveWorkspace({
      id: response.data.id,
      runID: input.runID,
      memberID: input.member.id,
      directory: response.data.directory ?? undefined,
      status: "preserved",
      createdAt: now,
      updatedAt: now,
    });
    return response.data;
  }

  private async cached(input: RunAgentInput): Promise<AgentReply | undefined> {
    if (!this.store || !input.runID || input.callIndex === undefined) {
      return undefined;
    }
    const calls = await this.store.cachedAgentCalls(input.runID);
    const prefix = calls.slice(0, input.callIndex + 1);
    if (prefix.length !== input.callIndex + 1) return undefined;
    if (prefix.some((call, index) =>
      call.call_index !== index || call.status !== "completed" || !call.output
    )) return undefined;
    const call = prefix[input.callIndex]!;
    const expected = JSON.stringify(callOptions(input));
    if (
      call.member_id !== input.member.id ||
      call.prompt !== input.prompt ||
      call.options_json !== expected
    ) return undefined;
    return {
      memberID: input.member.id,
      sessionID: call.child_session_id ?? "",
      model: input.member.model,
      text: call.output!,
    };
  }

  private recordCall(
    input: RunAgentInput,
    status: "running" | "completed" | "failed" | "cancelled",
    sessionID?: string,
    output?: string,
    error?: string,
  ) {
    if (!this.store || !input.runID || input.callIndex === undefined) {
      return Promise.resolve();
    }
    return this.store.saveAgentCall({
      runID: input.runID,
      stepID: input.stepID,
      callIndex: input.callIndex,
      memberID: input.member.id,
      prompt: input.prompt,
      options: callOptions(input),
      status,
      sessionID,
      output,
      error,
    });
  }
}

export async function discoverFleet(client: AgentClient): Promise<Fleet> {
  if (!client.provider) return { leadID: "lead", members: [] };
  const response = await client.provider.list();
  if (response.error || !response.data) return { leadID: "lead", members: [] };
  const connected = new Set(
    response.data.connected ?? response.data.all.map((provider) => provider.id),
  );
  const order = new Map(
    (response.data.connected ?? []).map((providerID, index) => [providerID, index]),
  );
  const used = new Set<string>();
  const members = [...response.data.all]
    .filter((provider) => connected.has(provider.id))
    .sort((left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    )
    .flatMap((provider) => {
      const textModels = Object.entries(provider.models)
        .filter(([, model]) => model.capabilities?.output?.text !== false);
      const preferred = response.data?.default?.[provider.id];
      const modelID = preferred && textModels.some(([id]) => id === preferred)
        ? preferred
        : textModels[0]?.[0];
      if (!modelID) return [];
      const base = provider.id.replace(/[^a-zA-Z0-9_-]/g, "-") || "model";
      let id = base;
      let suffix = 2;
      while (used.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(id);
      return [{
        id,
        role: "specialist",
        model: { providerID: provider.id, modelID },
        agent: "plan",
        enabled: true,
        isolation: "shared" as const,
      } satisfies FleetMember];
    });
  return { leadID: members[0]?.id ?? "lead", members };
}

function sessionKey(input: RunAgentInput) {
  return [
    input.parentSessionID,
    input.member.id,
    input.member.model.providerID,
    input.member.model.modelID,
    input.member.agent ?? "",
    input.member.isolation ?? "shared",
    input.member.isolation === "worktree" &&
        input.member.model.providerID !== "codex-delegate"
      ? input.runID ?? ""
      : "",
  ].join("\u0000");
}

function callOptions(input: RunAgentInput) {
  return {
    model: input.member.model,
    agent: input.member.agent ?? null,
    system: input.system ?? null,
    isolation: input.member.isolation ?? "shared",
  };
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as { type?: unknown; text?: unknown };
  return part.type === "text" && typeof part.text === "string";
}

function describe(value: unknown) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
