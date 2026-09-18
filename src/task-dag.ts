// task-dag.ts - DAG-based task executor.
//
// Accepts a list of nodes with `dependsOn`. Topologically sorts, executes
// independent nodes in parallel (up to `concurrency`), waits for dependencies
// to complete before launching dependents, and returns the full result map.
// Failed nodes can either abort the whole DAG or continue (configurable).

import type { DshResult, DshTask } from "./types.js";
import type { RoleSpec } from "./role-spec.js";
import type { VerifyRule } from "./verifier.js";
import type { FailureAttribution } from "./mast.js";
import type { RepairPolicyInput } from "./repair.js";

export interface DagNode {
  id: string;
  task: string | DshTask;
  dependsOn?: string[];
  /** optional routing override: which profile/tags */
  profile?: string;
  tags?: string[];
  timeoutMs?: number;
  /** if false, node failure does not abort DAG */
  critical?: boolean;
  /** Append completed dependency answers as structured context (default true). */
  includeDependencyResults?: boolean;
  /** 节点级角色契约：内置部门名或完整 spec。 */
  role?: string | RoleSpec;
  /** 节点级独立验证规则，节点跑完后由框架执行。 */
  verify?: VerifyRule[];
  effort?: "low" | "medium" | "high";
  /**
   * 节点级自纠错策略。同一张图里，允许自愈的节点和必须一次做对的节点往往不同：
   * 探索性子任务值得重试，已经写了文件的关键步骤不值得。
   */
  selfRepair?: RepairPolicyInput;
}

export interface DagSpec {
  nodes: DagNode[];
  concurrency?: number;
  abortOnFailure?: boolean;
  /** optional shared defaults */
  defaults?: Partial<DshTask>;
  /** Maximum dependency context appended to one task (default 20000 chars). */
  maxDependencyChars?: number;
  /**
   * 节点数上限。Anthropic 在生产里踩过的坑：不写这条，模型会为一个简单问题
   * 拆出几十个子 agent。超限时拒绝执行（fast fail），而不是替它跑完再说。
   */
  maxNodes?: number;
  /** 并行度上限；由集群的 maxParallelSubtasks 注入。 */
  maxParallel?: number;
}

export interface DagNodeResult {
  id: string;
  status: "ok" | "failed" | "skipped";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  result?: DshResult;
  error?: string;
  /** ids this node was waiting for */
  dependencies: string[];
  /** which instance handled it */
  instance?: string;
  /** if true, result was served from cache */
  cached?: boolean;
}

export interface DagResult {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  nodes: DagNodeResult[];
  /** execution order (topo sort, parallelized) */
  order: string[][];
  /** ids that failed and are not skipped */
  failed: string[];
  /** ids of nodes that returned from cache */
  cacheHits: string[];
  aborted: boolean;
  /** 每个失败节点的 MAST 归因（键为节点 id）。成功节点不出现。 */
  attribution: Record<string, FailureAttribution>;
}

export type NodeRunner = (task: DshTask) => Promise<{ result: DshResult; instance?: string; cached?: boolean }>;

export class DagExecutor {
  constructor(private readonly runner: NodeRunner) {}

  async run(spec: DagSpec): Promise<DagResult> {
    const startedAt = Date.now();
    const abortOnFailure = spec.abortOnFailure ?? true;
    // 并行度同时受调用方声明和集群/上层注入的闸门约束，取更小者。
    const declaredConcurrency = spec.concurrency ?? 4;
    const concurrency = Math.max(1, Math.min(declaredConcurrency, spec.maxParallel ?? Number.POSITIVE_INFINITY));
    // effort scaling 的硬闸门：拆分本身就是有损的（每次交接只丢信息不增加信息），
    // 一个 50 节点的 DAG 多半是「被拆多了」而不是「真的需要 50 步」。
    if (spec.maxNodes !== undefined && spec.nodes.length > spec.maxNodes) {
      throw new Error(
        `dag: ${spec.nodes.length} nodes exceeds maxNodes ${spec.maxNodes} — simplify the plan before running`,
      );
    }
    const byId = new Map<string, DagNode>();
    for (const n of spec.nodes) {
      if (!n.id.trim()) throw new Error("dag: node id must not be empty");
      if (byId.has(n.id)) throw new Error("dag: duplicate node id '" + n.id + "'");
      byId.set(n.id, n);
    }

    // Validate
    for (const n of spec.nodes) {
      for (const dep of n.dependsOn ?? []) {
        if (!byId.has(dep)) throw new Error("dag: missing dependency '" + dep + "' for node '" + n.id + "'");
      }
    }
    // Detect cycles via DFS
    detectCycles(spec.nodes);

    const nodeResults = new Map<string, DagNodeResult>();
    const order: string[][] = [];
    const pending = new Set(spec.nodes.map((n) => n.id));
    const failed: string[] = [];
    const cacheHits: string[] = [];
    const attribution: Record<string, FailureAttribution> = {};
    let aborted = false;

    while (pending.size > 0 && !aborted) {
      const ready: DagNode[] = [];
      for (const id of pending) {
        const node = byId.get(id)!;
        const deps = node.dependsOn ?? [];
        const allDepsDone = deps.every((d) => nodeResults.has(d));
        const anyDepFailed = deps.some((d) => failed.includes(d));
        if (anyDepFailed && node.critical !== false) {
          // Skip — critical default true, skip on dep failure
          const r: DagNodeResult = {
            id,
            status: "skipped",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            durationMs: 0,
            error: "dependency failed",
            dependencies: deps,
          };
          nodeResults.set(id, r);
          pending.delete(id);
          continue;
        }
        if (allDepsDone) ready.push(node);
      }
      if (ready.length === 0) {
        // No progress possible; abort.
        aborted = true;
        break;
      }
      const wave = ready.slice(0, concurrency);
      order.push(wave.map((n) => n.id));
      const settled = await Promise.allSettled(
        wave.map(async (node) => {
          const nodeStart = Date.now();
          try {
            const task: DshTask =
              typeof node.task === "string"
                ? {
                    task: node.task,
                    profile: node.profile,
                    tags: node.tags,
                    timeoutMs: node.timeoutMs,
                    // 角色契约与验证规则跟着节点走 —— 同一个 DAG 里 planner 和
                    // reviewer 承担的义务本来就不同。
                    role: node.role,
                    verify: node.verify,
                    effort: node.effort,
                    selfRepair: node.selfRepair,
                    ...(spec.defaults ?? {}),
                  }
                : ({ ...spec.defaults, ...node.task, id: undefined } as DshTask);
            if ((node.dependsOn?.length ?? 0) > 0 && node.includeDependencyResults !== false) {
              const dependencyContext = buildDependencyContext(
                node.dependsOn ?? [],
                nodeResults,
                spec.maxDependencyChars ?? 20_000,
              );
              task.task += "\n\n<dependency-results>\n" + dependencyContext + "\n</dependency-results>";
            }
            const { result, instance, cached } = await this.runner(task);
            const nodeEnd = Date.now();
            // A runner is allowed to *resolve* with a failed result: the cluster
            // route() path returns the result instead of throwing. Keying the
            // node status off "did the promise resolve" therefore marked every
            // non-zero exit — missing credentials, crashed tool, killed child —
            // as a successful node with an empty answer.
            const failure = describeResultFailure(result);
            if (failure) {
              // 失败节点的归因随结果一起回传：cluster.route 已经把MAST 分类挂在
              // result.audit.attribution 上，这里只需要透出。**成功节点不写** ——
              // 归因是给失败用的，给每个节点都贴一堆信号只会淹没真正的问题。
              const nodeAttribution = result?.audit?.attribution;
              if (nodeAttribution && nodeAttribution.signals.length > 0) attribution[node.id] = nodeAttribution;
              nodeResults.set(node.id, {
                id: node.id,
                status: "failed",
                startedAt: nodeStart,
                finishedAt: nodeEnd,
                durationMs: nodeEnd - nodeStart,
                result,
                error: failure,
                dependencies: node.dependsOn ?? [],
                instance,
                cached,
              });
              pending.delete(node.id);
              if (node.critical !== false) failed.push(node.id);
              if (abortOnFailure && node.critical !== false) throw new Error(failure);
              return;
            }
            const r: DagNodeResult = {
              id: node.id,
              status: "ok",
              startedAt: nodeStart,
              finishedAt: nodeEnd,
              durationMs: nodeEnd - nodeStart,
              result,
              dependencies: node.dependsOn ?? [],
              instance,
              cached,
            };
            nodeResults.set(node.id, r);
            pending.delete(node.id);
            if (cached) cacheHits.push(node.id);
          } catch (e) {
            const nodeEnd = Date.now();
            // A failure the branch above already recorded in full (it keeps the
            // DshResult for diagnostics) must not be clobbered by the generic
            // handler — only the abort propagation is still needed.
            if (!nodeResults.has(node.id)) {
              const r: DagNodeResult = {
                id: node.id,
                status: "failed",
                startedAt: nodeStart,
                finishedAt: nodeEnd,
                durationMs: nodeEnd - nodeStart,
                error: e instanceof Error ? e.message : String(e),
                dependencies: node.dependsOn ?? [],
              };
              nodeResults.set(node.id, r);
              pending.delete(node.id);
              if (node.critical !== false) failed.push(node.id);
            }
            if (abortOnFailure && node.critical !== false) throw e;
          }
        }),
      );
      for (let i = 0; i < settled.length; i++) {
        if (settled[i]!.status === "rejected" && abortOnFailure) {
          aborted = true;
          break;
        }
      }
    }

    const finishedAt = Date.now();

    // Anything still pending when the DAG aborts never ran. Recording those as
    // skipped keeps the node list accountable: an aborted 5-node DAG used to
    // return a node list containing only the first failure, so a caller could
    // not tell the difference between "finished" and "stopped early".
    if (aborted) {
      for (const id of pending) {
        const node = byId.get(id)!;
        nodeResults.set(id, {
          id,
          status: "skipped",
          startedAt: finishedAt,
          finishedAt,
          durationMs: 0,
          error: "dag aborted before this node ran",
          dependencies: node.dependsOn ?? [],
        });
      }
      pending.clear();
    }

    return {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      nodes: Array.from(nodeResults.values()),
      order,
      failed,
      cacheHits,
      aborted,
      attribution,
    };
  }
}

/**
 * Failure carried by a resolved DshResult, or undefined when the run succeeded.
 *
 * `route()` deliberately resolves with a "soft" failure rather than rejecting,
 * so any consumer that only watches for a thrown error will silently treat the
 * failure as a success.
 */
function describeResultFailure(result: DshResult | undefined): string | undefined {
  if (!result) return undefined;
  if (result.error?.message) return result.error.message;
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return "dsh exited with code " + result.exitCode;
  }
  return undefined;
}

function buildDependencyContext(
  dependencyIds: string[],
  results: Map<string, DagNodeResult>,
  maxChars: number,
): string {
  const payload = dependencyIds.map((id) => {
    const dependency = results.get(id);
    return {
      id,
      status: dependency?.status,
      answer: dependency?.result?.answer,
      error: dependency?.error,
      instance: dependency?.instance,
    };
  });
  const text = JSON.stringify(payload, null, 2);
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "\n... dependency context truncated";
}

function detectCycles(nodes: DagNode[]): void {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, n.dependsOn ?? []);
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);
  const dfs = (u: string, path: string[]): void => {
    color.set(u, GRAY);
    path.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY)
        throw new Error("dag: cycle detected at '" + v + "' (path: " + path.join(" -> ") + ")");
      if (color.get(v) === WHITE) dfs(v, path);
    }
    color.set(u, BLACK);
    path.pop();
  };
  for (const n of nodes) {
    if (color.get(n.id) === WHITE) dfs(n.id, []);
  }
}
