// session-manager.ts - lifecycle manager for long-running DSH sessions.
//
// Wraps SessionStore (durable) with an in-memory map of live executions
// (AbortController + PID). On startup it scans for "running" sessions and
// marks them as "paused" so the MCP server can rehydrate them safely.

import { resolveDsh } from "./install.js";
import { SessionStore, type SessionRecord, type SessionStatus, type SessionCheckpoint } from "./session.js";
import { PolicyEnforcer, type ExecutionContext } from "./policy-enforcer.js";
import { CostTracker } from "./cost-tracker.js";
import { DshClient, summarize } from "./dsh-client.js";
import type { DshEvent, DshResult, DshTask } from "./types.js";

interface LiveExecution {
  abort: AbortController;
  /** runtime tracker for cost/tokens (so resume can pick up where it left off) */
  cost: CostTracker;
  /** last event seq observed */
  lastSeq: number;
}

export interface SessionManagerOptions {
  /** Path to dsh home (sessions/ subdir is used). */
  dshHome?: string;
  /** Optional policy enforcer applied at start(). */
  policy?: PolicyEnforcer;
  /** Optional runner hook: actually execute a validated task and stream events. */
  runner?: (task: DshTask, ctx: { signal: AbortSignal; onEvent: (e: DshEvent) => void }) => Promise<DshResult>;
}

export interface StartOptions {
  /** Policy enforcement context (tools, network, cost estimate, etc.). */
  ctx?: ExecutionContext;
  /** Tag for filtering sessions. */
  tag?: string;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly live = new Map<string, LiveExecution>();
  private readonly eventBuffers = new Map<string, DshEvent[]>();
  private readonly eventTimers = new Map<string, NodeJS.Timeout>();
  private readonly policy?: PolicyEnforcer;
  private readonly runner: (
    task: DshTask,
    ctx: { signal: AbortSignal; onEvent: (e: DshEvent) => void },
  ) => Promise<DshResult>;

  constructor(opts: SessionManagerOptions = {}) {
    const resolved = resolveDsh({ dshHome: opts.dshHome });
    const { dshHome } = resolved;
    this.store = new SessionStore(dshHome);
    this.policy = opts.policy;
    if (opts.runner) {
      this.runner = opts.runner;
    } else {
      const client = new DshClient({ dshModuleRoot: resolved.moduleRoot, dshHome, policy: this.policy });
      this.runner = async (task, ctx) => {
        const events: DshEvent[] = [];
        let eventCount = 0;
        for await (const event of client.stream({ ...task, signal: ctx.signal })) {
          eventCount++;
          events.push(event);
          if (events.length > 10_000) events.splice(0, events.length - 10_000);
          ctx.onEvent(event);
        }
        const result = summarize(events);
        result.events = eventCount;
        return result;
      };
    }
    this.rehydrate();
  }

  /** PART-3-A: scan for "running" sessions and mark them as "paused" so they can be resumed. */
  private rehydrate(): void {
    const running = this.store.findByStatus("running");
    for (const r of running) {
      this.store.setStatus(r.runId, "paused", { pid: undefined });
    }
  }

  /** Create a new session (status: queued). */
  create(input: { task: string; profile?: string; tags?: string[] }): SessionRecord {
    return this.store.create(input);
  }

  /** Start a queued/paused session. Returns the runId. */
  async start(runId: string, opts: StartOptions = {}): Promise<SessionRecord> {
    const rec = this.store.load(runId);
    if (!rec) throw new Error("session not found: " + runId);
    if (rec.status === "running") throw new Error("session already running: " + runId);
    if (rec.status === "succeeded" || rec.status === "failed" || rec.status === "cancelled") {
      throw new Error("session already terminal: " + runId);
    }

    const task: DshTask = {
      task: rec.task,
      profile: rec.profile,
      tags: rec.tags,
    };

    // PART-3-A: policy gate before we touch anything
    if (this.policy) {
      this.policy.assert(task, opts.ctx ?? {});
    }

    // Mark running + reset startedAt
    const updated = this.store.setStatus(runId, "running");
    if (!updated) throw new Error("session lost mid-start: " + runId);

    const abort = new AbortController();
    const cost = new CostTracker();
    const exec: LiveExecution = { abort, cost, lastSeq: rec.lastSeq };
    this.live.set(runId, exec);

    // Fire-and-forget execution. The session runs in the background.
    void this.runSession(runId, rec, task, abort, cost).catch(() => {
      // runSession handles its own errors; this catch is just to satisfy linter
    });

    return updated;
  }

  private async runSession(
    runId: string,
    rec: SessionRecord,
    task: DshTask,
    abort: AbortController,
    cost: CostTracker,
  ): Promise<void> {
    const start = Date.now();
    let outcome: SessionStatus = "running";
    let finalResult: DshResult | undefined;
    let finalError: { message: string; code?: string } | undefined;

    try {
      const result = await this.runner(task, {
        signal: abort.signal,
        onEvent: (evt) => this.enqueueEvent(runId, evt),
      });
      finalResult = result;
      if (result.usage) {
        cost.record({
          instanceLabel: runId,
          profile: task.profile ?? "headless",
          model: result.usage.model ?? "default",
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          durationMs: result.durationMs,
          ts: Date.now(),
          taskPreview: task.task.slice(0, 80),
        });
      }
      // Record a checkpoint with the final cost summary
      const ckpt: SessionCheckpoint = {
        ts: Date.now(),
        costUsd: cost.totalCost(),
        inputTokens: cost.totalTokens().input,
        outputTokens: cost.totalTokens().output,
        metadata: { status: "succeeded" },
      };
      this.store.addCheckpoint(runId, ckpt);
      outcome = abort.signal.aborted ? "cancelled" : "succeeded";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      finalError = { message };
      const ckpt: SessionCheckpoint = {
        ts: Date.now(),
        costUsd: cost.totalCost(),
        inputTokens: cost.totalTokens().input,
        outputTokens: cost.totalTokens().output,
        metadata: { status: "failed", error: message },
      };
      this.store.addCheckpoint(runId, ckpt);
      outcome = abort.signal.aborted ? "cancelled" : "failed";
    } finally {
      this.flushEvents(runId);
      this.live.delete(runId);
      const patches: Partial<SessionRecord> = {};
      if (finalResult) patches.result = finalResult;
      if (finalError) patches.error = finalError;
      this.store.setStatus(runId, outcome, patches);
      // Emit a single session_done checkpoint with total duration
      this.store.addCheckpoint(runId, {
        ts: Date.now(),
        costUsd: cost.totalCost(),
        inputTokens: cost.totalTokens().input,
        outputTokens: cost.totalTokens().output,
        metadata: { status: outcome, durationMs: Date.now() - start },
      });
    }
  }

  private enqueueEvent(runId: string, event: DshEvent): void {
    const buffer = this.eventBuffers.get(runId) ?? [];
    buffer.push(event);
    this.eventBuffers.set(runId, buffer);
    if (buffer.length >= 100) {
      this.flushEvents(runId);
      return;
    }
    if (!this.eventTimers.has(runId)) {
      const timer = setTimeout(() => this.flushEvents(runId), 100);
      timer.unref?.();
      this.eventTimers.set(runId, timer);
    }
  }

  private flushEvents(runId: string): void {
    const timer = this.eventTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.eventTimers.delete(runId);
    const events = this.eventBuffers.get(runId) ?? [];
    this.eventBuffers.delete(runId);
    if (events.length > 0) this.store.appendEvents(runId, events);
  }

  /** PART-3-A: cancel a running session. */
  cancel(runId: string): SessionRecord | null {
    const record = this.store.load(runId);
    if (!record) return null;
    if (record.status === "succeeded" || record.status === "failed" || record.status === "cancelled") return record;
    const live = this.live.get(runId);
    if (live) {
      live.abort.abort();
      // The runner's signal will trigger; runSession will finalize as cancelled.
    }
    return this.store.setStatus(runId, "cancelled");
  }

  /** Resume a crash-paused session by restarting its idempotent task. */
  async resume(runId: string, opts: StartOptions = {}): Promise<SessionRecord> {
    const rec = this.store.load(runId);
    if (!rec) throw new Error("session not found: " + runId);
    if (rec.status !== "paused") throw new Error("only paused sessions can be resumed: " + runId);
    return this.start(runId, opts);
  }

  /** Get the latest snapshot. */
  status(runId: string): SessionRecord | null {
    return this.store.load(runId);
  }

  /** Get events since the given seq. */
  events(runId: string, sinceSeq = 0, limit = 200): { events: DshEvent[]; lastSeq: number; hasMore: boolean } {
    const rec = this.store.load(runId);
    if (!rec) return { events: [], lastSeq: sinceSeq, hasMore: false };
    const available = rec.events.filter((e) => e.seq > sinceSeq);
    const events = available.slice(0, limit);
    return {
      events,
      lastSeq: events.at(-1)?.seq ?? sinceSeq,
      hasMore: available.length > events.length,
    };
  }

  /** Get the final result if status is succeeded. */
  result(runId: string): { result?: DshResult; error?: { message: string; code?: string } } {
    const rec = this.store.load(runId);
    if (!rec) return {};
    return { result: rec.result, error: rec.error };
  }

  /** List all sessions (most recent first). */
  list(filter?: { status?: SessionStatus }): SessionRecord[] {
    const all = this.store.list();
    if (filter?.status) return all.filter((r) => r.status === filter.status);
    return all;
  }

  /** Delete a session record (and cancel it if running). */
  delete(runId: string): boolean {
    const live = this.live.get(runId);
    if (live) {
      live.abort.abort();
      this.live.delete(runId);
    }
    this.store.delete(runId);
    return true;
  }

  /** Stats: running / queued / paused / terminal counts. */
  stats(): {
    running: number;
    queued: number;
    paused: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    total: number;
  } {
    const all = this.store.list();
    const counts = { running: 0, queued: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0, total: all.length };
    for (const r of all) counts[r.status]++;
    return counts;
  }
}
