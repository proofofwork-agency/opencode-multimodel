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
  onActivity?: (event: CollabActivity) => void;
};

export type RunAgentInput = {
  parentSessionID: string;
  member: FleetMember;
  prompt: string;
  system?: string;
  signal?: AbortSignal;
};

export interface AgentRunner {
  run(input: RunAgentInput): Promise<AgentReply>;
  cancel?(parentSessionID: string): Promise<void>;
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

export type WorkflowDefinition = {
  name: string;
  description?: string;
  maxParallel?: number;
  synthesize?: boolean;
  steps: WorkflowStep[];
};

export type WorkflowStepRun = {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  memberID: string;
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
};

export type WorkflowRun = {
  id: string;
  definition: string;
  sessionID: string;
  input: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  steps: WorkflowStepRun[];
  final?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowRunOptions = {
  signal?: AbortSignal;
  onUpdate?: (run: WorkflowRun) => void | Promise<void>;
};

export type PersistedState = {
  version: 1;
  fleet: Fleet;
  workflows: WorkflowDefinition[];
  runs: WorkflowRun[];
};
