// circuit-breaker.ts - per-instance failure isolation.
//
// A CircuitBreaker wraps an async function and counts failures over a rolling
// time window. When the failure rate exceeds a threshold, the breaker opens
// and rejects all subsequent calls until the reset timeout elapses.

export interface BreakerOptions {
  rollingCountTimeout?: number;
  volumeThreshold?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  timeout?: number;
  name?: string;
}

export interface BreakerStats {
  state: BreakerState;
  fires: number;
  successes: number;
  failures: number;
  timeouts: number;
  rejects: number;
  fallbacks: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  openedAt?: number;
}

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreakerOpenError extends Error {
  override readonly name = "CircuitBreakerOpenError";
  constructor(name: string) {
    super("circuit breaker open: " + name);
  }
}

export class CircuitBreakerTimeoutError extends Error {
  override readonly name = "CircuitBreakerTimeoutError";
  constructor(name: string, ms: number) {
    super("circuit breaker timeout after " + ms + "ms: " + name);
  }
}

interface RollingBucket {
  startsAt: number;
  fires: number;
  failures: number;
}

export class CircuitBreaker<TArgs extends unknown[], TResult> {
  readonly name: string;
  private readonly opts: Required<BreakerOptions>;
  private readonly fn: (...args: TArgs) => Promise<TResult>;
  private buckets: RollingBucket[] = [];
  private current: RollingBucket;
  state: BreakerState = "closed";
  openedAt?: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  private stats_ = { fires: 0, successes: 0, failures: 0, timeouts: 0, rejects: 0, fallbacks: 0 };

  constructor(fn: (...args: TArgs) => Promise<TResult>, options: BreakerOptions = {}) {
    this.name = options.name ?? "breaker";
    this.fn = fn;
    this.opts = {
      rollingCountTimeout: options.rollingCountTimeout ?? 30_000,
      volumeThreshold: options.volumeThreshold ?? 5,
      errorThresholdPercentage: options.errorThresholdPercentage ?? 50,
      resetTimeout: options.resetTimeout ?? 30_000,
      timeout: options.timeout ?? 30_000,
      name: this.name,
    };
    this.current = this.newBucket();
  }

  private newBucket(): RollingBucket {
    return { startsAt: Date.now(), fires: 0, failures: 0 };
  }

  private rollBucketsIfNeeded(): void {
    const now = Date.now();
    const cutoff = now - this.opts.rollingCountTimeout;
    this.buckets = this.buckets.filter((b) => b.startsAt > cutoff);
    if (this.current.startsAt <= cutoff) {
      if (this.current.fires > 0) this.buckets.push(this.current);
      this.current = this.newBucket();
    }
  }

  private aggregate(): { fires: number; failures: number } {
    this.rollBucketsIfNeeded();
    let fires = this.current.fires;
    let failures = this.current.failures;
    for (const b of this.buckets) {
      fires += b.fires;
      failures += b.failures;
    }
    return { fires, failures };
  }

  open(): void {
    if (this.state === "open") return;
    this.state = "open";
    this.openedAt = Date.now();
  }

  close(): void {
    this.state = "closed";
    this.openedAt = undefined;
    this.buckets = [];
    this.current = this.newBucket();
  }

  async exec(...args: TArgs): Promise<TResult> {
    this.stats_.fires++;
    this.current.fires++;
    if (this.state === "open") {
      if (Date.now() - (this.openedAt ?? 0) >= this.opts.resetTimeout) {
        this.state = "half-open";
      } else {
        this.stats_.rejects++;
        throw new CircuitBreakerOpenError(this.name);
      }
    }
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeoutMs = this.opts.timeout;
    try {
      const promise = this.fn(...args);
      const result =
        timeoutMs > 0
          ? await Promise.race([
              promise,
              new Promise<never>((_, rej) => {
                timer = setTimeout(() => rej(new CircuitBreakerTimeoutError(this.name, timeoutMs)), timeoutMs);
              }),
            ])
          : await promise;
      if (timer) clearTimeout(timer);
      this.onSuccess();
      return result;
    } catch (err) {
      if (timer) clearTimeout(timer);
      this.onFailure(err);
      throw err;
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs && timeoutMs > 0) {
        this.stats_.timeouts++;
      }
    }
  }

  private onSuccess(): void {
    this.stats_.successes++;
    this.lastSuccessAt = Date.now();
    if (this.state === "half-open") this.close();
  }

  private onFailure(_err: unknown): void {
    this.stats_.failures++;
    this.current.failures++;
    this.lastFailureAt = Date.now();
    if (this.state === "half-open") {
      this.open();
      return;
    }
    const { fires, failures } = this.aggregate();
    if (fires >= this.opts.volumeThreshold) {
      const pct = (failures / fires) * 100;
      if (pct >= this.opts.errorThresholdPercentage) this.open();
    }
  }

  /**
   * PART-1 fix: explicitly record an outcome without throwing. Use this when
   * the wrapped function returned a result with `.error` set or a non-zero
   * exit code. Without this, the breaker only trips on thrown exceptions,
   * missing soft-failure semantics.
   */
  recordOutcome(success: boolean, err?: unknown): void {
    this.stats_.fires++;
    this.current.fires++;
    if (success) {
      this.onSuccess();
    } else {
      this.onFailure(err);
    }
  }

  stats(): BreakerStats {
    return {
      state: this.state,
      fires: this.stats_.fires,
      successes: this.stats_.successes,
      failures: this.stats_.failures,
      timeouts: this.stats_.timeouts,
      rejects: this.stats_.rejects,
      fallbacks: this.stats_.fallbacks,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openedAt: this.openedAt,
    };
  }
}
