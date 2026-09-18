// Shared types for the DSH plugin SDK.
// All types are AI-friendly: stable JSON shapes, no Date / Map / class hidden state.

// 这三个是 type-only 引用：编译后被完全擦除，所以不会和 role-spec / verifier /
// mast 形成运行时的循环依赖（它们反过来 importing types.ts）。
import type { RoleSpec, RoleViolation } from "./role-spec.js";
import type { VerifyReport, VerifyRule } from "./verifier.js";
import type { FailureAttribution } from "./mast.js";
import type { RepairOutcome, RepairPolicyInput } from "./repair.js";

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
  /** 角色契约审计 / 独立验证 / token 预算 / 失败归因。 */
  audit?: DshTaskAudit;
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
  /**
   * 角色契约：内置部门名（planner / worker / reviewer / synthesizer）或一份
   * 完整 spec。会被编译成 XML 契约注入 prompt，并在任务结束后做合规审计。
   * 未知部门名视为错误而不是回退到默认角色。
   */
  role?: string | RoleSpec;
  /**
   * 任务结束后由**框架**独立执行的校验规则。
   * 模型自评不可靠，这一层是 MAST 里 ~23% 验证类失败的主要防线。
   */
  verify?: VerifyRule[];
  /**
   * 思考 token 预算（Tran & Kiela, arXiv:2604.02460）。超过只是记录到
   * result.budget.exceeded，不自动阻断——因为多花的钱有时是值得的，
   * 但你必须能看见它。
   */
  thinkingTokenBudget?: number;
  /** 工作量档位。上层据此决定并行度，避免简单问题开出几十个子 agent。 */
  effort?: "low" | "medium" | "high";
  /**
   * 自纠错策略：验收不过时带证据重来一轮，而不是直接失败。
   *
   * 简写：`true` = 最多 2 次追加尝试、只修契约违约与验证失败；
   * 数字 = 追加尝试次数；对象 = 完整策略。默认关闭。
   *
   * 注意：自纠错生效的前提是**有客观判据**（role 或 verify 至少配一项）。
   * 两者都没配时写了这个字段也不会重试 —— 没有证据的重试只是把成本乘以 N。
   */
  selfRepair?: RepairPolicyInput;
}

/** 任务执行后的审计附加信息。全部可选，不写不代表通过，只代表没装设检测。 */
export interface DshTaskAudit {
  role?: {
    name: string;
    ok: boolean;
    violations: RoleViolation[];
    toolCalls: number;
    parsedOutput?: unknown;
    /** schema 里存在但校验器不支持的约束（这些规则实际没生效）。 */
    unsupportedSchemaKeys?: string[];
  };
  verification?: VerifyReport;
  budget?: {
    thinkingTokens: number;
    budget?: number;
    exceeded: boolean;
  };
  /** MAST 归因。仅在检出失败信号时出现；成功运行不生成。 */
  attribution?: FailureAttribution;
  /** 自纠错过程。仅当任务开启了 selfRepair 且至少有一轮失败时出现。 */
  repair?: RepairOutcome;
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
  /**
   * 一次 DAG 最多允许多少个并行节点。这是 effort scaling 的硬闸门：
   * 不明确设上限，模型会倾向于无限拆分。
   */
  maxParallelSubtasks?: number;
  /** 每个 effort 档位允许的实例数，用于 recommendFanout()。 */
  effortPolicy?: { low?: number; medium?: number; high?: number };
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
  /**
   * 失败归因聚合（MAST）。回答「这批任务在哪一类失败上最吃亏」。
   * 仅在已有失败记录时出现。
   */
  attribution?: {
    totalTraces: number;
    failedTraces: number;
    failureRate: number;
    byCategory: Array<{ category: string; count: number; share: number }>;
    top: Array<{ code: string; labelZh: string; count: number; fix: string }>;
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
  /** 节点级角色契约：内置部门名或完整 spec。 */
  role?: string | RoleSpec;
  /** 节点级独立验证规则。 */
  verify?: VerifyRule[];
  effort?: "low" | "medium" | "high";
  /** 节点级自纠错策略。同一个 DAG 里，能自愈的节点和必须一次做对的节点往往不同。 */
  selfRepair?: RepairPolicyInput;
}

export interface DagSpec {
  nodes: DagNodeSpec[];
  concurrency?: number;
  abortOnFailure?: boolean;
  maxDependencyChars?: number;
  defaults?: Partial<DshTask>;
  /**
   * 节点数上限。Anthropic 在生产里踩过的坑：不写明 effort 规则，模型会为一个
   * 简单问题开出几十个子 agent。超限时直接拒绝执行，而不是替它跑完。
   */
  maxNodes?: number;
  /** 并行度上限，独立于 concurrency（concurrency 可能来自调用方的默认值）。 */
  maxParallel?: number;
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
