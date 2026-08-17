// workspace-sync.ts - share workspace files between instances.
//
// When an instance writes a file in the workspace, the change is recorded in
// a shared change log ($DSH_HOME/workspace-log.jsonl). Other instances poll
// this log on a timer and pull changed files into their own working copy.
//
// Designed for small/medium workspaces (KB-scale files, not GB-scale datasets).
// For large data, use a real distributed filesystem or object store.

import { existsSync, readFileSync, appendFileSync, mkdirSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { hasParentTraversal, resolveInside } from "./platform-path.js";

export type ChangeKind = "add" | "change" | "unlink";

export interface ChangeRecord {
  ts: number;
  instanceLabel: string;
  kind: ChangeKind;
  relPath: string;
  /** SHA256 of file contents (for change/add) */
  hash?: string;
  size?: number;
}

export interface SyncOptions {
  dshHome: string;
  workspace: string;
  instanceLabel: string;
  /** files / globs to ignore */
  ignore?: (relPath: string) => boolean;
  /** max file size to share (default 1 MiB) */
  maxFileSize?: number;
  /** poll interval for remote changes (default 2000ms) */
  pollIntervalMs?: number;
}

export interface SyncStats {
  localChanges: number;
  remoteChanges: number;
  filesShared: number;
  bytesShared: number;
  conflicts: number;
  ignored: number;
  lastSyncAt?: number;
  lastRemoteCursor: number;
}

function hashFile(path: string): { hash: string; size: number } {
  const buf = readFileSync(path);
  return {
    hash: createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
  };
}

export class WorkspaceSync {
  readonly opts: Required<SyncOptions>;
  private cursor = 0;
  private watcher?: { close: () => void };
  private timer?: NodeJS.Timeout;
  private stats_ = { localChanges: 0, remoteChanges: 0, filesShared: 0, bytesShared: 0, conflicts: 0, ignored: 0 };
  private lastSyncAt?: number;
  /** listeners for local change events */
  private localListeners: Array<(rec: ChangeRecord) => void> = [];
  /** listeners for remote change events */
  private remoteListeners: Array<(rec: ChangeRecord) => void> = [];

  constructor(opts: SyncOptions) {
    this.opts = {
      dshHome: resolve(opts.dshHome),
      workspace: resolve(opts.workspace),
      instanceLabel: opts.instanceLabel,
      ignore: opts.ignore ?? (() => false),
      maxFileSize: opts.maxFileSize ?? 1024 * 1024,
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
    };
    mkdirSync(opts.workspace, { recursive: true });
    mkdirSync(this.logsDir(), { recursive: true });
    this.cursor = this.readLastCursor();
  }

  private logsDir(): string {
    return join(this.opts.dshHome, "workspace-logs");
  }
  private logFile(): string {
    return join(this.logsDir(), "changes.jsonl");
  }
  private instanceLogFile(): string {
    return join(this.logsDir(), this.opts.instanceLabel + ".jsonl");
  }

  private readLastCursor(): number {
    if (!existsSync(this.logFile())) return 0;
    const lines = readFileSync(this.logFile(), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    return lines.length;
  }

  /** Manually record a change (called by chokidar / fs.watch wrapper). */
  recordChange(kind: ChangeKind, absPath: string): ChangeRecord | null {
    const rel = relative(this.opts.workspace, absPath);
    if (rel === "" || isAbsolute(rel) || hasParentTraversal(rel)) return null;
    if (this.opts.ignore(rel)) {
      this.stats_.ignored++;
      return null;
    }
    let hash: string | undefined;
    let size: number | undefined;
    if (kind !== "unlink") {
      try {
        const st = statSync(absPath);
        if (!st.isFile()) return null;
        if (st.size > this.opts.maxFileSize) {
          this.stats_.ignored++;
          return null;
        }
        size = st.size;
        const h = hashFile(absPath);
        hash = h.hash;
      } catch {
        return null;
      }
    }
    const rec: ChangeRecord = {
      ts: Date.now(),
      instanceLabel: this.opts.instanceLabel,
      kind,
      relPath: rel,
      hash,
      size,
    };
    appendFileSync(this.logFile(), JSON.stringify(rec) + "\n", "utf8");
    appendFileSync(this.instanceLogFile(), JSON.stringify(rec) + "\n", "utf8");
    this.stats_.localChanges++;
    for (const fn of this.localListeners) fn(rec);
    return rec;
  }

  /** Subscribe to local-change events. */
  onLocalChange(fn: (rec: ChangeRecord) => void): void {
    this.localListeners.push(fn);
  }
  onRemoteChange(fn: (rec: ChangeRecord) => void): void {
    this.remoteListeners.push(fn);
  }

  /** Poll the shared change log for new entries and apply remote changes. */
  syncOnce(): ChangeRecord[] {
    if (!existsSync(this.logFile())) return [];
    const lines = readFileSync(this.logFile(), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const applied: ChangeRecord[] = [];
    for (let i = this.cursor; i < lines.length; i++) {
      try {
        const rec = JSON.parse(lines[i]!) as ChangeRecord;
        if (rec.instanceLabel === this.opts.instanceLabel) continue; // skip own writes
        if (this.opts.ignore(rec.relPath)) continue;
        this.applyRemoteChange(rec);
        applied.push(rec);
        for (const fn of this.remoteListeners) fn(rec);
      } catch {
        /* skip corrupted lines */
      }
    }
    this.cursor = lines.length;
    this.lastSyncAt = Date.now();
    if (applied.length > 0) this.stats_.remoteChanges += applied.length;
    return applied;
  }

  private applyRemoteChange(rec: ChangeRecord): void {
    const target = resolveInside(this.opts.workspace, rec.relPath);
    if (!target) {
      this.stats_.ignored++;
      return;
    }
    if (rec.kind === "unlink") {
      try {
        unlinkSync(target);
      } catch {
        /* may already be gone */
      }
      return;
    }
    // const src = join(this.opts.workspace, rec.relPath); // reserved for future blob wiring
    const payload = join(this.opts.dshHome, "workspace-blobs", rec.hash ?? "unknown");
    if (!existsSync(payload)) {
      // Without a content-addressed blob store we can't actually copy.
      // We mark a conflict so the user knows to wire in a real sync backend.
      this.stats_.conflicts++;
      return;
    }
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(payload, target);
    this.stats_.filesShared++;
    if (rec.size) this.stats_.bytesShared += rec.size;
  }

  /** Start polling for remote changes. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.syncOnce(), this.opts.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.watcher?.close();
  }

  stats(): SyncStats {
    return { ...this.stats_, lastSyncAt: this.lastSyncAt, lastRemoteCursor: this.cursor };
  }
}
