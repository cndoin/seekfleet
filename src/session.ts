// session.ts - Persistent task session for long-running DSH tasks.
//
// A Session is a JSON-serializable record of a long-running task. It supports:
//   - status: queued | running | paused | succeeded | failed | cancelled
//   - events: append-only stream of DshEvent (with overflow protection)
//   - checkpoint: arbitrary per-session metadata (input hash, cost so far, file diffs)
//   - cancel / resume: AbortController wired to a PID, with crash recovery on restart
//
// Persisted to $DSH_HOME/sessions/<runId>.json (atomic write).

import { existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DshEvent, DshResult } from "./types.js";
import { withFileLockSync, writeFileAtomicSync } from "./atomic-file.js";

export type SessionStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface SessionCheckpoint {
  /** wall-clock ms since epoch */
  ts: number;
  /** cumulative cost so far in USD */
  costUsd: number;
  /** input tokens so far */
  inputTokens: number;
  /** output tokens so far */
  outputTokens: number;
  /** latest partial answer from the agent (for resume) */
  partialAnswer?: string;
  /** arbitrary metadata (file diffs, tool call list, etc.) */
  metadata?: Record<string, unknown>;
}

export interface SessionRecord {
  runId: string;
  task: string;
  profile?: string;
  tags?: string[];
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** process PID if running */
  pid?: number;
  /** last event seq */
  lastSeq: number;
  /** ring buffer of recent events (size capped) */
  events: DshEvent[];
  /** checkpoints (ordered by ts) */
  checkpoints: SessionCheckpoint[];
  /** final result if status is succeeded */
  result?: DshResult;
  /** error if status is failed */
  error?: { message: string; code?: string };
  /** child session ids (DAG: this session has sub-sessions) */
  childRunIds?: string[];
}

export const MAX_EVENTS_PER_SESSION = 1000;

/**
 * Write coalescing window for high-frequency event appends.
 *
 * Every append used to be a full read-parse-write-plus-fsync of the whole
 * record, so streaming N events cost O(N^2) bytes of disk I/O and blocked the
 * event loop (1500 appends took >30s on Windows). Appends are now accumulated
 * in memory and flushed at most once per window; lifecycle changes
 * (create / setStatus / addCheckpoint) still write synchronously so crash
 * recovery always sees a consistent status.
 */
const DEFAULT_FLUSH_DELAY_MS = 50;

export interface SessionStoreOptions {
  /** Coalescing window in ms for appendEvents. 0 writes synchronously. */
  flushDelayMs?: number;
}

export class SessionStore {
  private readonly dir: string;
  /** Authoritative in-process copy; avoids re-reading the file on every call. */
  private readonly cache = new Map<string, SessionRecord>();
  /** Records whose in-memory state is newer than what is on disk. */
  private readonly dirty = new Set<string>();
  private flushTimer?: NodeJS.Timeout;
  private readonly flushDelayMs: number;

  constructor(dshHome: string, opts: SessionStoreOptions = {}) {
    this.dir = join(dshHome, "sessions");
    mkdirSync(this.dir, { recursive: true });
    this.flushDelayMs = opts.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  }

  private pathFor(runId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId) || runId.includes("..")) {
      throw new Error("invalid session runId");
    }
    return join(this.dir, runId + ".json");
  }

  create(input: { task: string; profile?: string; tags?: string[] }): SessionRecord {
    const now = Date.now();
    const rec: SessionRecord = {
      runId: randomUUID(),
      task: input.task,
      profile: input.profile,
      tags: input.tags,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      events: [],
      checkpoints: [],
    };
    this.save(rec);
    return rec;
  }

  load(runId: string): SessionRecord | null {
    let path: string;
    try {
      path = this.pathFor(runId);
    } catch {
      return null;
    }
    const cached = this.cache.get(runId);
    if (cached) return cached;
    try {
      if (!existsSync(path)) return null;
      const rec = JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
      this.cache.set(runId, rec);
      return rec;
    } catch {
      return null;
    }
  }

  /** Persist a record durably right now (atomic replace + fsync). */
  save(rec: SessionRecord): void {
    this.dirty.delete(rec.runId);
    this.cache.set(rec.runId, rec);
    writeFileAtomicSync(this.pathFor(rec.runId), JSON.stringify(rec));
  }

  /** Persist a record, letting the coalescing window absorb bursts. */
  private saveDeferred(rec: SessionRecord): void {
    this.cache.set(rec.runId, rec);
    this.dirty.add(rec.runId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined || this.dirty.size === 0) return;
    if (this.flushDelayMs <= 0) {
      this.flushDirty();
      return;
    }
    const timer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushDirty();
    }, this.flushDelayMs);
    // A pending flush must never keep the host process alive.
    timer.unref?.();
    this.flushTimer = timer;
  }

  /** Write every pending record immediately. Safe to call at any time. */
  flush(): void {
    this.flushDirty();
  }

  private flushDirty(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty.size === 0) return;
    // If the directory vanished (test teardown, manual cleanup) there is nothing
    // meaningful to persist, and recreating it would resurrect deleted state.
    if (!existsSync(this.dir)) {
      this.dirty.clear();
      return;
    }
    for (const runId of Array.from(this.dirty)) {
      this.dirty.delete(runId);
      const rec = this.cache.get(runId);
      if (!rec) continue;
      try {
        writeFileAtomicSync(this.pathFor(runId), JSON.stringify(rec));
      } catch {
        /* best effort: the next append re-schedules the write */
      }
    }
  }

  private patchInternal(
    runId: string,
    patch: (rec: SessionRecord) => SessionRecord,
    deferred: boolean,
  ): SessionRecord | null {
    let path: string;
    try {
      path = this.pathFor(runId);
    } catch {
      return null;
    }
    return withFileLockSync(path + ".lock", () => {
      const rec = this.load(runId);
      if (!rec) return null;
      const updated = patch({ ...rec });
      updated.updatedAt = Date.now();
      if (deferred) this.saveDeferred(updated);
      else this.save(updated);
      return updated;
    });
  }

  patch(runId: string, patch: (rec: SessionRecord) => SessionRecord): SessionRecord | null {
    return this.patchInternal(runId, patch, false);
  }

  /** Append an event to the session. Bounded by MAX_EVENTS_PER_SESSION (FIFO drop). */
  appendEvent(runId: string, evt: DshEvent): SessionRecord | null {
    return this.appendEvents(runId, [evt]);
  }

  /** Append a batch with one atomic file replacement. */
  appendEvents(runId: string, events: DshEvent[]): SessionRecord | null {
    if (events.length === 0) return this.load(runId);
    return this.patchInternal(
      runId,
      (rec) => {
        rec.events.push(...events);
        if (rec.events.length > MAX_EVENTS_PER_SESSION) {
          rec.events.splice(0, rec.events.length - MAX_EVENTS_PER_SESSION);
        }
        for (const evt of events) {
          if (typeof evt.seq === "number" && evt.seq > rec.lastSeq) rec.lastSeq = evt.seq;
        }
        return rec;
      },
      true,
    );
  }

  /** Update status atomically. */
  setStatus(runId: string, status: SessionStatus, extras?: Partial<SessionRecord>): SessionRecord | null {
    return this.patch(runId, (rec) => {
      rec.status = status;
      if (status === "running" && !rec.startedAt) rec.startedAt = Date.now();
      if (status === "succeeded" || status === "failed" || status === "cancelled") {
        rec.finishedAt = Date.now();
      }
      if (extras) Object.assign(rec, extras);
      return rec;
    });
  }

  /** Add a checkpoint. */
  addCheckpoint(runId: string, ckpt: SessionCheckpoint): SessionRecord | null {
    return this.patch(runId, (rec) => {
      rec.checkpoints.push(ckpt);
      return rec;
    });
  }

  /** List all sessions (most recent first). */
  list(): SessionRecord[] {
    // Flush first so the on-disk view matches the in-memory view.
    this.flushDirty();
    if (!existsSync(this.dir)) return [];
    const out: SessionRecord[] = [];
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith(".json")) continue;
      const runId = entry.slice(0, -".json".length);
      // Live records win over the file; unknown records are parsed but not
      // cached, so listing thousands of sessions cannot grow memory.
      const cached = this.cache.get(runId);
      if (cached) {
        out.push(cached);
        continue;
      }
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, entry), "utf8")) as SessionRecord);
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Find sessions in a given status. */
  findByStatus(status: SessionStatus): SessionRecord[] {
    return this.list().filter((r) => r.status === status);
  }

  /** Delete a session record. */
  delete(runId: string): void {
    try {
      const path = this.pathFor(runId);
      this.cache.delete(runId);
      this.dirty.delete(runId);
      withFileLockSync(path + ".lock", () => {
        try {
          unlinkSync(path);
        } catch {
          /* already absent */
        }
      });
    } catch {
      /* invalid id or unavailable lock */
    }
  }
}
