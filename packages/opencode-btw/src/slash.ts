const BTW_SLASH = /^\/(?:btw|side)(?:\s+([\s\S]*))?$/i;

export function btwSlashQuestion(text: string): string | undefined {
  const match = text.trim().match(BTW_SLASH);
  if (!match) return;
  return match[1]?.trim() ?? "";
}

export type BtwRequest = {
  question: string;
  send: boolean;
  thread: boolean;
  end: boolean;
};

/**
 * Parses btw arguments `[--send] [--thread|--end] <question>`.
 * `--send` merges the side answer back into the parent session as a user
 * message after it arrives. `--thread` keeps the child session alive for
 * multi-turn side conversations; `--end` closes and deletes it.
 */
export function parseBtwRequest(raw: string): BtwRequest | undefined {
  const args = raw.trim();
  const send = /(?:^|\s)--send(?:\s|$)/.test(args);
  const thread = /(?:^|\s)--thread(?:\s|$)/.test(args);
  const end = /(?:^|\s)--end(?:\s|$)/.test(args);
  const question = args
    .replace(/(?:^|\s)--send(?:\s|$)/g, " ")
    .replace(/(?:^|\s)--thread(?:\s|$)/g, " ")
    .replace(/(?:^|\s)--end(?:\s|$)/g, " ")
    .trim();
  return { question, send, thread, end };
}
