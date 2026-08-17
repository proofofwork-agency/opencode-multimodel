const BTW_SLASH = /^\/(?:btw|side)(?:\s+([\s\S]*))?$/i;

export function btwSlashQuestion(text: string): string | undefined {
  const match = text.trim().match(BTW_SLASH);
  if (!match) return;
  return match[1]?.trim() ?? "";
}
