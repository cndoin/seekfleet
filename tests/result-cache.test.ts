import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
});
