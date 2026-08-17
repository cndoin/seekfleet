// Shared types for the DSH plugin SDK.
// All types are AI-friendly: stable JSON shapes, no Date / Map / class hidden state.

export type DshEventKind =
  "stdout" | "stderr" | "log" | "tool_call" | "tool_result" | "subagent" | "usage" | "answer" | "exit" | "error";

export interface DshEvent {
  kind: DshEventKind;
  ts: number;
  seq: number;
  data: unknown;
}

export interface DshToolInvocation {
  name: string;
  args: unknown;
}

export interface DshToolResult {
  name: string;
  ok: boolean;
  output: unknown;
  durationMs: number;
}

export interface DshUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  model?: string;
}

export interface DshResult {
  answer: string;
  usage?: DshUsage;
  toolCalls: DshToolInvocation[];
  toolResults: DshToolResult[];
  events: number;
  durationMs: number;
  exitCode: number | null;
  stderrTail: string;
  error?: { message: string; code?: string };
}

export interface DshTask {
  task: string;
  profile?: string;
  patches?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  tags?: string[];
  label?: string;
  /** P0-10: max total bytes before the process is killed. */
  maxOutputBytes?: number;
}

export interface DshInstanceSpec {
  label: string;
  profile?: string;
  tags?: string[];
  concurrency?: number;
  patches?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type DshRoutingStrategy = "round-robin" | "least-loaded" | "tag" | "random" | "adaptive";

export interface DshClusterSpec {
  profile?: string;
  instances: DshInstanceSpec[];
  routing?: DshRoutingStrategy;
  workspace?: string;
  dshHome?: string;
  healthIntervalMs?: number;
}

export type DshInstanceState = "starting" | "ready" | "busy" | "draining" | "down" | "stopped";

export interface DshInstanceStatus {
  label: string;
  profile: string;
  state: DshInstanceState;
  inFlight: number;
  concurrency: number;
  tags: string[];
  totalRun: number;
  totalErrors: number;
  lastError?: string;
  lastActivityTs: number;
  startedAt: number;
  pid?: number;
  breaker?: string;
  score?: number;
  cost?: {
    totalCostUsd: number;
    totalTokens: number;
    avgCostUsd: number;
    avgDurationMs: number;
  };
  drainingReason?: string;
  consecutiveFailures?: number;
}

export interface DshClusterStatus {
  routing: DshRoutingStrategy;
  workspace?: string;
  dshHome?: string;
  instances: DshInstanceStatus[];
  createdAt: number;
  cache?: {
    size: number;
    hits: number;
    misses: number;
    hitRatio: number;
    evictions: number;
  };
  cost?: {
    totalRuns: number;
    totalCostUsd: number;
    totalTokens: { input: number; output: number };
    instances: number;
    budgetUsd?: number;
    budgetSpent: number;
    budgetReserved: number;
  };
  workspaceSync?: {
    localChanges: number;
    remoteChanges: number;
    filesShared: number;
    bytesShared: number;
  };
}

export interface DagNodeSpec {
  id: string;
  task: string;
  dependsOn?: string[];
  profile?: string;
  tags?: string[];
  timeoutMs?: number;
  critical?: boolean;
  includeDependencyResults?: boolean;
}

export interface DagSpec {
  nodes: DagNodeSpec[];
  concurrency?: number;
  abortOnFailure?: boolean;
  maxDependencyChars?: number;
  defaults?: Partial<DshTask>;
}

export interface DshCapability {
  id: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DshInspection {
  dshHome: string;
  dshModuleRoot: string;
  version: string;
  runtime: {
    platform: NodeJS.Platform;
    arch: string;
    node: string;
  };
  profiles: Array<{ name: string; description?: string }>;
  builtinTools: string[];
  capabilities: DshCapability[];
}

export interface DshEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}
