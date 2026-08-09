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

type OpenCodeClient = {
  session: {
    create(input: {
      parentID?: string;
      title?: string;
    }): Promise<ClientResponse<{ id: string }>>;
    prompt(input: {
      sessionID: string;
      model: ModelRef;
      agent?: string;
      system?: string;
      tools?: Record<string, boolean>;
      parts: Array<{ type: "text"; text: string }>;
    }): Promise<
      ClientResponse<{ info?: { error?: unknown }; parts: unknown[] }>
    >;
    abort(input: { sessionID: string }): Promise<ClientResponse<boolean>>;
  };
  provider?: {
    list(): Promise<ClientResponse<ProviderList>>;
  };
};

type ProviderList = {
  all: Array<{
    id: string;
    name: string;
    models: Record<string, { id: string; name: string }>;
  }>;
  connected?: string[];
  default?: Record<string, string>;
};

const BLOCKED_RECURSIVE_TOOLS = {
  multimodel_collab: false,
  multimodel_fleet: false,
  multimodel_workflow: false,
};

export function asOpenCodeClient(client: unknown) {
  return client as OpenCodeClient;
}

export class OpenCodeAgentRunner implements AgentRunner {
  private readonly sessions = new Map<string, string>();
  private readonly active = new Map<string, Set<string>>();

  constructor(private readonly client: OpenCodeClient) {}

  async run(input: RunAgentInput): Promise<AgentReply> {
    input.signal?.throwIfAborted();
    const key = sessionKey(input);
    const sessionID =
      this.sessions.get(key) ?? (await this.createSession(input));
    const active = this.active.get(input.parentSessionID) ?? new Set<string>();
    active.add(sessionID);
    this.active.set(input.parentSessionID, active);
    const abort = () => void this.client.session.abort({ sessionID });
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      input.signal?.throwIfAborted();
      const response = await this.client.session.prompt({
        sessionID,
        model: input.member.model,
        agent: input.member.agent,
        system: input.system,
        tools: BLOCKED_RECURSIVE_TOOLS,
        parts: [{ type: "text", text: input.prompt }],
      });
      if (response.error)
        throw new Error(`OpenCode prompt failed: ${describe(response.error)}`);
      if (response.data?.info?.error)
        throw new Error(
          `OpenCode model failed: ${describe(response.data.info.error)}`,
        );
      const text = (response.data?.parts ?? [])
        .filter(isTextPart)
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text)
        throw new Error(
          `OpenCode returned no text for fleet member ${input.member.id}.`,
        );
      return {
        memberID: input.member.id,
        sessionID,
        model: input.member.model,
        text,
      };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      active.delete(sessionID);
      if (active.size === 0) this.active.delete(input.parentSessionID);
    }
  }

  async cancel(parentSessionID: string) {
    await Promise.all(
      [...(this.active.get(parentSessionID) ?? [])].map((sessionID) =>
        this.client.session.abort({ sessionID }).catch(() => undefined),
      ),
    );
  }

  async close() {
    await Promise.all(
      [...this.active.keys()].map((parentSessionID) =>
        this.cancel(parentSessionID),
      ),
    );
    this.sessions.clear();
  }

  private async createSession(input: RunAgentInput) {
    const response = await this.client.session.create({
      parentID: input.parentSessionID,
      title: `Fleet: ${input.member.id} (${input.member.model.providerID}/${input.member.model.modelID})`,
    });
    if (response.error)
      throw new Error(
        `OpenCode child session failed: ${describe(response.error)}`,
      );
    if (!response.data?.id)
      throw new Error("OpenCode child session response had no id.");
    this.sessions.set(sessionKey(input), response.data.id);
    return response.data.id;
  }
}

export async function discoverFleet(client: OpenCodeClient): Promise<Fleet> {
  if (!client.provider) return { leadID: "lead", members: [] };
  const response = await client.provider.list();
  if (response.error || !response.data) return { leadID: "lead", members: [] };
  const connected = new Set(
    response.data.connected ?? response.data.all.map((provider) => provider.id),
  );
  const used = new Set<string>();
  const members = response.data.all
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) => {
      const modelID =
        response.data?.default?.[provider.id] ??
        Object.keys(provider.models)[0];
      if (!modelID) return [];
      const base = provider.id.replace(/[^a-zA-Z0-9_-]/g, "-") || "model";
      let id = base;
      let suffix = 2;
      while (used.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(id);
      return [
        {
          id,
          role: "specialist",
          model: { providerID: provider.id, modelID },
          agent: "plan",
          enabled: true,
        } satisfies FleetMember,
      ];
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
  ].join("\u0000");
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
