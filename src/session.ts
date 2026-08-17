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

export class SessionStore {
  private readonly dir: string;

  constructor(dshHome: string) {
    this.dir = join(dshHome, "sessions");
    mkdirSync(this.dir, { recursive: true });
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
    try {
      const path = this.pathFor(runId);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
    } catch {
      return null;
    }
  }

  save(rec: SessionRecord): void {
    writeFileAtomicSync(this.pathFor(rec.runId), JSON.stringify(rec, null, 2));
  }

  patch(runId: string, patch: (rec: SessionRecord) => SessionRecord): SessionRecord | null {
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
      this.save(updated);
      return updated;
    });
  }

  /** Append an event to the session. Bounded by MAX_EVENTS_PER_SESSION (FIFO drop). */
  appendEvent(runId: string, evt: DshEvent): SessionRecord | null {
    return this.appendEvents(runId, [evt]);
  }

  /** Append a batch with one atomic file replacement. */
  appendEvents(runId: string, events: DshEvent[]): SessionRecord | null {
    if (events.length === 0) return this.load(runId);
    return this.patch(runId, (rec) => {
      rec.events.push(...events);
      if (rec.events.length > MAX_EVENTS_PER_SESSION) {
        rec.events.splice(0, rec.events.length - MAX_EVENTS_PER_SESSION);
      }
      for (const evt of events) {
        if (typeof evt.seq === "number" && evt.seq > rec.lastSeq) rec.lastSeq = evt.seq;
      }
      return rec;
    });
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
    if (!existsSync(this.dir)) return [];
    // readdirSync imported at top
    const out: SessionRecord[] = [];
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.dir, entry), "utf8")) as SessionRecord;
        out.push(rec);
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
