// cost-tracker.ts - per-instance token / cost accounting.
//
// Tracks cumulative token usage and estimated cost across instances.
// Cost per 1k tokens is configurable per profile / model.

export interface ModelPricing {
  /** Cost in USD per 1k input tokens. */
  inputPer1k: number;
  /** Cost in USD per 1k output tokens. */
  outputPer1k: number;
}

export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Common defaults; user can override.
  "deepseek-chat": { inputPer1k: 0.00014, outputPer1k: 0.00028 },
  "deepseek-reasoner": { inputPer1k: 0.00055, outputPer1k: 0.00219 },
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "gpt-5": { inputPer1k: 0.00125, outputPer1k: 0.01 },
  "claude-3-5-sonnet": { inputPer1k: 0.003, outputPer1k: 0.015 },
  default: { inputPer1k: 0.001, outputPer1k: 0.003 },
};

export interface UsageRecord {
  instanceLabel: string;
  profile: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  ts: number;
  taskPreview: string;
}

export interface CostSummary {
  instanceLabel: string;
  totalRuns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCostUsd: number;
  avgDurationMs: number;
  models: Record<string, { runs: number; tokens: number; costUsd: number }>;
}

export class CostTracker {
  private records: UsageRecord[] = [];
  private pricing: Record<string, ModelPricing>;
  /** Hard cap in USD; if set, further tasks are rejected. */
  budgetUsd?: number;
  /** Soft warning threshold as fraction of budget. */
  warningFraction: number = 0.8;
  /** Listeners notified on budget events. */
  private listeners: Array<(evt: { kind: "warning" | "exceeded"; summary: CostSummary }) => void> = [];
  /** P0-4: pending reservations (id -> estimated usd). */
  private reservations = new Map<string, number>();
  private reservationCounter = 0;
  /** Mutex for reserve() to avoid race conditions on concurrent calls. */
  private reserveQueue: Promise<void> = Promise.resolve();

  constructor(pricing?: Record<string, ModelPricing>) {
    this.pricing = { ...DEFAULT_PRICING, ...(pricing ?? {}) };
  }

  setPricing(model: string, p: ModelPricing): void {
    this.pricing[model] = p;
  }
  setBudget(usd: number): void {
    this.budgetUsd = usd;
  }
  onBudgetEvent(listener: (evt: { kind: "warning" | "exceeded"; summary: CostSummary }) => void): void {
    this.listeners.push(listener);
  }

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const p = this.pricing[model] ?? this.pricing["default"]!;
    return (inputTokens / 1000) * p.inputPer1k + (outputTokens / 1000) * p.outputPer1k;
  }

  record(record: Omit<UsageRecord, "costUsd">): CostSummary {
    const costUsd = this.estimateCost(record.model, record.inputTokens, record.outputTokens);
    const full: UsageRecord = { ...record, costUsd };
    this.records.push(full);
    const summary = this.summaryFor(record.instanceLabel);
    if (this.budgetUsd !== undefined) {
      const total = this.totalCost();
      if (total >= this.budgetUsd) {
        for (const fn of this.listeners) fn({ kind: "exceeded", summary });
      } else if (total >= this.budgetUsd * this.warningFraction) {
        for (const fn of this.listeners) fn({ kind: "warning", summary });
      }
    }
    return summary;
  }

  totalCost(): number {
    return this.records.reduce((s, r) => s + r.costUsd, 0);
  }

  totalTokens(): { input: number; output: number } {
    return this.records.reduce(
      (acc, r) => ({ input: acc.input + r.inputTokens, output: acc.output + r.outputTokens }),
      { input: 0, output: 0 },
    );
  }

  summaryFor(instanceLabel: string): CostSummary {
    const recs = this.records.filter((r) => r.instanceLabel === instanceLabel);
    const n = recs.length;
    const totalInput = recs.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutput = recs.reduce((s, r) => s + r.outputTokens, 0);
    const totalCost = recs.reduce((s, r) => s + r.costUsd, 0);
    const totalDur = recs.reduce((s, r) => s + r.durationMs, 0);
    const models: Record<string, { runs: number; tokens: number; costUsd: number }> = {};
    for (const r of recs) {
      const m = models[r.model] ?? { runs: 0, tokens: 0, costUsd: 0 };
      m.runs++;
      m.tokens += r.inputTokens + r.outputTokens;
      m.costUsd += r.costUsd;
      models[r.model] = m;
    }
    return {
      instanceLabel,
      totalRuns: n,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCostUsd: totalCost,
      avgInputTokens: n === 0 ? 0 : totalInput / n,
      avgOutputTokens: n === 0 ? 0 : totalOutput / n,
      avgCostUsd: n === 0 ? 0 : totalCost / n,
      avgDurationMs: n === 0 ? 0 : totalDur / n,
      models,
    };
  }

  summaries(): CostSummary[] {
    const labels = Array.from(new Set(this.records.map((r) => r.instanceLabel)));
    return labels.map((l) => this.summaryFor(l));
  }

  globalSummary(): {
    totalRuns: number;
    totalCostUsd: number;
    totalTokens: { input: number; output: number };
    instances: number;
  } {
    return {
      totalRuns: this.records.length,
      totalCostUsd: this.totalCost(),
      totalTokens: this.totalTokens(),
      instances: new Set(this.records.map((r) => r.instanceLabel)).size,
    };
  }

  recent(n: number): UsageRecord[] {
    return this.records.slice(-n);
  }

  records_(): readonly UsageRecord[] {
    return this.records;
  }

  /**
   * P0-4: Reserve budget for an upcoming task. Returns the reservation id,
   * or null if reservation would exceed the hard budget. Reservations are
   * tracked separately from actual usage so concurrent calls can't race
   * past the budget cap.
   */
  async reserve(estimatedUsd: number, _label?: string): Promise<string | null> {
    // Serialize reservations to prevent race: chain into reserveQueue
    let resolve: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    const prev = this.reserveQueue;
    this.reserveQueue = next;
    await prev;
    try {
      if (this.budgetUsd === undefined) {
        const id = "rsv-" + ++this.reservationCounter;
        this.reservations.set(id, estimatedUsd);
        return id;
      }
      const reserved = Array.from(this.reservations.values()).reduce((a, b) => a + b, 0);
      if (this.totalCost() + reserved + estimatedUsd > this.budgetUsd) {
        return null;
      }
      const id = "rsv-" + ++this.reservationCounter;
      this.reservations.set(id, estimatedUsd);
      return id;
    } finally {
      resolve!();
    }
  }

  /** Confirm a reservation: convert reservation into actual usage record. */
  confirm(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  /** Release a reservation without spending (e.g., on early failure). */
  release(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  /** Snapshot of current budget state. */
  budgetState(): { budgetUsd?: number; spent: number; reserved: number; remaining?: number } {
    const reserved = Array.from(this.reservations.values()).reduce((a, b) => a + b, 0);
    const spent = this.totalCost();
    return {
      budgetUsd: this.budgetUsd,
      spent,
      reserved,
      remaining: this.budgetUsd !== undefined ? Math.max(0, this.budgetUsd - spent - reserved) : undefined,
    };
  }
}
