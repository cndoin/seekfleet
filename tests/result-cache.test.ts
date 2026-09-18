import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultCache } from "../src/result-cache.js";
import type { DshTask, DshResult } from "../src/types.js";

describe("ResultCache", () => {
  let dir: string;
  let cache: ResultCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-test-"));
    cache = new ResultCache({ cacheDir: dir, defaultTtlMs: 60000 });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("miss on empty cache", () => {
    const r = cache.get({ task: "x" }, "headless");
    expect(r).toBeNull();
    expect(cache.stats().misses).toBe(1);
  });

  it("hit after set", () => {
    const task: DshTask = { task: "x" };
    const result: DshResult = {
      answer: "y",
      toolCalls: [],
      toolResults: [],
      events: 1,
      durationMs: 100,
      exitCode: 0,
      stderrTail: "",
    };
    cache.set(task, "headless", result);
    const r = cache.get(task, "headless");
    expect(r).not.toBeNull();
    expect(r!.entry.result.answer).toBe("y");
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().hitRatio).toBeGreaterThan(0);
  });

  it("different profiles cache separately", () => {
    const task: DshTask = { task: "x" };
    const r1: DshResult = {
      answer: "a",
      toolCalls: [],
      toolResults: [],
      events: 1,
      durationMs: 1,
      exitCode: 0,
      stderrTail: "",
    };
    cache.set(task, "headless", r1);
    expect(cache.get(task, "web")).toBeNull();
  });

  it("respects TTL", async () => {
    const c2 = new ResultCache({ cacheDir: dir, defaultTtlMs: 50 });
    c2.set({ task: "x" }, "headless", {
      answer: "y",
      toolCalls: [],
      toolResults: [],
      events: 1,
      durationMs: 1,
      exitCode: 0,
      stderrTail: "",
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(c2.get({ task: "x" }, "headless")).toBeNull();
  });

  it("keyFor is stable for same input", () => {
    const k1 = cache.keyFor({ task: "x", tags: ["a"] }, "headless");
    const k2 = cache.keyFor({ task: "x", tags: ["a"] }, "headless");
    expect(k1).toBe(k2);
  });

  it("invalidates by profile", () => {
    cache.set({ task: "x" }, "headless", {
      answer: "y",
      toolCalls: [],
      toolResults: [],
      events: 1,
      durationMs: 1,
      exitCode: 0,
      stderrTail: "",
    });
    expect(cache.invalidateProfile("headless")).toBe(1);
    expect(cache.get({ task: "x" }, "headless")).toBeNull();
  });

  it("clears the persistent log, not only memory", () => {
    const result: DshResult = {
      answer: "y",
      toolCalls: [],
      toolResults: [],
      events: 1,
      durationMs: 1,
      exitCode: 0,
      stderrTail: "",
    };
    cache.set({ task: "x" }, "headless", result);
    cache.clear();
    // The log is replayed on startup, so an in-memory-only clear used to
    // resurrect every cleared entry in the next process.
    const restarted = new ResultCache({ cacheDir: dir, defaultTtlMs: 60000 });
    expect(restarted.stats().size).toBe(0);
    expect(restarted.get({ task: "x" }, "headless")).toBeNull();
  });

  it("persists invalidation across a restart", () => {
    const result: DshResult = {
      answer: "y",
      toolCalls: [],
      toolResults: [],
      events: 1,
      durationMs: 1,
      exitCode: 0,
      stderrTail: "",
    };
    for (let i = 0; i < 100; i++) cache.set({ task: "t" + i }, "headless", result);
    expect(cache.invalidateProfile("headless")).toBe(100);
    const restarted = new ResultCache({ cacheDir: dir, defaultTtlMs: 60000 });
    expect(restarted.stats().size).toBe(0);
  });

  it("bounds the append-only log instead of growing forever", () => {
    const result: DshResult = {
      answer: "y",
      toolCalls: [],
      toolResults: [],
      events: 1,
      durationMs: 1,
      exitCode: 0,
      stderrTail: "",
    };
    // Repeatedly fill and invalidate: without compaction the file would keep
    // every historical line and never shrink.
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 100; i++) cache.set({ task: `r${round}-${i}` }, "headless", result);
      cache.invalidateProfile("headless");
    }
    const raw = readFileSync(join(dir, "results.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(100);
  });
});
