import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultCache } from "../src/result-cache.js";
import type { DshTask, DshResult } from "../src/types.js";

const makeRes = (answer: string): DshResult => ({
  answer,
  toolCalls: [],
  toolResults: [],
  events: 1,
  durationMs: 1,
  exitCode: 0,
  stderrTail: "",
});

describe("ResultCache single-flight", () => {
  let dir: string;
  let cache: ResultCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-sf-"));
    cache = new ResultCache({ cacheDir: dir, defaultTtlMs: 60_000 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("dedups concurrent compute for the same key", async () => {
    const task: DshTask = { task: "x" };
    let computeCalls = 0;
    const [a, b, c] = await Promise.all([
      cache.getOrCompute(task, "headless", async () => {
        computeCalls++;
        await new Promise((r) => setTimeout(r, 50));
        return makeRes("first");
      }),
      cache.getOrCompute(task, "headless", async () => {
        computeCalls++;
        return makeRes("second");
      }),
      cache.getOrCompute(task, "headless", async () => {
        computeCalls++;
        return makeRes("third");
      }),
    ]);
    expect(computeCalls).toBe(1);
    expect(a.entry.result.answer).toBe("first");
    expect(b.entry.result.answer).toBe("first");
    expect(c.entry.result.answer).toBe("first");
  });

  it("subsequent calls hit cache without re-computing", async () => {
    const task: DshTask = { task: "y" };
    let calls = 0;
    await cache.getOrCompute(task, "headless", async () => {
      calls++;
      return makeRes("only");
    });
    const second = await cache.getOrCompute(task, "headless", async () => {
      calls++;
      return makeRes("never");
    });
    expect(calls).toBe(1);
    expect(second.computed).toBe(false);
    expect(second.entry.result.answer).toBe("only");
  });

  it("different keys are computed independently", async () => {
    let calls = 0;
    await Promise.all([
      cache.getOrCompute({ task: "k1" }, "headless", async () => {
        calls++;
        return makeRes("a");
      }),
      cache.getOrCompute({ task: "k2" }, "headless", async () => {
        calls++;
        return makeRes("b");
      }),
    ]);
    expect(calls).toBe(2);
  });
});
