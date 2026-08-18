const BTW_SLASH = /^\/(?:btw|side)(?:\s+([\s\S]*))?$/i;

export function btwSlashQuestion(text: string): string | undefined {
  const match = text.trim().match(BTW_SLASH);
  if (!match) return;
  return match[1]?.trim() ?? "";
}

export type BtwRequest = {
  question: string;
  send: boolean;
};

/**
 * Parses btw arguments `[--send] <question>` (the part after /btw).
 * `--send` merges the side answer back into the parent session as a user
 * message after it arrives.
 */
export function parseBtwRequest(raw: string): BtwRequest | undefined {
  const args = raw.trim();
  const send = /(?:^|\s)--send(?:\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)--send(?:\s|$)/g, " ").trim();
  return { question, send };
}
