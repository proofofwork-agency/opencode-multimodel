import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachmentStore, type StoredAttachment } from "../src/store.ts";
import { redactText, redactValue } from "../src/redaction.ts";

describe("bounded delegate persistence", () => {
  test("redacts credentials and recovers from malformed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-delegator-store-"));
    const store = new AttachmentStore(root);
    const attachment: StoredAttachment = {
      id: "one",
      seatId: "codex",
      transport: "app-server",
      sourceCwd: root,
      cwd: root,
      worktree: null,
      isolation: "current",
      approvalPolicy: "ask",
      mode: "read-only",
      model: null,
      threadId: "thread-1",
      delivery: "completed",
      lastTurn: null,
      createdAt: 1,
      updatedAt: 2,
    };
    await store.put(attachment);
    expect(await store.getSeat("codex")).toEqual(attachment);
    expect(redactText("Bearer abc.def sk-1234567890123456")).toBe(
      "Bearer [REDACTED] [REDACTED]",
    );
    expect(
      redactValue({ accessToken: "token", nested: { password: "secret" } }),
    ).toEqual({
      accessToken: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });
    await Bun.write(join(root, "attachments.json"), "not-json");
    expect(await store.list()).toEqual([]);
  });

  test("ignores malformed attachment records while preserving valid recovery data", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "codex-delegator-invalid-store-"),
    );
    const store = new AttachmentStore(root);
    const valid: StoredAttachment = {
      id: "valid",
      seatId: "codex",
      transport: "app-server",
      sourceCwd: root,
      cwd: root,
      worktree: null,
      isolation: "current",
      approvalPolicy: "ask",
      mode: "read-only",
      model: null,
      threadId: "thread-valid",
      delivery: "completed",
      lastTurn: null,
      createdAt: 1,
      updatedAt: 2,
    };
    await Bun.write(
      join(root, "attachments.json"),
      JSON.stringify({
        version: 1,
        attachments: [{ id: "bad", seatId: 4 }, valid],
      }),
    );
    expect(await store.list()).toEqual([valid]);
  });

  test("serializes concurrent seat attachments without losing either seat", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "codex-delegator-concurrent-store-"),
    );
    const first = new AttachmentStore(root);
    const second = new AttachmentStore(root);
    const attachment = (id: string): StoredAttachment => ({
      id,
      seatId: id,
      transport: "app-server",
      sourceCwd: root,
      cwd: root,
      worktree: null,
      isolation: "current",
      approvalPolicy: "ask",
      mode: "read-only",
      model: null,
      threadId: `thread-${id}`,
      delivery: "completed",
      lastTurn: null,
      createdAt: 1,
      updatedAt: 2,
    });
    await Promise.all([
      first.put(attachment("one")),
      second.put(attachment("two")),
    ]);
    expect((await first.list()).map((item) => item.id).sort()).toEqual([
      "one",
      "two",
    ]);
  });
});
