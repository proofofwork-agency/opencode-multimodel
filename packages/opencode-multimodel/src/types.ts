export const COLLAB_MODES = [
  "lead",
  "pair",
  "round",
  "council",
  "orchestrate",
  "handoff",
  "panel",
  "deliberate",
  "jury",
] as const;

export type CollabMode = (typeof COLLAB_MODES)[number];
export type ComposerMode = "single" | "team" | "workflow";
export type MemberIsolation = "shared" | "worktree";

export type ModelRef = {
  providerID: string;
  modelID: string;
};

export type FleetMember = {
  id: string;
  role: string;
  model: ModelRef;
  agent?: string;
  system?: string;
  enabled: boolean;
  isolation?: MemberIsolation;
};

export type Fleet = {
  leadID: string;
  members: FleetMember[];
};

export type AgentReply = {
  memberID: string;
  sessionID: string;
  model: ModelRef;
  text: string;
  error?: string;
};

export type CollabActivityPhase =
  | "queued"
  | "waiting"
  | "thinking"
  | "synthesizing"
  | "done"
  | "error"
  | "idle";

export type CollabActivity = {
  memberID: string;
  phase: CollabActivityPhase;
  detail: string;
  waitingOn?: string;
  model: ModelRef;
};

export type PanelVoteChoice =
  | "approve"
  | "reject"
  | "abstain"
  | "conditional"
  | "unknown";
export type PanelConfidence = "high" | "medium" | "low" | "unknown";

export type PanelVote = {
  memberID: string;
  model: ModelRef;
  raw: string;
  position: string;
  vote: PanelVoteChoice;
  confidence: PanelConfidence;
  rationale: string;
  risks: string;
  alternative: string;
};

export type JuryVerdict = {
  question: string;
  judgeID: string;
  jurors: string[];
  votes: PanelVote[];
  majority: PanelVoteChoice | "split" | "none";
  decision: string;
  rounds: 1 | 2;
  multiModel: boolean;
  budget: { total: number; spent: number; remaining: number };
};

export type CollaborationResult = {
  mode: CollabMode;
  leadID: string;
  participants: string[];
  replies: AgentReply[];
  final: AgentReply;
  log: string[];
  jury?: JuryVerdict;
};

export type CollaborateOptions = {
  mode?: CollabMode;
  participants?: string[];
  maxWorkers?: number;
  maxParallel?: number;
  agentBudget?: number;
  handoffTo?: string;
  juryRounds?: 1 | 2;
  signal?: AbortSignal;
  runID?: string;
  onActivity?: (event: CollabActivity) => void;
};

export type RunAgentInput = {
  parentSessionID: string;
  member: FleetMember;
  prompt: string;
  system?: string;
  signal?: AbortSignal;
  runID?: string;
  stepID?: string;
  callIndex?: number;
};

export interface AgentRunner {
  run(input: RunAgentInput): Promise<AgentReply>;
  cancel?(parentSessionID: string, runID?: string): Promise<void>;
  steer?(parentSessionID: string, prompt: string, runID?: string): Promise<void>;
  cleanupWorkspaces?(runID?: string): Promise<number>;
  close?(): Promise<void>;
}

export type WorkflowStep = {
  id: string;
  prompt: string;
  needs?: string[];
  memberID?: string;
  model?: ModelRef;
  agent?: string;
  continueOnError?: boolean;
};

export type DagWorkflowDefinition = {
  kind?: "dag";
  name: string;
  description?: string;
  maxParallel?: number;
  synthesize?: boolean;
  steps: WorkflowStep[];
};

export type ScriptWorkflowDefinition = {
  kind: "script";
  name: string;
  description?: string;
  source: string;
  sourceHash?: string;
};

export type WorkflowDefinition =
  | DagWorkflowDefinition
  | ScriptWorkflowDefinition;

export type WorkflowStepRun = {
  id: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  memberID: string;
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
};

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped"
  | "interrupted";

export type WorkflowRun = {
  id: string;
  kind: "workflow";
  definition: string;
  workflowKind: "dag" | "script";
  sessionID: string;
  messageID?: string;
  input: string;
  status: RunStatus;
  steps: WorkflowStepRun[];
  final?: string;
  error?: string;
  background?: boolean;
  sourceHash?: string;
  createdAt: number;
  updatedAt: number;
};

export type CollaborationRun = {
  id: string;
  kind: "collaboration";
  definition: string;
  sessionID: string;
  messageID?: string;
  input: string;
  status: RunStatus;
  mode: CollabMode;
  participants: string[];
  steps: WorkflowStepRun[];
  final?: string;
  error?: string;
  background?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type DurableRun = WorkflowRun | CollaborationRun;

export type WorkflowRunOptions = {
  signal?: AbortSignal;
  run?: WorkflowRun;
  runID?: string;
  messageID?: string;
  background?: boolean;
  maxAgentCalls?: number;
  maxParallel?: number;
  timeoutMs?: number;
  beforeStep?: (run: WorkflowRun) => void | Promise<void>;
  onUpdate?: (run: WorkflowRun) => void | Promise<void>;
};

export type LedgerEvent = {
  id: number;
  runID?: string;
  type: string;
  data: unknown;
  createdAt: number;
};

export type WorkspaceRecord = {
  id: string;
  runID?: string;
  memberID: string;
  directory?: string;
  status: "active" | "preserved" | "removed" | "failed";
  createdAt: number;
  updatedAt: number;
};

export type PersistedState = {
  version: 2;
  fleet: Fleet;
  workflows: WorkflowDefinition[];
  runs: DurableRun[];
  events: LedgerEvent[];
  workspaces: WorkspaceRecord[];
};

export function isDagWorkflow(
  definition: WorkflowDefinition,
): definition is DagWorkflowDefinition {
  return definition.kind !== "script";
}

export function isWorkflowRun(run: DurableRun): run is WorkflowRun {
  return run.kind === "workflow";
}
