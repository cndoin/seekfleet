import { describe, it, expect } from "vitest";
import { CircuitBreaker, CircuitBreakerOpenError, CircuitBreakerTimeoutError } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker(async () => 42, { name: "t" });
    expect(cb.state).toBe("closed");
  });

  it("executes the wrapped function", async () => {
    const cb = new CircuitBreaker(async (n: number) => n * 2, { name: "double" });
    const r = await cb.exec(21);
    expect(r).toBe(42);
    expect(cb.stats().successes).toBe(1);
  });

  it("trips after error threshold", async () => {
    const cb = new CircuitBreaker(
      async () => {
        throw new Error("boom");
      },
      { name: "flaky", volumeThreshold: 3, errorThresholdPercentage: 50, rollingCountTimeout: 60000 },
    );
    await expect(cb.exec()).rejects.toThrow("boom");
    await expect(cb.exec()).rejects.toThrow("boom");
    await expect(cb.exec()).rejects.toThrow("boom");
    // After 3 failures (100% rate), should be open
    expect(cb.state).toBe("open");
    await expect(cb.exec()).rejects.toThrow(CircuitBreakerOpenError);
  });

  it("transitions to half-open after resetTimeout", async () => {
    let fail = true;
    const cb = new CircuitBreaker(
      async () => {
        if (fail) throw new Error("nope");
        return 1;
      },
      {
        name: "recover",
        volumeThreshold: 2,
        errorThresholdPercentage: 50,
        rollingCountTimeout: 60000,
        resetTimeout: 50,
      },
    );
    await expect(cb.exec()).rejects.toThrow();
    await expect(cb.exec()).rejects.toThrow();
    expect(cb.state).toBe("open");
    await new Promise((r) => setTimeout(r, 80));
    fail = false;
    const result = await cb.exec();
    expect(result).toBe(1);
    expect(cb.state).toBe("closed");
  });

  it("emits timeout errors", async () => {
    const cb = new CircuitBreaker(
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 1;
      },
      { name: "slow", timeout: 50, volumeThreshold: 100, errorThresholdPercentage: 50 },
    );
    await expect(cb.exec()).rejects.toThrow(CircuitBreakerTimeoutError);
  });

  it("can be opened manually", async () => {
    const cb = new CircuitBreaker(async () => 1, { name: "manual" });
    cb.open();
    expect(cb.state).toBe("open");
    await expect(cb.exec()).rejects.toThrow(CircuitBreakerOpenError);
  });
});
