// task-dag.ts - DAG-based task executor.
//
// Accepts a list of nodes with `dependsOn`. Topologically sorts, executes
// independent nodes in parallel (up to `concurrency`), waits for dependencies
// to complete before launching dependents, and returns the full result map.
// Failed nodes can either abort the whole DAG or continue (configurable).

import type { DshResult, DshTask } from "./types.js";

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
}

export interface DagSpec {
  nodes: DagNode[];
  concurrency?: number;
  abortOnFailure?: boolean;
  /** optional shared defaults */
  defaults?: Partial<DshTask>;
  /** Maximum dependency context appended to one task (default 20000 chars). */
  maxDependencyChars?: number;
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
}

export type NodeRunner = (task: DshTask) => Promise<{ result: DshResult; instance?: string; cached?: boolean }>;

export class DagExecutor {
  constructor(private readonly runner: NodeRunner) {}

  async run(spec: DagSpec): Promise<DagResult> {
    const startedAt = Date.now();
    const abortOnFailure = spec.abortOnFailure ?? true;
    const concurrency = Math.max(1, spec.concurrency ?? 4);
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
    return {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      nodes: Array.from(nodeResults.values()),
      order,
      failed,
      cacheHits,
      aborted,
    };
  }
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
