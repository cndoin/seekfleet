import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker.recordOutcome (PART-1)", () => {
  it("trips on recorded failure (no throw)", async () => {
    const fn = async () => "ok";
    const br = new CircuitBreaker(fn, { volumeThreshold: 3, errorThresholdPercentage: 50 });
    // Simulate result.error path: 3 successful + 3 failures via recordOutcome
    br.recordOutcome(true);
    br.recordOutcome(true);
    br.recordOutcome(true);
    expect(br.state).toBe("closed");
    br.recordOutcome(false, "exit 1");
    br.recordOutcome(false, "exit 1");
    br.recordOutcome(false, "exit 1");
    expect(br.state).toBe("open");
  });

  it("exec() and recordOutcome() interact correctly", async () => {
    let fail = false;
    const fn = async () => (fail ? Promise.reject(new Error("x")) : "ok");
    const br = new CircuitBreaker(fn, { volumeThreshold: 2, errorThresholdPercentage: 50 });
    await br.exec();
    fail = true;
    try {
      await br.exec();
    } catch {
      /* expected */
    }
    // Now record 3 more failures via recordOutcome (simulates result.error / non-zero exit)
    br.recordOutcome(false);
    br.recordOutcome(false);
    br.recordOutcome(false);
    expect(br.state).toBe("open");
  });

  it("stats reflect recorded outcomes", () => {
    const br = new CircuitBreaker(async () => "ok", { name: "test" });
    br.recordOutcome(true);
    br.recordOutcome(true);
    br.recordOutcome(false);
    const s = br.stats();
    expect(s.fires).toBe(3);
    expect(s.successes).toBe(2);
    expect(s.failures).toBe(1);
  });

  it("half-open probe success closes", async () => {
    const br = new CircuitBreaker(async () => "ok", {
      name: "t2",
      volumeThreshold: 2,
      errorThresholdPercentage: 50,
      resetTimeout: 10,
    });
    br.recordOutcome(false);
    br.recordOutcome(false);
    expect(br.state).toBe("open");
    // Wait for reset
    await new Promise((r) => setTimeout(r, 20));
    await br.exec();
    expect(br.state).toBe("closed");
  });
});
