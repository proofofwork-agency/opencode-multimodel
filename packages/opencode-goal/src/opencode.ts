export type SessionTokens = {
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
};

export type SessionTurn = {
  role?: string;
  agent?: string;
  tokens?: SessionTokens;
  parts: unknown[];
  error?: unknown;
};

export type SessionChild = {
  id: string;
  parentID?: string;
};

export type GoalClient = {
  prompt(input: {
    sessionID: string;
    text: string;
    noReply?: boolean;
    agent?: string;
    synthetic?: boolean;
  }): Promise<{
    text: string;
    hadTools: boolean;
    tokens: number;
    outputTokens?: number;
  }>;
  messages?(sessionID: string): Promise<SessionTurn[]>;
  session?(sessionID: string): Promise<{
    agent?: string;
    busy?: boolean;
    model?: { id: string; providerID: string; variant?: string };
  }>;
  children?(sessionID: string): Promise<SessionChild[]>;
  statuses?(
    sessionID: string,
  ): Promise<Record<string, { type?: string } | string>>;
  judge?(
    prompt: string,
    options?: { model?: { id: string; providerID: string; variant?: string } },
  ): Promise<string>;
  author?(
    prompt: string,
    options?: { model?: { id: string; providerID: string; variant?: string } },
  ): Promise<string>;
  abort?(sessionID: string): Promise<void>;
};

type ClientResponse<Data> = {
  data?: Data;
  error?: unknown;
};

type PluginSessionClient = {
  session: {
    prompt(input: unknown): Promise<ClientResponse<{
      info?: { error?: unknown; agent?: string; tokens?: SessionTokens };
      parts?: unknown[];
    }>>;
    messages?: (input: unknown) => Promise<ClientResponse<{
      messages?: SessionTurn[];
      data?: SessionTurn[];
    } | SessionTurn[]>>;
    get?: (input: unknown) => Promise<ClientResponse<{
      agent?: string;
      status?: { type?: string };
    }>>;
    children?: (input: unknown) => Promise<ClientResponse<SessionChild[]>>;
    status?: (
      input: unknown,
    ) => Promise<ClientResponse<Record<string, { type?: string } | string>>>;
    create?: (input: unknown) => Promise<ClientResponse<{ id: string }>>;
    abort?: (input: unknown) => Promise<unknown>;
  };
};

export function adaptGoalClient(
  client: unknown,
  transport: { baseUrl?: string; directory?: string } = {},
): GoalClient {
  const typed = client as PluginSessionClient;
  return {
    async prompt({ sessionID, text, noReply, agent, synthetic }) {
      const body: Record<string, unknown> = {
        noReply: noReply === true,
        parts: [{ type: "text", text, synthetic: synthetic === true }],
      };
      if (agent !== undefined) body.agent = agent;
      const response = await typed.session.prompt(
        legacyOrPath(sessionID, body),
      );
      if (response.error) {
        throw new Error(`OpenCode prompt failed: ${describe(response.error)}`);
      }
      if (response.data?.info?.error) {
        throw new Error(
          `OpenCode model failed: ${describe(response.data.info.error)}`,
        );
      }
      const parts = response.data?.parts ?? [];
      const infoTokens = response.data?.info?.tokens;
      return {
        text: textFromParts(parts),
        hadTools: partsHaveTools(parts),
        tokens: tokenTotal(infoTokens),
        outputTokens: typeof infoTokens?.output === "number"
          ? Math.max(0, infoTokens.output)
          : undefined,
      };
    },
    async messages(sessionID) {
      const read = bind(typed.session, "messages");
      if (!read) return [];
      const response = await read(pathOnly(sessionID));
      const data = response.data;
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.messages)) return data.messages;
      if (Array.isArray(data?.data)) return data.data;
      return [];
    },
    async session(sessionID) {
      const get = bind(typed.session, "get");
      if (!get) return {};
      const response = await get(pathOnly(sessionID));
      const data = (response.data ?? response) as {
        agent?: string;
        model?: { id: string; providerID: string; variant?: string };
        status?: { type?: string };
      };
      return {
        agent: data?.agent,
        busy: data?.status?.type === "busy",
        model: data?.model,
      };
    },
    async children(sessionID) {
      const read = bind(typed.session, "children");
      if (!read) return [];
      const response = await read(pathOnly(sessionID));
      return Array.isArray(response.data) ? response.data : [];
    },
    async statuses() {
      const read = bind(typed.session, "status");
      if (!read) return {};
      const response = await read({});
      return response.data && typeof response.data === "object"
        ? response.data
        : {};
    },
    async abort(sessionID) {
      const abort = bind(typed.session, "abort");
      if (!abort) return;
      await abort(pathOnly(sessionID));
    },
    async judge(prompt, options) {
      return runSideSession(typed, transport, prompt, options?.model, {
        title: "goal-judge",
        tools: { "*": false },
        label: "Judge",
      });
    },
    async author(prompt, options) {
      return runSideSession(typed, transport, prompt, options?.model, {
        title: "goal-contract",
        tools: { "*": false, read: true, glob: true, grep: true },
        label: "Contract author",
      });
    },
  };
}

async function runSideSession(
  typed: PluginSessionClient,
  transport: { baseUrl?: string; directory?: string },
  prompt: string,
  model: { id: string; providerID: string; variant?: string } | undefined,
  options: { title: string; tools: Record<string, boolean>; label: string },
) {
  if (transport.baseUrl) {
    return httpJudge({
      baseUrl: transport.baseUrl,
      directory: transport.directory,
      prompt,
      model,
      title: options.title,
      tools: options.tools,
      timeoutMs: 120_000,
    });
  }
  const sessionID = await createJudgeSession(typed, model, options.title);
  try {
    const parts = [{ type: "text", text: prompt }];
    const response = await typed.session.prompt({
      sessionID,
      path: { id: sessionID },
      body: { tools: options.tools, parts },
    });
    if (response.error) {
      throw new Error(`${options.label} prompt failed: ${describe(response.error)}`);
    }
    const text = textFromParts(promptParts(response));
    if (!text) throw new Error(`${options.label} prompt returned no text.`);
    return text;
  } finally {
    await typed.session.abort?.(pathOnly(sessionID)).catch(() => undefined);
  }
}

export function lastAssistantTurn(messages: SessionTurn[]) {
  return [...messages].reverse().find((message) =>
    message.role === "assistant" || message.parts.some(isToolPart)
  );
}

export function lastAssistantText(messages: SessionTurn[]) {
  return textFromParts(lastAssistantTurn(messages)?.parts ?? []);
}

export function turnHadTools(turn: SessionTurn | undefined) {
  return turn ? partsHaveTools(turn.parts) : false;
}

export function tokenTotal(tokens?: SessionTokens) {
  if (!tokens) return 0;
  if (typeof tokens.total === "number") return Math.max(0, tokens.total);
  return Math.max(
    0,
    (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0),
  );
}

export function parseModelRef(spec: string) {
  const parts = spec.split("/").map((item) => item.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  return {
    providerID: parts[0]!,
    id: parts[1]!,
    variant: parts[2],
  };
}

export function childrenAreBusy(
  children: SessionChild[],
  statuses: Record<string, { type?: string } | string>,
) {
  return children.some((child) => {
    const status = statuses[child.id];
    const type = typeof status === "string" ? status : status?.type;
    return type === "busy" || type === "retry";
  });
}

export function isGoalRuntimePrompt(text: string) {
  return text.includes("<untrusted_objective>") ||
    text.includes("<opencode_goal_receipt>") ||
    text.startsWith("PERSISTED THREAD GOAL") ||
    text.startsWith("Continue working toward the persisted thread goal.") ||
    text.startsWith("Continue working toward the active thread goal.") ||
    text.startsWith("A persisted thread goal is now active.") ||
    text.startsWith("The active thread goal has reached its token budget.") ||
    text.startsWith("The active thread goal has reached a safety limit.") ||
    text.startsWith("OpenCode goal mode policy:");
}

export function isAbortError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  return name === "MessageAbortedError" ||
    /abort|interrupt|cancel/i.test(message);
}

export type HttpJudgeFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export async function httpJudge(input: {
  baseUrl: string;
  directory?: string;
  prompt: string;
  model?: { id: string; providerID: string; variant?: string };
  fetch?: HttpJudgeFetch;
  title?: string;
  tools?: Record<string, boolean>;
  timeoutMs?: number;
}) {
  const request = input.fetch ?? ((url, init) => fetch(url, init));
  const root = input.baseUrl.replace(/\/$/, "");
  const query = input.directory
    ? `?directory=${encodeURIComponent(input.directory)}`
    : "";
  const signal = input.timeoutMs
    ? AbortSignal.timeout(input.timeoutMs)
    : undefined;
  const created = await fetchJson(request, `${root}/session${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: input.title ?? "goal-judge",
      model: input.model
        ? {
          id: input.model.id,
          providerID: input.model.providerID,
          variant: input.model.variant,
        }
        : undefined,
    }),
    signal,
  });
  const sessionID = createdSessionID(created);
  if (!sessionID) {
    throw new Error("Judge session create returned no id.");
  }
  try {
    const response = await fetchJson(
      request,
      `${root}/session/${sessionID}/message${query}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tools: input.tools ?? { "*": false },
          parts: [{ type: "text", text: input.prompt }],
        }),
        signal,
      },
    );
    const text = textFromParts(promptParts(response));
    if (!text) throw new Error("Judge prompt returned no text.");
    return text;
  } finally {
    await request(`${root}/session/${sessionID}/abort${query}`, {
      method: "POST",
      signal,
    }).catch(() => undefined);
  }
}

async function fetchJson(
  request: HttpJudgeFetch,
  url: string,
  init: RequestInit,
) {
  const response = await request(url, init);
  const body = await response.text();
  let parsed: unknown = undefined;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
  }
  if (!response.ok) {
    throw new Error(
      `Judge HTTP ${response.status} ${url}: ${
        describe(parsed ?? body.slice(0, 200))
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Judge HTTP ${url} returned no JSON.`);
  }
  return parsed;
}

async function createJudgeSession(
  client: PluginSessionClient,
  model?: { id: string; providerID: string; variant?: string },
  title = "goal-judge",
) {
  const create = bind(client.session, "create");
  if (!create) {
    throw new Error("OpenCode session.create is unavailable for the judge.");
  }
  const attempts = [
    { body: { title, model } },
    { title, model },
    { path: {}, body: { title, model } },
  ];
  let last = "Judge session could not be created.";
  for (const input of attempts) {
    try {
      const created = await create(input);
      const id = createdSessionID(created);
      if (id) return id;
      if (created.error) last = describe(created.error);
    } catch (error) {
      last = describe(error);
    }
  }
  throw new Error(last);
}

function bind<K extends keyof PluginSessionClient["session"]>(
  session: PluginSessionClient["session"],
  key: K,
) {
  const method = session[key];
  if (typeof method !== "function") return undefined;
  return (method as (...args: unknown[]) => unknown).bind(session) as NonNullable<
    PluginSessionClient["session"][K]
  >;
}

export function createdSessionID(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) return record.id;
  const nested = [record.data, record.info];
  if (record.data && typeof record.data === "object") {
    nested.push((record.data as { info?: unknown }).info);
  }
  for (const item of nested) {
    if (item && typeof item === "object") {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

function promptParts(response: unknown): unknown[] {
  if (!response || typeof response !== "object") return [];
  const record = response as Record<string, unknown>;
  if (Array.isArray(record.parts)) return record.parts;
  const data = record.data;
  if (data && typeof data === "object") {
    const parts = (data as { parts?: unknown }).parts;
    if (Array.isArray(parts)) return parts;
  }
  return [];
}

function pathOnly(sessionID: string) {
  return {
    sessionID,
    path: { id: sessionID },
  };
}

function legacyOrPath(sessionID: string, body: Record<string, unknown>) {
  return {
    sessionID,
    path: { id: sessionID },
    body,
    ...body,
  };
}

function textFromParts(parts: unknown[]) {
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function partsHaveTools(parts: unknown[]) {
  return parts.some(isToolPart);
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return !!part &&
    typeof part === "object" &&
    (part as { type?: string }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string";
}

function isToolPart(part: unknown) {
  if (!part || typeof part !== "object") return false;
  const type = (part as { type?: string }).type;
  return type === "tool" ||
    type === "tool-call" ||
    type === "tool-result" ||
    "tool" in part ||
    "toolName" in part;
}

function describe(value: unknown) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
