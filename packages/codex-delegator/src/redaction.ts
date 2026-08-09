const SENSITIVE_KEY =
  /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|credential|password|secret|cookie)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const OPENAI_KEY = /\b(?:sk|sess)-[A-Za-z0-9_-]{16,}\b/g;

export function redactText(value: string, maxBytes = 64_000) {
  const redacted = value
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(OPENAI_KEY, "[REDACTED]");
  if (Buffer.byteLength(redacted) <= maxBytes) return redacted;
  const bytes = Buffer.from(redacted);
  return `${bytes.subarray(0, Math.max(0, maxBytes - 16)).toString("utf8")}\n[TRUNCATED]`;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value))
    return value.slice(0, 512).map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 512)
      .map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item, depth + 1),
      ]),
  );
}
