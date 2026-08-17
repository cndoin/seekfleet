import { describe, it, expect } from "vitest";
import { AdaptiveRouter } from "../src/adaptive-router.js";
import type { DshInstanceSpec, DshInstanceStatus } from "../src/types.js";

const makeInstance = (
  label: string,
  tags: string[] = [],
  state: DshInstanceStatus["state"] = "ready",
  inFlight = 0,
  concurrency = 1,
): DshInstanceStatus & { spec: DshInstanceSpec } => ({
  label,
  profile: "headless",
  state,
  inFlight,
  concurrency,
  tags,
  totalRun: 0,
  totalErrors: 0,
  lastActivityTs: 0,
  startedAt: 0,
});

describe("AdaptiveRouter", () => {
  it("picks ready instance", () => {
    const r = new AdaptiveRouter();
    const result = r.pick({ task: "x" }, [makeInstance("a")]);
    expect(result.label).toBe("a");
  });

  it("returns null when no eligible instance", () => {
    const r = new AdaptiveRouter();
    const result = r.pick({ task: "x" }, [makeInstance("a", [], "down")]);
    expect(result.label).toBeNull();
    expect(result.scores[0]?.reason).toContain("not ready");
  });

  it("respects tag filter (tag-based routing)", () => {
    const r = new AdaptiveRouter();
    const result = r.pick({ task: "x", tags: ["code"] }, [
      makeInstance("a", ["research"]),
      makeInstance("b", ["code"]),
    ]);
    expect(result.label).toBe("b");
  });

  it("prefers less-loaded when weights favor load", () => {
    const r = new AdaptiveRouter({ successRate: 0, latency: 0, load: 1, freshness: 0, tagMatch: 0, cost: 0 });
    r.recordResult("busy", true, 100);
    r.recordResult("idle", true, 100);
    const result = r.pick({ task: "x" }, [
      makeInstance("busy", [], "ready", 5, 5),
      makeInstance("idle", [], "ready", 0, 5),
    ]);
    expect(result.label).toBe("idle");
  });

  it("down-weights failing instance", () => {
    const r = new AdaptiveRouter();
    for (let i = 0; i < 10; i++) r.recordResult("good", true, 100);
    for (let i = 0; i < 5; i++) r.recordResult("bad", false, 100, "oops");
    const result = r.pick({ task: "x" }, [makeInstance("good"), makeInstance("bad")]);
    expect(result.label).toBe("good");
  });
});
