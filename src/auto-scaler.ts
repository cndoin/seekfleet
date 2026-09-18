// auto-scaler.ts - queue-depth driven cluster scaling.
//
// Tracks in-flight tasks per profile and observes queue depth. When the queue
// depth exceeds `scaleUpThreshold` for `scaleUpAfterMs`, the scaler calls the
// user-provided `spawn(profile)` hook to add instances. When in-flight stays
// below `scaleDownThreshold` for `scaleDownAfterMs`, idle instances are removed
// via the `despawn(label)` hook.
//
// Safe-by-default: never scales above `maxReplicas` or below `minReplicas`.

export interface AutoScalerSpec {
  profile: string;
  minReplicas: number;
  maxReplicas: number;
  scaleUpThreshold: number; // queue depth that triggers scale up
  scaleUpAfterMs: number; // sustained duration before triggering
  scaleDownThreshold: number; // queue depth below which we scale down
  scaleDownAfterMs: number; // sustained duration before scaling down
  pollIntervalMs?: number; // default 5000
  cooldownMs?: number; // min time between any two scaling actions, default 30000
}

export interface ScalingEvent {
  ts: number;
  profile: string;
  action: "up" | "down" | "noop";
  reason: string;
  replicasBefore: number;
  replicasAfter: number;
}

/**
 * 扩缩容事件的留存上限。
 *
 * 自动扩缩容是常驻后台任务（默认每 5 秒一个 tick），每条事件还带着 reason 字符串。
 * 不封顶的话，一个跑几天的集群就是一条稳定向上的内存曲线。
 */
const MAX_SCALING_EVENTS = 500;

export type SpawnFn = (profile: string) => Promise<void>;
export type DespawnFn = (label: string) => Promise<void>;
export type QueueDepthFn = (profile: string) => number;
export type ReplicaListFn = (profile: string) => string[];

export class AutoScaler {
  readonly spec: AutoScalerSpec;
  /**
   * 扩缩容事件历史。
   *
   * 这是**有上限的最近记录**，不是完整历史：紧密耦合的用例是「最近为什么扩容了」，
   * 没有谁会去读三周前某次 scale down 的 reason。
   */
  readonly events: ScalingEvent[] = [];
  private lastActionAt = 0;
  private lastObservedQueueDepth = 0;
  private queueAboveSince?: number;
  private queueBelowSince?: number;
  private timer?: NodeJS.Timeout;
  private readonly spawnFn: SpawnFn;
  private readonly despawnFn: DespawnFn;
  private readonly queueDepthFn: QueueDepthFn;
  private readonly replicaListFn: ReplicaListFn;

  constructor(
    spec: AutoScalerSpec,
    hooks: { spawn: SpawnFn; despawn: DespawnFn; queueDepth: QueueDepthFn; replicas: ReplicaListFn },
  ) {
    this.spec = spec;
    this.spawnFn = hooks.spawn;
    this.despawnFn = hooks.despawn;
    this.queueDepthFn = hooks.queueDepth;
    this.replicaListFn = hooks.replicas;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.spec.pollIntervalMs ?? 5000;
    this.timer = setInterval(() => this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private recordEvent(evt: ScalingEvent): void {
    this.events.push(evt);
    if (this.events.length > MAX_SCALING_EVENTS) this.events.splice(0, this.events.length - MAX_SCALING_EVENTS);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const cooldownMs = this.spec.cooldownMs ?? 30000;
    if (now - this.lastActionAt < cooldownMs) return;
    const depth = this.queueDepthFn(this.spec.profile);
    this.lastObservedQueueDepth = depth;
    const replicas = this.replicaListFn(this.spec.profile);
    const n = replicas.length;

    // scale up
    if (depth >= this.spec.scaleUpThreshold && n < this.spec.maxReplicas) {
      if (!this.queueAboveSince) this.queueAboveSince = now;
      this.queueBelowSince = undefined;
      if (now - this.queueAboveSince >= this.spec.scaleUpAfterMs) {
        await this.scaleUp(n);
        this.queueAboveSince = undefined;
      }
      return;
    }

    // scale down
    if (depth <= this.spec.scaleDownThreshold && n > this.spec.minReplicas) {
      if (!this.queueBelowSince) this.queueBelowSince = now;
      this.queueAboveSince = undefined;
      if (now - this.queueBelowSince >= this.spec.scaleDownAfterMs) {
        await this.scaleDown(replicas, n);
        this.queueBelowSince = undefined;
      }
      return;
    }

    // stable
    this.queueAboveSince = undefined;
    this.queueBelowSince = undefined;
  }

  private async scaleUp(nBefore: number): Promise<void> {
    try {
      await this.spawnFn(this.spec.profile);
      this.lastActionAt = Date.now();
      this.recordEvent({
        ts: this.lastActionAt,
        profile: this.spec.profile,
        action: "up",
        reason: "queue depth >= threshold",
        replicasBefore: nBefore,
        replicasAfter: nBefore + 1,
      });
    } catch (e) {
      this.recordEvent({
        ts: Date.now(),
        profile: this.spec.profile,
        action: "noop",
        reason: "spawn failed: " + (e instanceof Error ? e.message : String(e)),
        replicasBefore: nBefore,
        replicasAfter: nBefore,
      });
    }
  }

  private async scaleDown(replicas: string[], nBefore: number): Promise<void> {
    // Remove the most-recently-created replica (the one least likely to have in-flight work).
    const victim = replicas[replicas.length - 1];
    if (!victim) return;
    try {
      await this.despawnFn(victim);
      this.lastActionAt = Date.now();
      this.recordEvent({
        ts: this.lastActionAt,
        profile: this.spec.profile,
        action: "down",
        reason: "queue depth <= threshold",
        replicasBefore: nBefore,
        replicasAfter: nBefore - 1,
      });
    } catch (e) {
      this.recordEvent({
        ts: Date.now(),
        profile: this.spec.profile,
        action: "noop",
        reason: "despawn failed: " + (e instanceof Error ? e.message : String(e)),
        replicasBefore: nBefore,
        replicasAfter: nBefore,
      });
    }
  }
}
