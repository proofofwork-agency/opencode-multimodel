export type DelegateTransportKind = "app-server" | "exec";
export type DelegateIsolation = "worktree" | "current";
export type DelegateApprovalPolicy = "ask" | "auto" | "bypass";
export type DelegateMode = "read-only" | "write";
export type DelegateApprovalReply = "once" | "always" | "reject" | "cancel";

export type DelegateCapabilities = {
  resume: boolean;
  steering: boolean;
  review: boolean;
  approvals: boolean;
  structuredEvents: boolean;
  persistentTransport: boolean;
  writes: boolean;
  cancellation: boolean;
};

export type DelegateAccount = {
  authenticated: boolean;
  authMethod: "chatgpt" | "apiKey" | "custom" | null;
  planType: string | null;
  email: string | null;
  requiresOpenaiAuth: boolean | null;
};

export type DelegateModel = {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: string[];
  inputModalities: string[];
};

export type DelegateProbe = {
  ready: boolean;
  executable: string;
  version: string | null;
  transport: DelegateTransportKind | null;
  capabilities: DelegateCapabilities;
  account: DelegateAccount;
  models: DelegateModel[];
  reason: string | null;
  evidence: string[];
};

export type DelegateLogin = {
  type: "chatgpt" | "chatgptDeviceCode";
  loginId: string;
  authUrl: string;
  userCode: string | null;
};

export type DelegateConnection = DelegateProbe & {
  login: DelegateLogin | null;
};

export type DelegateHandle = {
  id: string;
  seatId: string;
  transport: DelegateTransportKind;
};

export type DelegateUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type DelegateEventKind =
  | "thread"
  | "turn"
  | "text"
  | "reasoning"
  | "tool"
  | "file"
  | "usage"
  | "rate-limit"
  | "approval"
  | "completion"
  | "error"
  | "diagnostic";

export type DelegateEvent = {
  sequence: number;
  kind: DelegateEventKind;
  method: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  text: string | null;
  usage: DelegateUsage | null;
  raw?: Record<string, unknown>;
};

export type DelegateApprovalRequest = {
  id: string | number;
  method: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  permission: "command" | "file" | "permissions";
  patterns: string[];
  reason: string | null;
  metadata: Record<string, unknown>;
};

export type DelegateTurnResult = {
  id: string;
  status: "completed" | "failed" | "cancelled" | "rate-limited" | "ambiguous";
  output: string;
  events: DelegateEvent[];
  usage: DelegateUsage;
  threadId: string | null;
  turnId: string | null;
  startedAt: number;
  completedAt: number;
  malformedEvents: number;
  truncated: boolean;
  error: { code: string; message: string; retryable: boolean } | null;
};

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string | null }
  | { type: "custom"; instructions: string };

export type DelegateInspection = {
  handle: DelegateHandle;
  status:
    | "idle"
    | "running"
    | "awaiting-approval"
    | "failed"
    | "ambiguous"
    | "closed";
  cwd: string;
  sourceCwd: string;
  worktree: string | null;
  isolation: DelegateIsolation;
  approvalPolicy: DelegateApprovalPolicy;
  mode: DelegateMode;
  model: string | null;
  threadId: string | null;
  activeTurnId: string | null;
  capabilities: DelegateCapabilities;
  lastTurn: DelegateTurnResult | null;
  createdAt: number;
  updatedAt: number;
};

export type ConnectInput = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  loginIfNeeded?: boolean;
  deviceCode?: boolean;
};

export type CreateInput = {
  /** Optional host-session key used to isolate persisted seats across callers. */
  sessionID?: string | null;
  seatId?: string;
  cwd: string;
  mode?: DelegateMode;
  isolation?: DelegateIsolation;
  approvalPolicy?: DelegateApprovalPolicy;
  model?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  confirmedUnsafe?: boolean;
  approval?: (
    request: DelegateApprovalRequest,
  ) => Promise<DelegateApprovalReply>;
  onEvent?: (event: DelegateEvent) => void;
};

export type ResumeInput = CreateInput & {
  id?: string;
  threadId?: string;
};

export type TurnInput = {
  prompt: string;
  timeoutMs?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
  onEvent?: (event: DelegateEvent) => void;
};

export type SteerInput = {
  prompt: string;
  expectedTurnId?: string;
  timeoutMs?: number;
};

export type ReviewInput = {
  target?: ReviewTarget;
  delivery?: "inline" | "detached";
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: DelegateEvent) => void;
};

export interface Delegator {
  probe(input?: ConnectInput): Promise<DelegateProbe>;
  connect(input?: ConnectInput): Promise<DelegateConnection>;
  create(input: CreateInput): Promise<DelegateHandle>;
  turn(
    session: DelegateHandle | string,
    input: TurnInput | string,
  ): Promise<DelegateTurnResult>;
  resume(input: ResumeInput): Promise<DelegateHandle>;
  steer(
    session: DelegateHandle | string,
    input: SteerInput | string,
  ): Promise<{ turnId: string }>;
  review(
    session: DelegateHandle | string,
    input?: ReviewInput,
  ): Promise<DelegateTurnResult>;
  cancel(session: DelegateHandle | string): Promise<DelegateInspection>;
  inspect(session: DelegateHandle | string): Promise<DelegateInspection>;
  close(session: DelegateHandle | string): Promise<void>;
  closeAll(): Promise<number>;
}
