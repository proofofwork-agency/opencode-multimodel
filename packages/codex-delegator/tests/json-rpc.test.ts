import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonRpcTransport } from "../src/json-rpc.ts";

// These spawn a Bun subprocess, and process startup on a Windows CI runner does not fit in the
// defaults: `request` allowed 1s and `JsonRpcTransport.open`'s handshake allows 5s. Both are
// raised here because these tests assert framing behaviour, not latency.
//
// Raising only those two was raising the wrong layer. Bun caps each test at 5s of its own, so the
// 30s handshake and 15s request budgets below could never be spent — on Windows both tests died at
// exactly 5001ms. The per-test timeout has to clear the sum of the budgets the body allows itself.
const SPAWN_BUDGET_MS = 60_000;

/**
 * Ask for `account/read`, and if it does not answer, say what the transport saw.
 *
 * A bare `.resolves.toEqual({})` reports "promise rejected" and nothing else, which is how a Windows
 * failure here twice came down to guesswork. `inspect()` carries the child's pid, whether it closed,
 * how many frames were pending, and the fixture's stderr — which now echoes every frame it received.
 * That distinguishes "the request never reached the fixture" from "the fixture replied and the reply
 * never came back", and those want opposite fixes.
 */
async function readAccount(transport: JsonRpcTransport) {
  try {
    return await transport.request("account/read", {}, { timeoutMs: 15_000 });
  } catch (error) {
    const detail = JSON.stringify(transport.inspect(), null, 2);
    throw new Error(
      `account/read failed: ${error instanceof Error ? error.message : String(error)}\n${detail}`,
    );
  }
}

test(
  "tolerates and records a malformed JSON-RPC frame",
  async () => {
    const transport = await JsonRpcTransport.open(
      {
        argv: [
          process.execPath,
          `${import.meta.dir}/fixtures/malformed-app-server.ts`,
        ],
        cwd: process.cwd(),
      },
      30_000,
    );
    expect(transport.inspect().malformedFrames).toBe(1);
    expect(await readAccount(transport)).toEqual({});
    await transport.close();
  },
  SPAWN_BUDGET_MS,
);

/**
 * Removing the flush breaks only Windows, and only in CI.
 *
 * `child.stdin` is a Bun FileSink, so a written frame is a buffered frame. Measured, not assumed: a
 * `write()` of 6 bytes followed by `flush()` returns 6 — the bytes were still in the sink until the
 * flush pushed them. On POSIX something drains it soon enough that nobody notices; on Windows it did
 * not, and every request after the handshake hung until its deadline.
 *
 * So the guard against a regression here is a Windows CI run, which is slow and whose connection to
 * this line is not obvious at the point someone would delete it. Asserted on source text for that
 * reason: the point is to make the requirement visible where the change would be made.
 */
test("flushes every frame, because writing one does not deliver it", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/json-rpc.ts", import.meta.url)),
    "utf8",
  );
  const write = source.slice(source.indexOf("private write(message: unknown)"));
  const body = write.slice(0, write.indexOf("\n  }"));
  expect(body).toContain("this.child.stdin.write(");
  expect(body).toContain("this.child.stdin.flush()");
});

test(
  "bounds individual JSON-RPC frames instead of the full stdout chunk",
  async () => {
    const transport = await JsonRpcTransport.open(
      {
        argv: [
          process.execPath,
          `${import.meta.dir}/fixtures/batched-app-server.ts`,
        ],
        cwd: process.cwd(),
        maxFrameBytes: 128,
      },
      30_000,
    );
    expect(await readAccount(transport)).toEqual({});
    await transport.close();
  },
  SPAWN_BUDGET_MS,
);
