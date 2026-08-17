import { describe, it, expect } from "vitest";
import { Histogram } from "../src/metrics.js";

describe("Histogram", () => {
  it("computes quantiles correctly (linear interpolation)", () => {
    const h = new Histogram({ name: "latency_ms", help: "latency in ms", maxSamples: 10000 });
    for (let i = 1; i <= 100; i++) h.observe(i);
    const s = h.snapshot();
    expect(s.count).toBe(100);
    // With linear interpolation: p50 = values[49.5] = 49.5, p95 = 94.05, p99 = 98.01
    expect(s.p50).toBeCloseTo(50.5, 1);
    expect(s.p95).toBeCloseTo(95.05, 1);
    expect(s.p99).toBeCloseTo(99.01, 1);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.mean).toBeCloseTo(50.5, 0);
  });

  it("bounds the sample window", () => {
    const h = new Histogram({ name: "x", help: "x", maxSamples: 10 });
    for (let i = 1; i <= 1000; i++) h.observe(i);
    expect(h.snapshot().count).toBe(10);
  });

  it("handles empty state", () => {
    const h = new Histogram({ name: "x", help: "x" });
    const s = h.snapshot();
    expect(s.count).toBe(0);
    expect(s.mean).toBe(0);
  });

  it("reset clears", () => {
    const h = new Histogram({ name: "x", help: "x" });
    h.observe(5);
    h.reset();
    expect(h.snapshot().count).toBe(0);
  });
});
