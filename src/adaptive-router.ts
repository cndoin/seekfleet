// adaptive-router.ts - scoring-based routing that learns from history.
//
// Each instance accumulates per-instance metrics:
//   - success rate (rolling window)
//   - p50 / p95 latency (ms)
//   - recent error streak
//   - in-flight load
//   - circuit breaker state
//   - cost (per token)
//   - tag match score
//
// The router computes a score per eligible instance and picks the best.
// Weights are configurable. The router auto-down-weights (but never to zero)
// instances that recently failed, so traffic naturally shifts away.

import type { BreakerStats } from "./circuit-breaker.js";
import type { DshInstanceSpec, DshInstanceStatus, DshTask } from "./types.js";

export interface InstanceMetrics {
  label: string;
  totalRuns: number;
  successes: number;
  failures: number;
  /** rolling p50 latency ms */
  p50Ms: number;
  /** rolling p95 latency ms */
  p95Ms: number;
  recentLatencies: number[]; // bounded ring buffer
  consecutiveFailures: number;
  /** last N timestamps (ms) of completed runs */
  recentRunTimestamps: number[];
  /** last N error messages */
  recentErrors: string[];
  breaker: BreakerStats;
  totalCostUsd: number;
  totalTokens: number;
  capability?: { tools: string[]; model?: string; version?: string };
}

export interface AdaptiveWeights {
  /** weight of success rate (default 0.35) */
  successRate: number;
  /** weight of inverse p95 latency (default 0.25) */
  latency: number;
  /** weight of inverse load (default 0.20) */
  load: number;
  /** weight of inverse recent failures (default 0.10) */
  freshness: number;
  /** weight of tag match (default 0.05) */
  tagMatch: number;
  /** weight of inverse cost (default 0.05) */
  cost: number;
}

export const DEFAULT_WEIGHTS: AdaptiveWeights = {
  successRate: 0.35,
  latency: 0.25,
  load: 0.2,
  freshness: 0.1,
  tagMatch: 0.05,
  cost: 0.05,
};

const LATENCY_WINDOW = 50;
const RECENT_RUNS_WINDOW = 100;

export class AdaptiveRouter {
  readonly weights: AdaptiveWeights;
  /** key = instance label */
  private metrics = new Map<string, InstanceMetrics>();
  private maxP95RefMs: number = 30_000;
  private maxCostRefUsd: number = 0.1;

  constructor(weights: Partial<AdaptiveWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  ensureMetrics(label: string): InstanceMetrics {
    let m = this.metrics.get(label);
    if (!m) {
      m = {
        label,
        totalRuns: 0,
        successes: 0,
        failures: 0,
        p50Ms: 0,
        p95Ms: 0,
        recentLatencies: [],
        consecutiveFailures: 0,
        recentRunTimestamps: [],
        recentErrors: [],
        breaker: { state: "closed", fires: 0, successes: 0, failures: 0, timeouts: 0, rejects: 0, fallbacks: 0 },
        totalCostUsd: 0,
        totalTokens: 0,
      };
      this.metrics.set(label, m);
    }
    return m;
  }

  recordResult(label: string, ok: boolean, durationMs: number, errorMsg?: string): void {
    const m = this.ensureMetrics(label);
    m.totalRuns++;
    if (ok) {
      m.successes++;
      m.consecutiveFailures = 0;
    } else {
      m.failures++;
      m.consecutiveFailures++;
      if (errorMsg) m.recentErrors.unshift(errorMsg);
    }
    if (m.recentErrors.length > 5) m.recentErrors.length = 5;
    m.recentLatencies.push(durationMs);
    if (m.recentLatencies.length > LATENCY_WINDOW) m.recentLatencies.shift();
    m.recentRunTimestamps.push(Date.now());
    if (m.recentRunTimestamps.length > RECENT_RUNS_WINDOW) m.recentRunTimestamps.shift();
    // Update p50 / p95
    const sorted = [...m.recentLatencies].sort((a, b) => a - b);
    m.p50Ms = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length * 0.5)]!;
    m.p95Ms = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    if (m.p95Ms > this.maxP95RefMs) this.maxP95RefMs = m.p95Ms;
  }

  recordBreaker(label: string, breaker: BreakerStats): void {
    const m = this.ensureMetrics(label);
    m.breaker = breaker;
  }

  recordCost(label: string, costUsd: number, tokens: number): void {
    const m = this.ensureMetrics(label);
    m.totalCostUsd += costUsd;
    m.totalTokens += tokens;
    if (costUsd > this.maxCostRefUsd) this.maxCostRefUsd = costUsd;
  }

  setCapability(label: string, cap: InstanceMetrics["capability"]): void {
    const m = this.ensureMetrics(label);
    m.capability = cap;
  }

  get(label: string): InstanceMetrics | undefined {
    return this.metrics.get(label);
  }

  all(): InstanceMetrics[] {
    return Array.from(this.metrics.values());
  }

  /** Pick the best instance via score; returns label or null. */
  pick(
    task: DshTask,
    instances: ReadonlyArray<DshInstanceStatus & { spec: DshInstanceSpec }>,
  ): { label: string | null; scores: Array<{ label: string; score: number; eligible: boolean; reason?: string }> } {
    const scores: Array<{ label: string; score: number; eligible: boolean; reason?: string }> = [];
    let best: { label: string; score: number } | null = null;
    for (const inst of instances) {
      const m = this.ensureMetrics(inst.label);
      const eligibility = checkEligibility(inst, m, task);
      if (!eligibility.eligible) {
        scores.push({ label: inst.label, score: -Infinity, eligible: false, reason: eligibility.reason });
        continue;
      }
      const score = this.scoreInstance(inst, m, task);
      scores.push({ label: inst.label, score, eligible: true });
      if (best === null || score > best.score) best = { label: inst.label, score };
    }
    return { label: best?.label ?? null, scores: scores.sort((a, b) => b.score - a.score) };
  }

  private scoreInstance(
    inst: DshInstanceStatus & { spec: DshInstanceSpec },
    m: InstanceMetrics,
    task: DshTask,
  ): number {
    const w = this.weights;
    // success rate [0..1] (smoothed: add 1 to denom so cold instances not 0)
    const successRate = m.totalRuns === 0 ? 0.8 : m.successes / m.totalRuns;
    // latency score: 1 = fastest, 0 = slowest. Normalize vs current max.
    const latencyScore = m.p95Ms === 0 ? 0.7 : Math.max(0, 1 - m.p95Ms / this.maxP95RefMs);
    // load score: inverse of in-flight/concurrency
    const load = inst.concurrency === 0 ? 1 : inst.inFlight / inst.concurrency;
    const loadScore = 1 - load;
    // freshness: penalize consecutive failures
    const freshnessScore = Math.max(0, 1 - m.consecutiveFailures * 0.25);
    // tag match: 1 if any tag matches task.tags, else 0.5
    const taskTags = task.tags ?? [];
    const instTags = inst.tags ?? [];
    const tagMatchScore = taskTags.length === 0 ? 0.5 : instTags.some((t) => taskTags.includes(t)) ? 1 : 0;
    // cost: 1 = cheapest (low avg), 0 = most expensive. Normalize.
    const costScore =
      m.totalCostUsd === 0 ? 0.7 : Math.max(0, 1 - m.totalCostUsd / Math.max(this.maxCostRefUsd, 0.001));

    return (
      w.successRate * successRate +
      w.latency * latencyScore +
      w.load * loadScore +
      w.freshness * freshnessScore +
      w.tagMatch * tagMatchScore +
      w.cost * costScore
    );
  }
}

function checkEligibility(
  inst: DshInstanceStatus & { spec: DshInstanceSpec },
  m: InstanceMetrics,
  task: DshTask,
): { eligible: boolean; reason?: string } {
  if (inst.state === "down" || inst.state === "stopped" || inst.state === "draining") {
    return { eligible: false, reason: "instance not ready: " + inst.state };
  }
  if (m.breaker.state === "open") return { eligible: false, reason: "breaker open" };
  if (inst.inFlight >= inst.concurrency) return { eligible: false, reason: "at capacity" };
  // Tag filter: if instance declares tags and task declares tags, require intersection.
  const instTags = inst.tags ?? [];
  const taskTags = task.tags ?? [];
  if (instTags.length > 0 && taskTags.length > 0) {
    if (!instTags.some((t) => taskTags.includes(t))) return { eligible: false, reason: "tag mismatch" };
  }
  return { eligible: true };
}
