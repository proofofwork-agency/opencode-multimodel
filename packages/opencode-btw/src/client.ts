import type { OpencodeClient } from "@opencode-ai/sdk";

type ClientResponse<Data> = {
  data?: Data;
  error?: unknown;
};

function respond<Data>(
  promise: Promise<unknown>,
): Promise<ClientResponse<Data>> {
  return promise as unknown as Promise<ClientResponse<Data>>;
}

export type ModelRef = {
  providerID: string;
  modelID: string;
};

export type BtwClient = {
  session: {
    create(input: {
      parentID?: string;
      title?: string;
    }): Promise<ClientResponse<{ id: string }>>;
    messages(input: {
      sessionID: string;
      limit?: number;
    }): Promise<ClientResponse<unknown>>;
    prompt(input: {
      sessionID: string;
      model?: ModelRef;
      agent?: string;
      system?: string;
      tools?: Record<string, boolean>;
      parts: Array<{ type: "text"; text: string }>;
    }): Promise<ClientResponse<{ info?: { error?: unknown }; parts: unknown[] }>>;
    abort(input: { sessionID: string }): Promise<ClientResponse<boolean>>;
    delete(input: { sessionID: string }): Promise<ClientResponse<unknown>>;
  };
};

/**
 * Accepts a v2 OpenCode SDK client (flat parameters) or a test double.
 */
export function asBtwClient(client: unknown): BtwClient {
  return client as BtwClient;
}

/**
 * Adapts the v1 SDK client handed to server plugins (path/body parameters)
 * to the flat internal client shape.
 */
export function adaptPluginClient(client: OpencodeClient): BtwClient {
  return {
    session: {
      async create(input) {
        return respond<{ id: string }>(client.session.create({
          body: {
            parentID: input.parentID,
            title: input.title,
          },
        }));
      },
      async messages(input) {
        return respond<unknown>(client.session.messages({
          path: { id: input.sessionID },
          query: input.limit === undefined ? {} : { limit: input.limit },
        }));
      },
      async prompt(input) {
        return respond<{ info?: { error?: unknown }; parts: unknown[] }>(
          client.session.prompt({
            path: { id: input.sessionID },
            body: {
              model: input.model,
              agent: input.agent,
              system: input.system,
              tools: input.tools,
              parts: input.parts,
            },
          }),
        );
      },
      async abort(input) {
        return respond<boolean>(
          client.session.abort({ path: { id: input.sessionID } }),
        );
      },
      async delete(input) {
        return respond<unknown>(
          client.session.delete({ path: { id: input.sessionID } }),
        );
      },
    },
  };
}
