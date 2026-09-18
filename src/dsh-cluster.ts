// DshCluster - multi-instance orchestrator composed of all the layers.
//
// Layers (all optional, configurable):
//   1. AdaptiveRouter    - scoring-based instance selection
//   2. CircuitBreaker    - per-instance failure isolation
//   3. ResultCache       - task-level result memoization
//   4. CostTracker       - per-instance token / cost accounting
//   5. AutoScaler        - queue-depth driven scaling
//   6. WorkspaceSync     - chokidar-based file sharing (optional)
//   7. CapabilityRegistry- instance self-report (shared via DSH_HOME)
//   8. MetricsRegistry   - Prometheus-friendly counters/gauges
//   9. DagExecutor       - topological task orchestration

import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { DshClient } from "./dsh-client.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { ResultCache } from "./result-cache.js";
import { CostTracker } from "./cost-tracker.js";
import { resolveDshModuleRoot, resolveDshVersion } from "./install.js";
import { AdaptiveRouter } from "./adaptive-router.js";
import { ROUTING_FNS } from "./routing.js";
import { AutoScaler } from "./auto-scaler.js";
import { WorkspaceSync } from "./workspace-sync.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { MetricsRegistry } from "./metrics.js";
import { PolicyEnforcer } from "./policy-enforcer.js";
import { DagExecutor } from "./task-dag.js";
import { ReplayRecorder } from "./replay-recorder.js";
import {
  DEPARTMENTS,
  attachRoleContract,
  auditRoleRun,
  getDepartment,
  validateRoleSpec,
  type RoleAudit,
  type RoleSpec,
} from "./role-spec.js";
import { verifyResult } from "./verifier.js";
import { aggregateFailures, classifyTrace, type FailureAttribution, type MastReport, type TraceView } from "./mast.js";
import type {
  DshClusterSpec,
  DshClusterStatus,
  DshEvent,
  DshInstanceSpec,
  DshInstanceStatus,
  DshInstanceState,
  DshResult,
  DshTask,
  DshTaskAudit,
  DagSpec,
} from "./types.js";

/**
 * 归因环形缓冲的上限。
 *
 * 为什么要限额：归因对象里带着 evidence 字符串，长任务集群跑上几千次之后
 * 这就是个慢性内存泄漏。200 条足够算出稳定的分布。
 */
const MAX_ATTRIBUTIONS = 200;

/**
 * effort 档位的默认并行度（Anthropic 在生产里踩过的坑：不写这条规则，
 * 模型会为一个简单问题开出几十个子 agent）。
 */
const DEFAULT_EFFORT_POLICY: Record<"low" | "medium" | "high", number> = { low: 1, medium: 3, high: 8 };

export interface DshClusterOptions extends DshClusterSpec {
  client?: ConstructorParameters<typeof DshClient>[0];
  /** enable result cache (default true if cacheDir provided) */
  enableCache?: boolean;
  cacheDir?: string;
  cacheTtlMs?: number;
  /** enable per-instance circuit breakers (default true) */
  enableBreaker?: boolean;
  breakerOptions?: ConstructorParameters<typeof CircuitBreaker>[1];
  /** enable auto-scaling for the primary profile (default false) */
  autoScaler?: Omit<ConstructorParameters<typeof AutoScaler>[0], "profile"> & { profile?: string };
  /** enable workspace sync */
  workspaceSync?: Omit<ConstructorParameters<typeof WorkspaceSync>[0], "dshHome" | "workspace" | "instanceLabel">;
  /** default pricing overrides */
  pricing?: ConstructorParameters<typeof CostTracker>[0];
  /** soft cost budget in USD (per cluster) */
  costBudgetUsd?: number;
  /** PART-2: pre-execution policy gate */
  policy?: PolicyEnforcer | import("./policy.js").Policy;
}

interface InstanceSlot {
  spec: DshInstanceSpec;
  client: DshClient;
  state: DshInstanceState;
  inFlight: number;
  totalRun: number;
  totalErrors: number;
  lastError?: string;
  lastActivityTs: number;
  explicitlyUnhealthy: boolean;
  removeWhenIdle?: boolean;
  startedAt: number;
  breaker?: CircuitBreaker<[DshTask], { result: DshResult; instance: string; cached?: boolean }>;
}

class DshResultFailure extends Error {
  constructor(readonly result: DshResult) {
    super(result.error?.message ?? `dsh exited with code ${result.exitCode}`);
    this.name = "DshResultFailure";
  }
}

export class DshCluster extends EventEmitter {
  private readonly spec: DshClusterSpec;
  private readonly slots = new Map<string, InstanceSlot>();
  private readonly clientOpts?: ConstructorParameters<typeof DshClient>[0];
  private readonly createdAt = Date.now();
  private readonly stopping = { v: false };
  private readonly healthTimer?: NodeJS.Timeout;
  private roundRobinCursor = 0;
  /** Resolved once in the constructor; reused by every instance slot. */
  private readonly resolvedModuleRoot: string;
  private readonly dshVersion: string;

  // Phase 2+3 layers
  readonly router = new AdaptiveRouter();
  readonly cache?: ResultCache;
  readonly cost!: CostTracker; // initialized in constructor after opts.pricing is available
  readonly metrics = new MetricsRegistry();
  readonly capabilities!: CapabilityRegistry; // initialized in constructor
  /** PART-2: optional policy enforcer that gates every route() / stream() call. */
  readonly policy?: PolicyEnforcer;
  /** 一次 DAG 允许的最大并行节点数（effort scaling 的硬闸门）。 */
  readonly maxParallelSubtasks: number;
  /** 每个 effort 档位允许的实例数。 */
  readonly effortPolicy: Record<"low" | "medium" | "high", number>;
  private autoScaler?: AutoScaler;
  private workspaceSync?: WorkspaceSync;
  private readonly useCache: boolean;
  private readonly useBreaker: boolean;
  private readonly taskFlights = new Map<string, Promise<DshResult & { instance: string; cached?: boolean }>>();
  /** 最近若干次运行的失败归因（含成功样本，failureRate 才有意义）。 */
  private readonly attributions: FailureAttribution[] = [];

  constructor(opts: DshClusterOptions) {
    super();
    const {
      client,
      enableCache,
      cacheDir,
      cacheTtlMs,
      enableBreaker,
      breakerOptions,
      workspaceSync,
      autoScaler,
      pricing,
      costBudgetUsd,
      policy,
      ...rest
    } = opts;
    this.spec = rest;
    this.clientOpts = client ?? {};
    // Resolve the runtime identity once. Both lookups can be expensive (module
    // discovery may shell out to `npm root -g`) and addSlot() needs them per
    // instance, so doing it here keeps cluster creation O(1) in subprocesses.
    this.resolvedModuleRoot = resolveDshModuleRoot() ?? this.resolveDshHome();
    this.dshVersion = resolveDshVersion();
    // Capabilities registry must be initialized after spec is set (needs dshHome).
    (this as { capabilities: CapabilityRegistry }).capabilities = new CapabilityRegistry(this.resolveDshHome());
    this.useCache = enableCache ?? !!cacheDir;
    this.useBreaker = enableBreaker ?? true;

    // effort scaling：并行度上限同时受集群闸门和当前实例数约束。
    this.maxParallelSubtasks = Math.max(1, rest.maxParallelSubtasks ?? 8);
    this.effortPolicy = {
      low: Math.max(1, Math.min(rest.effortPolicy?.low ?? DEFAULT_EFFORT_POLICY.low, this.maxParallelSubtasks)),
      medium: Math.max(
        1,
        Math.min(rest.effortPolicy?.medium ?? DEFAULT_EFFORT_POLICY.medium, this.maxParallelSubtasks),
      ),
      high: Math.max(1, Math.min(rest.effortPolicy?.high ?? DEFAULT_EFFORT_POLICY.high, this.maxParallelSubtasks)),
    };

    // Initialize CostTracker (P0-3: pass pricing through)
    (this as { cost: CostTracker }).cost = new CostTracker(pricing);

    // Initialize cache
    const dshHome = this.resolveDshHome();
    if (this.useCache) {
      this.cache = new ResultCache({
        cacheDir: cacheDir ?? join(dshHome, "cache"),
        defaultTtlMs: cacheTtlMs ?? 60 * 60 * 1000,
      });
    }

    if (costBudgetUsd !== undefined) this.cost.setBudget(costBudgetUsd);

    // PART-2: policy enforcement. Accept either a pre-built PolicyEnforcer or a Policy to wrap.
    if (policy) {
      this.policy = policy instanceof PolicyEnforcer ? policy : new PolicyEnforcer(policy);
    }
    this.cost.onBudgetEvent((evt) => this.emit("budget", evt));

    if (workspaceSync) {
      this.workspaceSync = new WorkspaceSync({
        dshHome,
        workspace: this.spec.workspace ?? process.cwd(),
        instanceLabel: "cluster-shared", // shared workspace, single namespace
        ...workspaceSync,
      });
      this.workspaceSync.start();
    }

    for (const inst of opts.instances) this.addSlot(inst, breakerOptions);

    // Initialize metrics
    this.metrics.set("dsh_cluster_instances", opts.instances.length);
    this.metrics.set("dsh_cluster_created_at", this.createdAt);

    if (rest.healthIntervalMs && rest.healthIntervalMs > 0) {
      this.healthTimer = setInterval(() => this.healthCheck(), rest.healthIntervalMs);
      this.healthTimer.unref?.();
    }

    if (autoScaler) {
      this.autoScaler = new AutoScaler(
        {
          profile: autoScaler.profile ?? rest.profile ?? "headless",
          ...autoScaler,
        },
        {
          spawn: async (profile) => {
            await this.scale({ profile, replicas: (this.replicasOf(profile) ?? 0) + 1 });
          },
          despawn: async (label) => {
            await this.scale({ remove: [label] });
          },
          queueDepth: () => this.queueDepth(),
          replicas: (profile) =>
            Array.from(this.slots.values())
              .filter((s) => (s.spec.profile ?? "headless") === profile)
              .map((s) => s.spec.label),
        },
      );
      this.autoScaler.start();
    }

    // addSlot() already published a capability record for every instance above;
    // re-publishing here only duplicated the work.
  }

  /** Run a single task, routing through the cluster. Returns the result + instance label. */
  async route(task: DshTask | string): Promise<DshResult & { instance: string; cached?: boolean }> {
    const original: DshTask = typeof task === "string" ? { task } : task;
    // PART-2: enforce policy before any side effects
    const policyChecked: DshTask = this.policy
      ? this.policy.assert(original, {
          estimatedCostUsd: this.estimateTaskCost(original, original.profile ?? this.spec.profile ?? "headless"),
          estimatedRuntimeMs: original.timeoutMs,
        })
      : original;
    // 角色契约必须在缓存查表之前注入：同一段话交给 planner 和交给 reviewer
    // 是两次不同的任务，缓存键必须体现这个差异。
    const prepared = this.prepareRole(policyChecked);
    const t: DshTask = prepared.task;
    const role = prepared.role;
    const profile = t.profile ?? this.spec.profile ?? "headless";
    const cacheContext = {
      cwd: t.cwd ?? this.spec.workspace,
      patches: t.patches,
      dshVersion: this.dshVersion,
    };
    this.metrics.inc("dsh_tasks_total");

    // 1. Try cache first
    if (this.cache && t.task) {
      const cached = this.cache.get(t, profile, cacheContext);
      if (cached) {
        this.metrics.inc("dsh_cache_hits_total");
        this.emit("task_done", {
          instance: "cache",
          task: { label: t.label, tags: t.tags },
          result: cached.entry.result,
          cached: true,
        });
        return { ...cached.entry.result, instance: "cache", cached: true };
      }
      this.metrics.inc("dsh_cache_misses_total");
    }

    // 2. Pick through the configured strategy.
    const pick = this.pick(t);
    const slot = pick.label ? this.slots.get(pick.label) : undefined;
    if (!pick.label || !slot) {
      // A label can survive pick() yet be gone here when another in-flight task
      // finished drainAndRemove() in between. Report it as an eligibility
      // failure instead of crashing on an undefined slot.
      this.metrics.inc("dsh_route_failures_total");
      throw new Error(
        "dsh-cluster: no eligible instance for task (router score: " +
          JSON.stringify(pick.scores.map((s) => ({ label: s.label, eligible: s.eligible, reason: s.reason }))) +
          ")",
      );
    }
    const estimatedCost = this.estimateTaskCost(t, profile);
    const reservationId = await this.cost.reserve(estimatedCost, t.label);
    if (reservationId === null) {
      // Hard budget exceeded
      const state = this.cost.budgetState();
      this.metrics.inc("dsh_budget_rejections_total");
      throw new Error(
        "dsh-cluster: hard budget exceeded (spent=" +
          state.spent.toFixed(4) +
          " reserved=" +
          state.reserved.toFixed(4) +
          " budget=" +
          (state.budgetUsd ?? 0) +
          " estimated=" +
          estimatedCost.toFixed(4) +
          ")",
      );
    }
    let flightKey: string | undefined;
    let flightPromise: Promise<DshResult & { instance: string; cached?: boolean }> | undefined;
    let resolveFlight: ((value: DshResult & { instance: string; cached?: boolean }) => void) | undefined;
    let rejectFlight: ((reason: unknown) => void) | undefined;
    if (this.cache) {
      flightKey = this.cache.keyFor(t, profile, cacheContext);
      const existing = this.taskFlights.get(flightKey);
      if (existing) {
        this.cost.release(reservationId);
        this.metrics.inc("dsh_singleflight_shared_total");
        const shared = await existing;
        return { ...shared, instance: "shared", cached: true };
      }
      flightPromise = new Promise((resolve, reject) => {
        resolveFlight = resolve;
        rejectFlight = reject;
      });
      void flightPromise.catch(() => undefined);
      this.taskFlights.set(flightKey, flightPromise);
    }
    slot.inFlight++;
    slot.state = "busy";
    slot.lastActivityTs = Date.now();
    const start = Date.now();
    let outcome: "ok" | "err" = "ok";
    let result: DshResult | null = null;
    let errorMsg: string | undefined;
    try {
      if (this.useBreaker && slot.breaker) {
        try {
          const br = await slot.breaker.exec(this.taskForSlot(slot, t));
          result = br.result;
        } catch (err) {
          if (err instanceof DshResultFailure) result = err.result;
          else throw err;
        }
        this.router.recordBreaker(pick.label, slot.breaker.stats());
      } else {
        result = await slot.client.run(this.taskForSlot(slot, t));
      }
      slot.totalRun++;
      // —— 组织层：契约审计 + 独立验证 + 失败归因 ——
      // 这一步把「退出码干净」和「任务真的做成了」区分开。没有这一层，
      // 一个越权改了文件但什么都没完成的 run 会被当成成功并写进缓存。
      const governed = await this.applyGovernance(t, role, result);
      result = governed.result;
      if (result.error || (result.exitCode !== null && result.exitCode !== 0)) {
        slot.totalErrors++;
        outcome = "err";
        if (result.error?.message) slot.lastError = result.error.message;
        errorMsg = result.error?.message ?? "exit " + result.exitCode;
      }
      if (result.usage) {
        this.cost.record({
          instanceLabel: pick.label,
          profile,
          model: result.usage.model ?? "default",
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          durationMs: result.durationMs,
          ts: Date.now(),
          taskPreview: t.task.slice(0, 80),
        });
        this.router.recordCost(
          pick.label,
          this.cost.estimateCost(result.usage.model ?? "default", result.usage.inputTokens, result.usage.outputTokens),
          result.usage.totalTokens,
        );
      }
      // 3. Cache successful results
      if (this.cache && outcome === "ok" && result) {
        this.cache.set(t, profile, result, undefined, cacheContext);
      }
      this.emit("task_done", { instance: pick.label, task: { label: t.label, tags: t.tags }, result });
      const routed = { ...result, instance: pick.label };
      resolveFlight?.(routed);
      return routed;
    } catch (err) {
      slot.totalErrors++;
      outcome = "err";
      errorMsg = err instanceof Error ? err.message : String(err);
      slot.lastError = errorMsg;
      this.emit("task_error", { instance: pick.label, error: errorMsg });
      rejectFlight?.(err);
      throw err;
    } finally {
      // P0-4: confirm or release reservation based on outcome
      if (reservationId) {
        if (outcome === "ok" && result) {
          this.cost.confirm(reservationId);
        } else {
          this.cost.release(reservationId);
        }
      }
      const slot2 = this.slots.get(pick.label);
      if (slot2) slot2.inFlight--;
      if (slot2) {
        if (slot2.removeWhenIdle && slot2.inFlight === 0) this.finalizeRemoval(slot2.spec.label);
        else slot2.state = slot2.inFlight > 0 ? "busy" : "ready";
        slot2.lastActivityTs = Date.now();
      }
      const dur = Date.now() - start;
      this.router.recordResult(pick.label, outcome === "ok", dur, errorMsg);
      this.metrics.inc(outcome === "ok" ? "dsh_tasks_succeeded_total" : "dsh_tasks_failed_total", {
        instance: pick.label,
      });
      this.metrics.observe("dsh_task_duration_ms", dur, { instance: pick.label });
      if (flightKey && flightPromise && this.taskFlights.get(flightKey) === flightPromise) {
        this.taskFlights.delete(flightKey);
      }
    }
  }

  /**
   * 解析任务里的角色契约并把它编译进 prompt。
   *
   * **未知部门名直接抛错，不回退到默认角色**：调用方以为自己在跟 planner 说话，
   * 实际拿到一个没有约束的执行者，这种静默降级就是「违反角色设定」的来源。
   */
  prepareRole(t: DshTask): { task: DshTask; role?: RoleSpec } {
    if (!t.role) return { task: t };
    const spec = typeof t.role === "string" ? getDepartment(t.role) : t.role;
    if (!spec) {
      throw new Error(
        "dsh-cluster: unknown department '" +
          String(typeof t.role === "string" ? t.role : t.role.name) +
          "' (built-ins: " +
          Object.keys(DEPARTMENTS).join(", ") +
          ")",
      );
    }
    const problems = validateRoleSpec(spec);
    if (problems.length > 0) throw new Error("dsh-cluster: invalid role spec: " + problems.join("; "));
    return { task: { ...t, task: attachRoleContract(t.task, spec) }, role: spec };
  }

  /**
   * 组织层闸门：契约审计 + 独立验证 + token 预算 + 失败归因。
   *
   * 这里最重要的副作用是**把契约违约翻译成 result.error**。上层所有分支
   * （缓存、断路器、DAG 节点状态、MCP 信封、CLI 退出码）都以 `result.error`
   * 作为失败判定；如果只把违规塞进 audit 而不设 error，一次越权的运行会一路
   * 被当成成功，还会把答案写进缓存污染后续调用。
   */
  async applyGovernance(
    t: DshTask,
    role: RoleSpec | undefined,
    raw: DshResult,
  ): Promise<{ result: DshResult; ok: boolean }> {
    const audit: DshTaskAudit = {};
    let roleAudit: RoleAudit | undefined;

    if (role) {
      roleAudit = auditRoleRun(role, raw);
      audit.role = {
        name: roleAudit.role,
        ok: roleAudit.ok,
        violations: roleAudit.violations,
        toolCalls: roleAudit.toolCalls,
        parsedOutput: roleAudit.parsedOutput,
        unsupportedSchemaKeys: roleAudit.unsupportedSchemaKeys,
      };
    }

    // 验证层即使在运行失败时也要跑：任务崩了但产物已经落盘一半是常见情况，
    // 「崩在哪一步」恰恰只有验证命令能告诉你。
    if (t.verify && t.verify.length > 0) {
      audit.verification = await verifyResult(t.verify, {
        result: raw,
        cwd: t.cwd ?? this.spec.workspace,
      });
    }

    const thinkingTokens = raw.usage?.totalTokens ?? 0;
    if (t.thinkingTokenBudget !== undefined || thinkingTokens > 0) {
      audit.budget = {
        thinkingTokens,
        budget: t.thinkingTokenBudget,
        exceeded: t.thinkingTokenBudget !== undefined && thinkingTokens > t.thinkingTokenBudget,
      };
    }

    const baseFailed = raw.error !== undefined;
    const contractOk = roleAudit?.ok ?? true;
    const verifyOk = audit.verification?.ok ?? true;
    let result: DshResult = Object.keys(audit).length > 0 ? { ...raw, audit } : raw;

    if (!baseFailed && !contractOk && !verifyOk) {
      result = {
        ...result,
        error: {
          code: "VERIFY_FAILED",
          message:
            "契约与验证均未通过: " +
            (roleAudit?.violations.map((v) => v.code + " " + v.message).join(" ; ") ?? "") +
            " | " +
            (audit.verification?.checks
              .filter((c) => !c.ok)
              .map((c) => c.name + ": " + c.detail)
              .join(" ; ") ?? ""),
        },
      };
    } else if (!baseFailed && !contractOk) {
      result = {
        ...result,
        error: {
          code: "ROLE_CONTRACT_VIOLATION",
          message: roleAudit!.violations.map((v) => v.code + ": " + v.message).join(" ; "),
        },
      };
    } else if (!baseFailed && !verifyOk) {
      result = {
        ...result,
        error: {
          code: "VERIFY_FAILED",
          message:
            audit.verification?.checks
              .filter((c) => !c.ok)
              .map((c) => c.name + ": " + c.detail)
              .join(" ; ") ?? "verification failed",
        },
      };
    }

    const ok = result.error === undefined;
    const attribution = this.attribute(t, role, result, audit);
    if (attribution.signals.length > 0) result = { ...result, audit: { ...(result.audit ?? audit), attribution } };
    return { result, ok };
  }

  /** 生成一次运行的 MAST 归因并入环形缓冲。成功样本也记账，failureRate 才有意义。 */
  private attribute(
    t: DshTask,
    role: RoleSpec | undefined,
    result: DshResult,
    audit: DshTaskAudit,
  ): FailureAttribution {
    const view: TraceView = {
      task: t.task,
      roleName: role?.name,
      answer: result.answer,
      exitCode: result.exitCode,
      // summarize() 把被中断的运行标记为 ABORTED，这是「没做完」区别于「做错了」的唯一线索。
      aborted: result.error?.code === "ABORTED",
      errorCode: result.error?.code,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      durationMs: result.durationMs,
      declaredMaxToolCalls: role?.maxToolCalls,
      verification: audit.verification
        ? {
            ok: audit.verification.ok,
            unknownKinds: audit.verification.unknownKinds,
            checks: audit.verification.checks.map((c) => ({ kind: c.kind, ok: c.ok, detail: c.detail })),
          }
        : undefined,
      roleAudit: audit.role ? { ok: audit.role.ok, violations: audit.role.violations } : undefined,
    };
    const attribution = classifyTrace(view);
    this.attributions.push(attribution);
    if (this.attributions.length > MAX_ATTRIBUTIONS) this.attributions.shift();
    // 弱信号（无法确定的推断）不上事件总线，避免把 noisy alert 灌进 dashboard。
    if (attribution.primary && attribution.primary.confidence >= 0.7) {
      this.emit("failure_attributed", { task: { label: t.label, role: role?.name }, attribution });
    }
    return attribution;
  }

  /** 批量归因报告：这批任务到底在哪一类失败上最吃亏。 */
  attributionReport(): MastReport {
    return aggregateFailures(this.attributions);
  }

  /**
   * 按 effort 档给出建议并行实例数。
   *
   * 目的很实际：Anthropic 在生产里发现，不写死 effort 规则的话，模型会为一个
   * 简单问题开出几十个子 agent。这里把上限钉死，最多給到集群当前的实际
   * 规模——推荐 8 个实例而集群只有 2 个是没有意义的。
   */
  recommendFanout(effort: "low" | "medium" | "high" = "medium"): number {
    const wanted = this.effortPolicy[effort] ?? DEFAULT_EFFORT_POLICY[effort];
    const alive = Array.from(this.slots.values()).filter((s) => s.state !== "stopped" && s.state !== "down").length;
    return Math.max(1, Math.min(wanted, this.maxParallelSubtasks, alive > 0 ? alive : 1));
  }

  /** Streaming version with optional replay recording. */
  async *stream(
    task: DshTask | string,
    opts: { record?: { dir: string } } = {},
  ): AsyncGenerator<DshEvent & { instance: string }> {
    const original: DshTask = typeof task === "string" ? { task } : task;
    const t: DshTask = this.policy
      ? this.policy.assert(original, {
          estimatedCostUsd: this.estimateTaskCost(original, original.profile ?? this.spec.profile ?? "headless"),
          estimatedRuntimeMs: original.timeoutMs,
        })
      : original;
    const recorder = opts.record
      ? new ReplayRecorder({ task: t.task, instanceLabel: "stream", profile: t.profile ?? "" })
      : null;
    const pick = this.pick(t);
    const slot = pick.label ? this.slots.get(pick.label) : undefined;
    if (!pick.label || !slot) throw new Error("dsh-cluster: no eligible instance for stream");
    const profile = t.profile ?? this.spec.profile ?? "headless";
    const reservationId = await this.cost.reserve(this.estimateTaskCost(t, profile), t.label);
    if (reservationId === null) {
      this.metrics.inc("dsh_budget_rejections_total");
      throw new Error("dsh-cluster: hard budget exceeded");
    }
    slot.inFlight++;
    slot.state = "busy";
    slot.lastActivityTs = Date.now();
    const startedAt = Date.now();
    let outcome: "ok" | "err" = "ok";
    let usage: DshResult["usage"];
    try {
      for await (const evt of slot.client.stream(this.taskForSlot(slot, t))) {
        // The classifier wraps the payload, so a usage line arrives as
        // { usage: {...} }. Reading evt.data directly yielded undefined token
        // counts and pushed NaN costs into the tracker.
        if (evt.kind === "usage") {
          const d = evt.data as { usage?: DshResult["usage"] } & Partial<NonNullable<DshResult["usage"]>>;
          usage = d.usage ?? (typeof d.inputTokens === "number" ? (d as DshResult["usage"]) : undefined);
        }
        if (evt.kind === "error") outcome = "err";
        if (evt.kind === "exit") {
          const data = evt.data as { exitCode?: number | null };
          if (data.exitCode !== undefined && data.exitCode !== null && data.exitCode !== 0) outcome = "err";
        }
        recorder?.record(evt);
        yield { ...evt, instance: pick.label };
      }
      slot.totalRun++;
      if (outcome === "err") slot.totalErrors++;
      if (usage) {
        this.cost.record({
          instanceLabel: pick.label,
          profile,
          model: usage.model ?? "default",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs: Date.now() - startedAt,
          ts: Date.now(),
          taskPreview: t.task.slice(0, 80),
        });
      }
    } catch (err) {
      outcome = "err";
      slot.totalErrors++;
      throw err;
    } finally {
      if (outcome === "ok") this.cost.confirm(reservationId);
      else this.cost.release(reservationId);
      slot.inFlight--;
      if (slot.removeWhenIdle && slot.inFlight === 0) this.finalizeRemoval(slot.spec.label);
      else slot.state = slot.inFlight > 0 ? "busy" : "ready";
      slot.lastActivityTs = Date.now();
      const durationMs = Date.now() - startedAt;
      this.router.recordResult(pick.label, outcome === "ok", durationMs);
      this.metrics.inc(outcome === "ok" ? "dsh_tasks_succeeded_total" : "dsh_tasks_failed_total", {
        instance: pick.label,
      });
      this.metrics.observe("dsh_task_duration_ms", durationMs, { instance: pick.label });
    }
  }

  /** Pick an instance for a task. P0-2: respects spec.routing (round-robin/least-loaded/tag/random use ROUTING_FNS, "adaptive" uses AdaptiveRouter scoring). */
  pick(task: DshTask): {
    label: string | null;
    scores: Array<{ label: string; score: number; eligible: boolean; reason?: string }>;
  } {
    if (this.stopping.v) return { label: null, scores: [] };
    const statusList = Array.from(this.slots.values())
      .filter((s) => s.state !== "stopped")
      .map((s) => this.toStatus(s));
    const instances = statusList.map((s) => ({ ...s, spec: this.slots.get(s.label)!.spec }));
    const strategy = (this.spec.routing ?? "least-loaded") as string;
    if (strategy === "round-robin") {
      const eligible = instances
        .filter((i) => (i.state === "ready" || i.state === "busy") && i.inFlight < i.concurrency)
        .sort((a, b) => a.label.localeCompare(b.label));
      if (eligible.length === 0) return { label: null, scores: [] };
      const chosen = eligible[this.roundRobinCursor++ % eligible.length]!.label;
      return {
        label: chosen,
        scores: eligible.map((i) => ({ label: i.label, score: i.label === chosen ? 1 : 0, eligible: true })),
      };
    }
    // For non-adaptive strategies, use the static routing function
    if (strategy !== "adaptive" && ROUTING_FNS[strategy as keyof typeof ROUTING_FNS]) {
      const chosen = ROUTING_FNS[strategy as keyof typeof ROUTING_FNS]({ task, instances, now: Date.now() });
      if (chosen) {
        const scores = instances.map((i) => ({
          label: i.label,
          score: i.label === chosen ? 1 : 0,
          eligible: i.state === "ready" || i.state === "busy",
        }));
        return { label: chosen, scores };
      }
      return { label: null, scores: [] };
    }
    // "adaptive" (or unknown): use scoring-based router
    return this.router.pick(task, instances);
  }

  /** Snapshot of the cluster state. */
  status(): DshClusterStatus {
    return {
      routing: (this.spec.routing ?? "least-loaded") as DshClusterStatus["routing"],
      workspace: this.spec.workspace,
      dshHome: this.spec.dshHome,
      createdAt: this.createdAt,
      instances: Array.from(this.slots.values()).map((s) => this.toStatus(s)),
      cache: this.cache ? { ...this.cache.stats() } : undefined,
      cost: (() => {
        const s = this.cost.globalSummary();
        const b = this.cost.budgetState();
        return { ...s, budgetUsd: b.budgetUsd, budgetSpent: b.spent, budgetReserved: b.reserved };
      })(),
      workspaceSync: this.workspaceSync
        ? {
            localChanges: this.workspaceSync.stats().localChanges,
            remoteChanges: this.workspaceSync.stats().remoteChanges,
            filesShared: this.workspaceSync.stats().filesShared,
            bytesShared: this.workspaceSync.stats().bytesShared,
          }
        : undefined,
      attribution: this.attributionSummary(),
    };
  }

  /** status() 用的归因摘要；还没有样本时返回 undefined（0 和「没数据」不能混为一谈）。 */
  private attributionSummary(): DshClusterStatus["attribution"] {
    if (this.attributions.length === 0) return undefined;
    const report = aggregateFailures(this.attributions);
    return {
      totalTraces: report.totalTraces,
      failedTraces: report.failedTraces,
      failureRate: report.failureRate,
      byCategory: report.byCategory,
      top: report.rows.slice(0, 5).map((r) => ({ code: r.code, labelZh: r.labelZh, count: r.count, fix: r.fix })),
    };
  }

  async scale(change: {
    profile?: string;
    replicas?: number;
    add?: DshInstanceSpec[];
    remove?: string[];
  }): Promise<DshClusterStatus> {
    if (change.remove) {
      for (const l of change.remove) await this.drainAndRemove(l);
    }
    if (change.add) for (const spec of change.add) this.addSlot(spec);
    if (typeof change.replicas === "number" && change.profile) {
      const target = change.profile;
      const current = Array.from(this.slots.values()).filter((s) => s.spec.profile === target);
      const delta = change.replicas - current.length;
      if (delta > 0) {
        for (let i = 0; i < delta; i++) {
          const idx = current.length + i + 1;
          this.addSlot({ label: target + "-" + idx, profile: target });
        }
      } else if (delta < 0) {
        for (let i = 0; i < -delta; i++) {
          const victim = current[i];
          if (victim) {
            await this.drainAndRemove(victim.spec.label);
          }
        }
      }
    }
    this.metrics.set("dsh_cluster_instances", this.slots.size);
    return this.status();
  }

  /**
   * Run a DAG of dependent tasks.
   *
   * 并行度在这里被集群的 maxParallelSubtasks 兜住 —— 单个调用方可以声明一个
   * 更小的 concurrency，但不能越过集群的 effort 闸门。
   */
  async runDag(spec: DagSpec): Promise<ReturnType<DagExecutor["run"]>> {
    const executor = new DagExecutor(async (t) => {
      const r = await this.route(t);
      return { result: r, instance: r.instance, cached: r.cached };
    });
    return await executor.run({
      ...spec,
      maxParallel: spec.maxParallel ?? this.maxParallelSubtasks,
    });
  }

  /** Estimate current queue depth (in-flight count). */
  private queueDepth(): number {
    let sum = 0;
    for (const s of this.slots.values()) sum += s.inFlight;
    return sum;
  }

  private replicasOf(profile: string): number | undefined {
    return Array.from(this.slots.values()).filter((s) => (s.spec.profile ?? "headless") === profile).length;
  }

  /** Graceful shutdown. */
  async shutdown(timeoutMs = 5000): Promise<void> {
    this.stopping.v = true;
    this.autoScaler?.stop();
    this.workspaceSync?.stop();
    if (this.healthTimer) clearInterval(this.healthTimer);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (Array.from(this.slots.values()).every((s) => s.inFlight === 0)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const s of this.slots.values()) {
      s.state = "stopped";
      this.capabilities.unpublish(s.spec.label);
    }
    this.emit("shutdown");
  }

  /** P0-4: estimate cost for a task before running. */
  private estimateTaskCost(t: DshTask, profile: string): number {
    const recent = this.cost.summaries().find((s) => s.instanceLabel.includes(profile));
    if (recent && recent.totalRuns > 0) return recent.avgCostUsd * 2; // 2x avg as upper bound
    return 0.01; // safe default for unknown
  }

  private resolveDshHome(): string {
    return this.spec.dshHome ?? this.clientOpts?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  }

  private addSlot(spec: DshInstanceSpec, breakerOptions?: ConstructorParameters<typeof CircuitBreaker>[1]): void {
    if (this.slots.has(spec.label)) return;
    const client = new DshClient({
      ...this.clientOpts,
      dshHome: this.spec.dshHome ?? this.clientOpts?.dshHome,
      workspace: this.spec.workspace ?? this.clientOpts?.workspace,
      defaultProfile: spec.profile ?? this.spec.profile ?? this.clientOpts?.defaultProfile,
    });
    const slot: InstanceSlot = {
      spec,
      client,
      state: "ready",
      inFlight: 0,
      totalRun: 0,
      totalErrors: 0,
      lastActivityTs: Date.now(),
      explicitlyUnhealthy: false,
      startedAt: Date.now(),
    };
    if (this.useBreaker) {
      slot.breaker = new CircuitBreaker(
        async (task) => {
          const r = await client.run(task);
          if (r.error || (r.exitCode !== null && r.exitCode !== 0)) throw new DshResultFailure(r);
          return { result: r, instance: spec.label };
        },
        {
          name: spec.label,
          timeout: 10 * 60 * 1000,
          errorThresholdPercentage: 50,
          volumeThreshold: 5,
          resetTimeout: 30_000,
          ...breakerOptions,
        },
      );
    }
    this.slots.set(spec.label, slot);
    this.capabilities.publish({
      label: spec.label,
      profile: spec.profile ?? this.spec.profile ?? "headless",
      dshVersion: this.dshVersion,
      dshModuleRoot: this.resolvedModuleRoot,
      tools: [],
      tags: spec.tags ?? [],
      concurrency: spec.concurrency ?? 1,
      ttlMs: 60000,
    });
  }

  private taskForSlot(slot: InstanceSlot, task: DshTask): DshTask {
    return {
      ...task,
      profile: task.profile ?? slot.spec.profile ?? this.spec.profile,
      cwd: task.cwd ?? slot.spec.cwd ?? this.spec.workspace,
      patches: [...(slot.spec.patches ?? []), ...(task.patches ?? [])],
      env: { ...(slot.spec.env ?? {}), ...(task.env ?? {}) },
    };
  }

  private async drainAndRemove(label: string, timeoutMs = 30_000): Promise<void> {
    const slot = this.slots.get(label);
    if (!slot) return;
    slot.state = "draining";
    const startedAt = Date.now();
    while (slot.inFlight > 0 && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (slot.inFlight > 0) {
      slot.removeWhenIdle = true;
      return;
    }
    this.finalizeRemoval(label);
  }

  private finalizeRemoval(label: string): void {
    const slot = this.slots.get(label);
    if (!slot) return;
    slot.state = "stopped";
    this.slots.delete(label);
    this.capabilities.unpublish(label);
  }

  private toStatus(s: InstanceSlot): DshInstanceStatus {
    const m = this.router.get(s.spec.label);
    const cost = this.cost.summaryFor(s.spec.label);
    return {
      label: s.spec.label,
      profile: s.spec.profile ?? this.spec.profile ?? "headless",
      state: s.state,
      inFlight: s.inFlight,
      concurrency: s.spec.concurrency ?? 1,
      tags: s.spec.tags ?? [],
      totalRun: s.totalRun,
      totalErrors: s.totalErrors,
      lastError: s.lastError,
      lastActivityTs: s.lastActivityTs,
      startedAt: s.startedAt,
      breaker: s.breaker?.state,
      score: m ? computeOverallScore(m) : undefined,
      cost:
        cost.totalRuns > 0
          ? {
              totalCostUsd: cost.totalCostUsd,
              totalTokens: cost.totalInputTokens + cost.totalOutputTokens,
              avgCostUsd: cost.avgCostUsd,
              avgDurationMs: cost.avgDurationMs,
            }
          : undefined,
    };
  }

  private healthCheck(): void {
    const now = Date.now();
    for (const s of this.slots.values()) {
      // Only an explicit health-check failure (timeout / crash observed by spawn watcher) marks an instance down.
      // Idle for 30 minutes is normal; long-running instances should not be marked down by inactivity alone.
      if (s.state === "ready" && s.inFlight === 0 && s.explicitlyUnhealthy && now - s.lastActivityTs > 5 * 60 * 1000) {
        s.state = "down";
        this.emit("instance_down", { label: s.spec.label });
      }
    }
  }
}

/** Simple aggregate of an instance's metrics for the status snapshot. */
function computeOverallScore(m: ReturnType<AdaptiveRouter["get"]>): number {
  if (!m) return 0;
  const sr = m.totalRuns === 0 ? 0.8 : m.successes / m.totalRuns;
  return sr;
}
