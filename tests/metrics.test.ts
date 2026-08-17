import { describe, it, expect } from "vitest";
import { MetricsRegistry } from "../src/metrics.js";

describe("MetricsRegistry", () => {
  it("increments counters", () => {
    const m = new MetricsRegistry();
    m.inc("http_requests");
    m.inc("http_requests");
    m.inc("http_requests", { path: "/a" });
    expect(m.get("http_requests")).toBe(2);
    expect(m.get("http_requests", { path: "/a" })).toBe(1);
  });

  it("sets gauges", () => {
    const m = new MetricsRegistry();
    m.set("queue_depth", 5);
    m.set("queue_depth", 8);
    expect(m.get("queue_depth")).toBe(8);
  });

  it("exports Prometheus format", () => {
    const m = new MetricsRegistry();
    m.inc("requests_total", { method: "GET" }, 3);
    const out = m.toPrometheus();
    expect(out).toContain("# HELP requests_total");
    expect(out).toContain("# TYPE requests_total counter");
    expect(out).toContain('requests_total{method="GET"} 3');
  });

  it("exports JSON format", () => {
    const m = new MetricsRegistry();
    m.inc("foo");
    m.set("bar", 7);
    const j = m.toJSON();
    expect(j.counters).toBeDefined();
    expect(j.gauges).toBeDefined();
  });
});
