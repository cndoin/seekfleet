// harness-sdk.ts - unified SeekFleet entry point.
//
// The single object hermes / openclaw / Codex import. Composes:
//   - run / stream          : single-instance tasks
//   - cluster              : multi-instance orchestration with breaker, cache, cost, etc.
//   - dagRun               : topological task orchestration
//   - metrics / replay     : observability
//   - inspect / profiles   : AI self-description

import { DshClient, type DshClientOptions } from "./dsh-client.js";
import { DshCluster } from "./dsh-cluster.js";
import { inspect as inspectDsh } from "./discovery.js";
import { dumpProfileConfig, profilePluginAction } from "./profiles.js";
import type {
  DshCapability,
  DshClusterSpec,
  DshClusterStatus,
  DshInspection,
  DshInstanceSpec,
  DshResult,
  DshTask,
  DagSpec,
} from "./types.js";

export interface SeekFleetOptions extends DshClientOptions {}
/** @deprecated Use SeekFleetOptions. */
export type DshPluginOptions = SeekFleetOptions;

export class SeekFleet {
  private readonly opts: SeekFleetOptions;
  private client: DshClient | null = null;
  private clusters = new Map<string, DshCluster>();

  constructor(opts: SeekFleetOptions = {}) {
    this.opts = opts;
  }

  private getClient(): DshClient {
    if (!this.client) this.client = new DshClient(this.opts);
    return this.client;
  }

  capabilities(): DshCapability[] {
    return inspectDsh({ dshModuleRoot: this.opts.dshModuleRoot, dshHome: this.opts.dshHome }).capabilities;
  }
  inspect(): DshInspection {
    return inspectDsh({ dshModuleRoot: this.opts.dshModuleRoot, dshHome: this.opts.dshHome });
  }
  async run(task: DshTask | string): Promise<DshResult> {
    const t: DshTask = typeof task === "string" ? { task } : task;
    return this.getClient().run(t);
  }
  async *stream(task: DshTask | string): AsyncGenerator<import("./types.js").DshEvent> {
    const t: DshTask = typeof task === "string" ? { task } : task;
    yield* this.getClient().stream(t);
  }
  serve(args: { profile?: string; extraArgs?: string[]; cwd?: string; env?: Record<string, string> } = {}) {
    return this.getClient().serve(args);
  }
  async dumpProfile(args: {
    profile: string;
    patches?: string[];
    defaultOnly?: boolean;
  }): Promise<{ yaml: string; stderr: string }> {
    return dumpProfileConfig(this.getClient(), args);
  }
  async profilePlugin(args: { profile: string; action: "add" | "remove" | "why"; pkg: string }) {
    return profilePluginAction(this.getClient(), args);
  }

  cluster(spec: DshClusterSpec, options?: Partial<ConstructorParameters<typeof DshCluster>[0]>): string {
    const id = randomId("cls");
    const cluster = new DshCluster({ ...spec, client: this.opts, ...(options ?? {}) });
    this.clusters.set(id, cluster);
    return id;
  }
  async clusterRoute(clusterId: string, task: DshTask | string) {
    const c = this.clusters.get(clusterId);
    if (!c) throw new Error("cluster not found: " + clusterId);
    const t: DshTask = typeof task === "string" ? { task } : task;
    return c.route(t);
  }
  async *clusterStream(clusterId: string, task: DshTask | string, opts: { record?: { dir: string } } = {}) {
    const c = this.clusters.get(clusterId);
    if (!c) throw new Error("cluster not found: " + clusterId);
    const t: DshTask = typeof task === "string" ? { task } : task;
    yield* c.stream(t, opts);
  }
  clusterStatus(clusterId: string): DshClusterStatus {
    const c = this.clusters.get(clusterId);
    if (!c) throw new Error("cluster not found: " + clusterId);
    return c.status();
  }
  async clusterScale(
    clusterId: string,
    change: { profile?: string; replicas?: number; add?: DshInstanceSpec[]; remove?: string[] },
  ) {
    const c = this.clusters.get(clusterId);
    if (!c) throw new Error("cluster not found: " + clusterId);
    return c.scale(change);
  }
  async clusterDagRun(clusterId: string, spec: DagSpec) {
    const c = this.clusters.get(clusterId);
    if (!c) throw new Error("cluster not found: " + clusterId);
    return c.runDag(spec);
  }
  async clusterShutdown(clusterId: string, timeoutMs?: number) {
    const c = this.clusters.get(clusterId);
    if (!c) throw new Error("cluster not found: " + clusterId);
    await c.shutdown(timeoutMs);
    this.clusters.delete(clusterId);
  }
  /** Access the underlying DshCluster object for advanced use. */
  clusterRaw(clusterId: string): DshCluster | undefined {
    return this.clusters.get(clusterId);
  }
  /** Prometheus-formatted metrics for all clusters. */
  metricsPrometheus(): string {
    let out = "";
    for (const c of this.clusters.values()) out += c.metrics.toPrometheus();
    return out;
  }
  async shutdownAll(): Promise<void> {
    for (const [id, c] of this.clusters) {
      try {
        await c.shutdown();
      } catch {
        /* swallow */
      }
      this.clusters.delete(id);
    }
  }
}

/** @deprecated Use SeekFleet. Kept as a source-compatible alias. */
export { SeekFleet as DshPlugin };

function randomId(prefix: string): string {
  return prefix + "-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
