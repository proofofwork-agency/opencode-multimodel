export type WorkflowArgumentType = "string" | "number" | "boolean";

export type WorkflowArgument = {
  type?: WorkflowArgumentType;
  default?: unknown;
  description?: string;
};

export type WorkflowArguments = Record<string, WorkflowArgument>;

export type WorkflowPhase =
  | string
  | { title: string; detail?: string; model?: string };

export type WorkflowStepRole = "explore" | "implement" | "review";

export type WorkflowAgentInput = {
  prompt: string;
  member?: string;
  agent?: string;
  model?: string;
  role?: WorkflowStepRole;
  tools?: Record<string, boolean>;
  files?: string[];
  isolation?: "worktree";
  onError?: "fail" | "null";
  label?: string;
  phase?: string;
};

export type WorkflowAgentResult = {
  text: string;
  data: unknown;
};

export type WorkflowToolResult = {
  output: string;
  metadata?: Record<string, unknown>;
};

export type WorkflowParallelOptions = { concurrencyLimit?: number };
export type WorkflowPipelineOptions = { concurrencyLimit?: number };

export type WorkflowContext = {
  setPhase(phase: string): void;
  log(message: string): void;
  agent(input: WorkflowAgentInput): Promise<WorkflowAgentResult | null>;
  parallel<T>(
    tasks: readonly (() => Promise<T>)[],
    options?: WorkflowParallelOptions,
  ): Promise<(T | null)[]>;
  pipeline<I, A>(
    items: readonly I[],
    stage: (prev: I, item: I, index: number) => Promise<A>,
    options?: WorkflowPipelineOptions,
  ): Promise<(A | null)[]>;
  pipeline<I, A, B>(
    items: readonly I[],
    first: (prev: I, item: I, index: number) => Promise<A>,
    second: (prev: A, item: I, index: number) => Promise<B>,
    options?: WorkflowPipelineOptions,
  ): Promise<(B | null)[]>;
  shell(
    command: string,
    opts?: { timeout?: number; cwd?: string },
  ): Promise<{ output: string; exitCode: number }>;
};

export type WorkflowDefinition<
  Args extends WorkflowArguments | undefined = WorkflowArguments | undefined,
> = {
  meta: {
    name: string;
    description?: string;
    whenToUse?: string;
    phases?: readonly WorkflowPhase[];
    arguments?: Args;
  };
  run(
    args: Record<string, unknown>,
    ctx: WorkflowContext,
  ): Promise<unknown>;
};

export function workflow<
  const Args extends WorkflowArguments | undefined = undefined,
>(input: {
  name: string;
  description?: string;
  whenToUse?: string;
  phases?: readonly WorkflowPhase[];
  arguments?: Args;
  run(
    args: Record<string, unknown>,
    ctx: WorkflowContext,
  ): Promise<unknown>;
}): WorkflowDefinition<Args> {
  return {
    meta: {
      name: input.name,
      description: input.description,
      whenToUse: input.whenToUse,
      phases: input.phases,
      arguments: input.arguments,
    },
    run: input.run,
  };
}
