// result-cache.ts - task-level result memoization.
//
// Caches DshResult by a key derived from (profile, task, tags, env-hash).
// Persists to $DSH_HOME/cache/results.jsonl (one record per line, JSON).
// TTL is per-entry. Cache is checked first; on hit, the cached result is
// returned immediately with `cached: true` and a `cacheAgeMs`.
//
// Future: add semantic similarity (embedding-based) lookup.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { DshResult, DshTask } from "./types.js";

export interface CacheEntry {
  key: string;
  profile: string;
  task: string;
  tags: string[];
  envHash: string;
  /** P0-9: additional fingerprint components so cache invalidates when context changes. */
  cwd: string;
  patchesHash: string;
  model: string;
  dshVersion: string;
  profileHash: string;
  result: DshResult;
  createdAt: number;
  expiresAt: number;
  hitCount: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  hitRatio: number;
  oldestEntryAt?: number;
  newestEntryAt?: number;
}

export interface CacheOptions {
  cacheDir: string;
  defaultTtlMs?: number;
  maxEntries?: number;
  /** Per-profile TTL overrides. */
  ttlByProfile?: Record<string, number>;
}

function hashKey(parts: {
  profile: string;
  task: string;
  tags: string[];
  envHash: string;
  cwd: string;
  patchesHash: string;
  model: string;
  dshVersion: string;
  profileHash: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        parts.profile,
        parts.task,
        parts.tags.slice().sort(),
        parts.envHash,
        parts.cwd,
        parts.patchesHash,
        parts.model,
        parts.dshVersion,
        parts.profileHash,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

function hashEnv(env: Record<string, string> | undefined): string {
  if (!env) return "";
  const sorted = Object.keys(env)
    .sort()
    .map((k) => k + "=" + env[k])
    .join(";");
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

export class ResultCache {
  private readonly cacheFile: string;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly ttlByProfile: Record<string, number>;
  private entries = new Map<string, CacheEntry>();
  /** P1-7: single-flight: in-flight fetches deduped across concurrent calls. */
  private inFlight = new Map<string, Promise<{ entry: CacheEntry; ageMs: number } | null>>();
  private loaded = false;
  stats_ = { hits: 0, misses: 0, writes: 0, evictions: 0 };

  constructor(opts: CacheOptions) {
    mkdirSync(opts.cacheDir, { recursive: true });
    this.cacheFile = join(opts.cacheDir, "results.jsonl");
    this.defaultTtlMs = opts.defaultTtlMs ?? 60 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.ttlByProfile = opts.ttlByProfile ?? {};
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.cacheFile)) return;
    try {
      const lines = readFileSync(this.cacheFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as CacheEntry;
          this.entries.set(entry.key, entry);
        } catch {
          /* skip corrupted */
        }
      }
    } catch {
      /* swallow */
    }
  }

  private persistEntry(entry: CacheEntry): void {
    try {
      appendFileSync(this.cacheFile, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      /* best-effort */
    }
  }

  private evictExpired(now: number): void {
    let evicted = 0;
    for (const [k, e] of this.entries) {
      if (e.expiresAt < now) {
        this.entries.delete(k);
        evicted++;
      }
    }
    this.stats_.evictions += evicted;
  }

  private evictOldestIfFull(): void {
    if (this.entries.size <= this.maxEntries) return;
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, e] of this.entries) {
      if (e.createdAt < oldestAt) {
        oldestAt = e.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      this.entries.delete(oldestKey);
      this.stats_.evictions++;
    }
  }

  /** Compute the cache key for a task (P0-9: includes cwd, patches, model, dsh version, profile hash). */
  keyFor(
    task: DshTask,
    profile: string,
    extras: { cwd?: string; patches?: string[]; model?: string; dshVersion?: string; profileHash?: string } = {},
  ): string {
    return hashKey({
      profile,
      task: task.task.trim(),
      tags: task.tags ?? [],
      envHash: hashEnv(task.env),
      cwd: extras.cwd ?? "",
      patchesHash: hashEnv(
        Object.fromEntries(
          (extras.patches ?? [])
            .slice()
            .sort()
            .map((p) => [p, p]),
        ),
      ),
      model: extras.model ?? "",
      dshVersion: extras.dshVersion ?? "",
      profileHash: extras.profileHash ?? "",
    });
  }

  /** Lookup; returns the cached entry if fresh, else null. */
  get(
    task: DshTask,
    profile: string,
    extras: { cwd?: string; patches?: string[]; model?: string; dshVersion?: string; profileHash?: string } = {},
  ): { entry: CacheEntry; ageMs: number } | null {
    this.ensureLoaded();
    this.evictExpired(Date.now());
    const key = this.keyFor(task, profile, extras);
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats_.misses++;
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.stats_.misses++;
      return null;
    }
    entry.hitCount++;
    this.stats_.hits++;
    return { entry, ageMs: Date.now() - entry.createdAt };
  }

  /** Store a result. */
  set(
    task: DshTask,
    profile: string,
    result: DshResult,
    ttlMs?: number,
    extras: { cwd?: string; patches?: string[]; model?: string; dshVersion?: string; profileHash?: string } = {},
  ): CacheEntry {
    this.ensureLoaded();
    const key = this.keyFor(task, profile, extras);
    const now = Date.now();
    const ttl = ttlMs ?? this.ttlByProfile[profile] ?? this.defaultTtlMs;
    const entry: CacheEntry = {
      key,
      profile,
      task: task.task.trim(),
      tags: task.tags ?? [],
      envHash: hashEnv(task.env),
      cwd: extras.cwd ?? "",
      patchesHash: hashEnv(
        Object.fromEntries(
          (extras.patches ?? [])
            .slice()
            .sort()
            .map((p) => [p, p]),
        ),
      ),
      model: extras.model ?? "",
      dshVersion: extras.dshVersion ?? "",
      profileHash: extras.profileHash ?? "",
      result,
      createdAt: now,
      expiresAt: now + ttl,
      hitCount: 0,
    };
    this.entries.set(key, entry);
    this.persistEntry(entry);
    this.stats_.writes++;
    this.evictOldestIfFull();
    return entry;
  }

  /** Invalidate all entries for a profile. */
  invalidateProfile(profile: string): number {
    let count = 0;
    for (const [k, e] of this.entries) {
      if (e.profile === profile) {
        this.entries.delete(k);
        count++;
      }
    }
    this.stats_.evictions += count;
    return count;
  }

  /**
   * P1-7: get-or-compute semantics. If the key is cached, return the entry. If
   * not cached AND another caller is already computing, await their result. If
   * not cached AND no one is computing, run compute(), cache the result, return.
   * Single-flight is per-key and bounded to a max wait time.
   */
  async getOrCompute(
    task: import("./types.js").DshTask,
    profile: string,
    compute: () => Promise<DshResult>,
    extras: { cwd?: string; patches?: string[]; model?: string; dshVersion?: string; profileHash?: string } = {},
    timeoutMs = 60_000,
  ): Promise<{ entry: CacheEntry; ageMs: number; computed: boolean }> {
    this.ensureLoaded();
    this.evictExpired(Date.now());
    const key = this.keyFor(task, profile, extras);
    // 1. Hit
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt >= Date.now()) {
      existing.hitCount++;
      this.stats_.hits++;
      return { entry: existing, ageMs: Date.now() - existing.createdAt, computed: false };
    }
    this.stats_.misses++;
    // 2. Someone else is computing - wait
    const inflight = this.inFlight.get(key);
    if (inflight) {
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("single-flight timeout")), timeoutMs),
      );
      const r = await Promise.race([inflight, timeout]);
      if (!r) throw new Error("single-flight: null result");
      return { entry: r.entry, ageMs: r.ageMs, computed: false };
    }
    // 3. We are the leader - compute and cache
    const p = (async () => {
      const result = await compute();
      this.set(task, profile, result, undefined, extras);
      const fresh = this.entries.get(key)!;
      return { entry: fresh, ageMs: 0 };
    })() as Promise<{ entry: CacheEntry; ageMs: number }>;
    this.inFlight.set(key, p);
    try {
      const r = await p;
      return { entry: r.entry, ageMs: r.ageMs, computed: true };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Invalidate entries matching a tag prefix. */
  invalidateByTag(prefix: string): number {
    let count = 0;
    for (const [k, e] of this.entries) {
      if (e.tags.some((t) => t.startsWith(prefix))) {
        this.entries.delete(k);
        count++;
      }
    }
    this.stats_.evictions += count;
    return count;
  }

  /** Clear everything. */
  clear(): void {
    const size = this.entries.size;
    this.entries.clear();
    this.stats_.evictions += size;
  }

  stats(): CacheStats {
    this.ensureLoaded();
    const total = this.stats_.hits + this.stats_.misses;
    let oldest: number | undefined;
    let newest: number | undefined;
    for (const e of this.entries.values()) {
      if (oldest === undefined || e.createdAt < oldest) oldest = e.createdAt;
      if (newest === undefined || e.createdAt > newest) newest = e.createdAt;
    }
    return {
      size: this.entries.size,
      hits: this.stats_.hits,
      misses: this.stats_.misses,
      writes: this.stats_.writes,
      evictions: this.stats_.evictions,
      hitRatio: total === 0 ? 0 : this.stats_.hits / total,
      oldestEntryAt: oldest,
      newestEntryAt: newest,
    };
  }
}
