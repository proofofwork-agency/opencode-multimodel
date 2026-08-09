import { writeSync } from "node:fs";

/**
 * Stands in for a Codex app-server that packs many frames into one stdout chunk, so the transport
 * has to bound individual frames rather than the chunk it read them from.
 *
 * `writeSync(1, ...)` rather than `process.stdout.write` for the same reason as the malformed
 * fixture: Bun's `process.stdout` is buffered, a written frame is not a sent frame, and on Windows CI
 * the handshake reply arrived while every later reply did not. The batching under test is the single
 * `writeSync` below — deliberate, not an artifact of a buffer flushing when it feels like it.
 *
 * Received frames are echoed to stderr, which `JsonRpcTransport.inspect()` captures.
 */
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const chunk = await reader.read();
  if (chunk.done) break;
  buffer += decoder.decode(chunk.value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  lines.filter(Boolean).forEach((line) => {
    writeSync(2, `fixture received: ${line}\n`);
    const request = JSON.parse(line) as { id?: number; method?: string };
    if (request.method === "initialize") {
      const notifications = Array.from({ length: 20 }, (_, index) => ({
        method: "tick",
        params: { index },
      }));
      writeSync(
        1,
        `${[...notifications, { id: request.id, result: {} }].map((value) => JSON.stringify(value)).join("\n")}\n`,
      );
      return;
    }
    if (request.id !== undefined)
      writeSync(1, `${JSON.stringify({ id: request.id, result: {} })}\n`);
  });
}
