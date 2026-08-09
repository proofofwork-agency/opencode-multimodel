import { writeSync } from "node:fs";

/**
 * Stands in for a Codex app-server that emits one unparseable frame before its handshake reply.
 *
 * Frames go out with `writeSync(1, ...)` rather than `process.stdout.write`. Bun's `process.stdout`
 * is buffered, so a written frame is not a sent frame — and on Windows CI this fixture's handshake
 * reply arrived while every later reply did not, hanging the request until its deadline. Something
 * standing in for a line-protocol server has to put the line on the wire when it writes it, and
 * `writeSync` is an unbuffered syscall.
 *
 * Each received frame is echoed to stderr, which `JsonRpcTransport.inspect()` captures, so if this
 * still fails the report says which frames this process actually saw rather than leaving it to be
 * guessed at.
 */
function send(message: unknown) {
  writeSync(1, `${JSON.stringify(message)}\n`);
}

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
      writeSync(1, "not-json\n");
      send({ id: request.id, result: {} });
      return;
    }
    if (request.id !== undefined) send({ id: request.id, result: {} });
  });
}
