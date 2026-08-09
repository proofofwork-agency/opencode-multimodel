import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactValue } from "./redaction.ts";
import type {
  DelegateApprovalPolicy,
  DelegateIsolation,
  DelegateMode,
  DelegateTransportKind,
  DelegateTurnResult,
} from "./types.ts";

export type StoredAttachment = {
  id: string;
  seatId: string;
  /**
   * Owning host session. Absent on records written before seats were session-scoped;
   * those stay resumable so an upgrade never orphans a live Codex thread.
   */
  sessionID?: string | null;
  transport: DelegateTransportKind;
  sourceCwd: string;
  cwd: string;
  worktree: string | null;
  isolation: DelegateIsolation;
  approvalPolicy: DelegateApprovalPolicy;
  mode: DelegateMode;
  model: string | null;
  threadId: string | null;
  delivery: "none" | "accepted" | "completed" | "ambiguous";
  lastTurn: DelegateTurnResult | null;
  createdAt: number;
  updatedAt: number;
};

type AttachmentFile = {
  version: 1;
  attachments: StoredAttachment[];
};

const writes = new Map<string, Promise<void>>();

export class AttachmentStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "attachments.json");
  }

  async get(id: string) {
    return (
      (await this.list()).find((attachment) => attachment.id === id) ?? null
    );
  }

  /**
   * Newest attachment for a seat inside one session. A seat is only a seat *within* a
   * session — without the session dimension a single stored thread was handed to every
   * host session at once, so they collided on one delegate runtime. Records written
   * before the session dimension existed carry no `sessionID` and are adopted as a
   * fallback rather than orphaned.
   */
  async getSeat(seatId: string, sessionID?: string | null) {
    const seated = (await this.list())
      .filter((attachment) => attachment.seatId === seatId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (sessionID === undefined) return seated[0] ?? null;
    const owned = seated.find(
      (attachment) => (attachment.sessionID ?? null) === (sessionID ?? null),
    );
    return (
      owned ??
      seated.find((attachment) => attachment.sessionID === undefined) ??
      null
    );
  }

  async list(): Promise<StoredAttachment[]> {
    const file = Bun.file(this.file);
    if (!(await file.exists())) return [];
    if (file.size > 1_000_000) return [];
    const parsed = await file.json().catch(() => null);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as AttachmentFile).attachments)
    )
      return [];
    return (parsed as AttachmentFile).attachments
      .slice(-128)
      .map(storedAttachment)
      .filter((attachment): attachment is StoredAttachment =>
        Boolean(attachment),
      );
  }

  async put(attachment: StoredAttachment) {
    const write = (writes.get(this.file) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const current = await this.list();
        const next = [
          ...current.filter((item) => item.id !== attachment.id),
          attachment,
        ]
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(-128);
        await this.write({ version: 1, attachments: next });
      });
    writes.set(this.file, write);
    await write.finally(() => {
      if (writes.get(this.file) === write) writes.delete(this.file);
    });
  }

  private async write(value: AttachmentFile) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const body = JSON.stringify(redactValue(value), null, 2);
    const bounded =
      Buffer.byteLength(body) <= 1_000_000
        ? body
        : JSON.stringify(
            {
              version: 1,
              attachments: value.attachments
                .slice(-16)
                .map((item) => ({ ...item, lastTurn: null })),
            },
            null,
            2,
          );
    await Bun.write(temp, `${bounded}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }
}

function storedAttachment(value: unknown): StoredAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attachment = value as Record<string, unknown>;
  if (
    typeof attachment.id !== "string" ||
    typeof attachment.seatId !== "string"
  )
    return null;
  if (
    attachment.sessionID !== undefined &&
    attachment.sessionID !== null &&
    typeof attachment.sessionID !== "string"
  )
    return null;
  if (attachment.transport !== "app-server" && attachment.transport !== "exec")
    return null;
  if (
    typeof attachment.sourceCwd !== "string" ||
    typeof attachment.cwd !== "string"
  )
    return null;
  if (attachment.worktree !== null && typeof attachment.worktree !== "string")
    return null;
  if (attachment.isolation !== "worktree" && attachment.isolation !== "current")
    return null;
  if (
    attachment.approvalPolicy !== "ask" &&
    attachment.approvalPolicy !== "auto" &&
    attachment.approvalPolicy !== "bypass"
  )
    return null;
  if (attachment.mode !== "read-only" && attachment.mode !== "write")
    return null;
  if (attachment.model !== null && typeof attachment.model !== "string")
    return null;
  if (attachment.threadId !== null && typeof attachment.threadId !== "string")
    return null;
  if (
    attachment.delivery !== "none" &&
    attachment.delivery !== "accepted" &&
    attachment.delivery !== "completed" &&
    attachment.delivery !== "ambiguous"
  )
    return null;
  if (
    attachment.lastTurn !== null &&
    (!attachment.lastTurn ||
      typeof attachment.lastTurn !== "object" ||
      Array.isArray(attachment.lastTurn))
  )
    return null;
  if (
    typeof attachment.createdAt !== "number" ||
    !Number.isFinite(attachment.createdAt)
  )
    return null;
  if (
    typeof attachment.updatedAt !== "number" ||
    !Number.isFinite(attachment.updatedAt)
  )
    return null;
  return attachment as StoredAttachment;
}
