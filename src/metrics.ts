// metrics.ts - lightweight metrics for Prometheus scraping or JSON export.
//
// Counters and gauges only (no histograms). For Prometheus, every metric has
// an optional labels map; we render as `metric_name{label="value"} 42`.

export type MetricKind = "counter" | "gauge";

export interface MetricSeries {
  name: string;
  kind: MetricKind;
  help: string;
  labels: Record<string, string>;
  value: number;
}

export class MetricsRegistry {
  private series = new Map<string, MetricSeries>();

  private key(name: string, labels: Record<string, string> | undefined): string {
    const lbls = labels
      ? Object.keys(labels)
          .sort()
          .map((k) => k + "=" + JSON.stringify(labels[k]))
          .join(",")
      : "";
    return name + "{" + lbls + "}";
  }

  inc(name: string, labels?: Record<string, string>, by = 1): void {
    const k = this.key(name, labels);
    const existing = this.series.get(k);
    if (existing) {
      existing.value += by;
    } else {
      this.series.set(k, { name, kind: "counter", help: name, labels: labels ?? {}, value: by });
    }
  }

  observe(name: string, value: number, labels?: Record<string, string>): void {
    // gauge-style observe (no buckets yet); keeps API compatible with future histograms
    this.set(name + "_sum", this.get(name + "_sum", labels) + value, labels);
    this.inc(name + "_count", labels, 1);
  }

  set(name: string, value: number, labels?: Record<string, string>): void {
    const k = this.key(name, labels);
    const existing = this.series.get(k);
    if (existing) {
      existing.value = value;
    } else {
      this.series.set(k, { name, kind: "gauge", help: name, labels: labels ?? {}, value });
    }
  }

  get(name: string, labels?: Record<string, string>): number {
    return this.series.get(this.key(name, labels))?.value ?? 0;
  }

  /** Render in Prometheus text exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];
    const seenHelp = new Set<string>();
    for (const s of this.series.values()) {
      if (!seenHelp.has(s.name)) {
        lines.push("# HELP " + s.name + " " + s.help);
        lines.push("# TYPE " + s.name + " " + s.kind);
        seenHelp.add(s.name);
      }
      const labelStr =
        Object.keys(s.labels).length === 0
          ? ""
          : "{" +
            Object.keys(s.labels)
              .sort()
              .map((k) => k + '="' + (s.labels[k] ?? "").replace(/"/g, '\\"') + '"')
              .join(",") +
            "}";
      lines.push(s.name + labelStr + " " + s.value);
    }
    return lines.join("\n") + "\n";
  }

  /** Render as a structured JSON object. */
  toJSON(): { counters: Record<string, number>; gauges: Record<string, number>; observations: Record<string, number> } {
    const counters: Record<string, number> = {};
    const gauges: Record<string, number> = {};
    const observations: Record<string, number> = {};
    for (const s of this.series.values()) {
      const labelStr =
        Object.keys(s.labels).length === 0
          ? ""
          : "{" +
            Object.keys(s.labels)
              .sort()
              .map((k) => k + "=" + (s.labels[k] ?? ""))
              .join(",") +
            "}";
      const fullName = s.name + labelStr;
      if (s.kind === "counter") counters[fullName] = s.value;
      else if (s.name.endsWith("_sum") || s.name.endsWith("_count")) observations[fullName] = s.value;
      else gauges[fullName] = s.value;
    }
    return { counters, gauges, observations };
  }
}

/**
 * P1-9: Bounded ring buffer + quantile histogram. Exposes p50/p95/p99 and
 * mean/standard deviation via simple in-memory computation. We keep the
 * sample window small (default 1000) so memory stays bounded.
 */
export class Histogram {
  private values: number[] = [];
  private readonly max: number;
  readonly name: string;
  readonly help: string;
  readonly labelNames: string[];

  constructor(opts: { name: string; help: string; maxSamples?: number; labelNames?: string[] }) {
    this.name = opts.name;
    this.help = opts.help;
    this.max = opts.maxSamples ?? 1000;
    this.labelNames = opts.labelNames ?? [];
  }

  observe(v: number): void {
    this.values.push(v);
    if (this.values.length > this.max) this.values.shift();
  }

  reset(): void {
    this.values = [];
  }

  private quantile(q: number): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    // Linear interpolation (numpy default)
    const pos = q * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo]!;
    const frac = pos - lo;
    return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
  }

  snapshot(): {
    count: number;
    sum: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
    stddev: number;
  } {
    if (this.values.length === 0) {
      return { count: 0, sum: 0, mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0, stddev: 0 };
    }
    const sum = this.values.reduce((a, b) => a + b, 0);
    const mean = sum / this.values.length;
    const variance = this.values.reduce((a, b) => a + (b - mean) ** 2, 0) / this.values.length;
    return {
      count: this.values.length,
      sum,
      mean,
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      min: Math.min(...this.values),
      max: Math.max(...this.values),
      stddev: Math.sqrt(variance),
    };
  }
}
