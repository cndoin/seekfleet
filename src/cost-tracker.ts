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

/**
 * 保留的原始用量记录上限。
 *
 * 明细只对「最近发生了什么」有用；累计指标（总花费 / 每个实例的 token）由增量
 * 聚合单独维护，不依赖这条数组。一个跑上几万次任务的集群如果无限留住明细，
 * 每条还带着 taskPreview 字符串，那就是个稳定的内存泄漏。
 */
const MAX_USAGE_RECORDS = 5000;

/** 每个实例的滚动聚合。record() 时 O(1) 更新，读的时候直接成型。 */
interface InstanceAgg {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  models: Map<string, { runs: number; tokens: number; costUsd: number }>;
}

export class CostTracker {
  private records: UsageRecord[] = [];
  private readonly byInstance = new Map<string, InstanceAgg>();
  private readonly globalAgg = { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
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

  /**
   * 记录一次用量。
   *
   * 这是热路径：每次任务结束都走一遍，而且它自己还要产出一次 per-instance 汇总。
   * 旧实现是「filter 全量数组 + reduce 五遍」，于是 N 次 record 就是 O(N²)：
   * 长跑集群会越跑越慢，dashboard 每 2 秒再全量重算一次，最后把事件循环拖住。
   * 现在改成增量更新聚合，单次 O(1)。
   *
   * 代价是浮点累加误差会缓慢累积（相对每次全量重算），量级在 1e-12 美元，
   * 对一个用来做预算闸门的数字不构成影响。
   */
  record(record: Omit<UsageRecord, "costUsd">): CostSummary {
    const costUsd = this.estimateCost(record.model, record.inputTokens, record.outputTokens);
    const full: UsageRecord = { ...record, costUsd };

    this.records.push(full);
    // 明细是环形队列：丢掉最旧的明细，但已累计的聚合不受影响。
    if (this.records.length > MAX_USAGE_RECORDS) {
      this.records.splice(0, this.records.length - MAX_USAGE_RECORDS);
    }

    let agg = this.byInstance.get(record.instanceLabel);
    if (!agg) {
      agg = { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, models: new Map() };
      this.byInstance.set(record.instanceLabel, agg);
    }
    agg.runs++;
    agg.inputTokens += record.inputTokens;
    agg.outputTokens += record.outputTokens;
    agg.costUsd += costUsd;
    agg.durationMs += record.durationMs;
    const modelAgg = agg.models.get(record.model) ?? { runs: 0, tokens: 0, costUsd: 0 };
    modelAgg.runs++;
    modelAgg.tokens += record.inputTokens + record.outputTokens;
    modelAgg.costUsd += costUsd;
    agg.models.set(record.model, modelAgg);

    this.globalAgg.runs++;
    this.globalAgg.inputTokens += record.inputTokens;
    this.globalAgg.outputTokens += record.outputTokens;
    this.globalAgg.costUsd += costUsd;

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
    return this.globalAgg.costUsd;
  }

  totalTokens(): { input: number; output: number } {
    return { input: this.globalAgg.inputTokens, output: this.globalAgg.outputTokens };
  }

  summaryFor(instanceLabel: string): CostSummary {
    const agg = this.byInstance.get(instanceLabel);
    const n = agg?.runs ?? 0;
    const totalInput = agg?.inputTokens ?? 0;
    const totalOutput = agg?.outputTokens ?? 0;
    const totalCost = agg?.costUsd ?? 0;
    const models: Record<string, { runs: number; tokens: number; costUsd: number }> = {};
    if (agg) for (const [model, m] of agg.models) models[model] = { ...m };
    return {
      instanceLabel,
      totalRuns: n,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCostUsd: totalCost,
      avgInputTokens: n === 0 ? 0 : totalInput / n,
      avgOutputTokens: n === 0 ? 0 : totalOutput / n,
      avgCostUsd: n === 0 ? 0 : totalCost / n,
      avgDurationMs: n === 0 ? 0 : (agg?.durationMs ?? 0) / n,
      models,
    };
  }

  summaries(): CostSummary[] {
    return Array.from(this.byInstance.keys()).map((l) => this.summaryFor(l));
  }

  globalSummary(): {
    totalRuns: number;
    totalCostUsd: number;
    totalTokens: { input: number; output: number };
    instances: number;
  } {
    return {
      totalRuns: this.globalAgg.runs,
      totalCostUsd: this.totalCost(),
      totalTokens: this.totalTokens(),
      instances: this.byInstance.size,
    };
  }

  recent(n: number): UsageRecord[] {
    return this.records.slice(-n);
  }

  /**
   * 当前**保留**的用量明细。
   *
   * 超过 MAX_USAGE_RECORDS 之后最旧的会被丢弃，所以这是「最近的明细」而不是
   * 完整历史 —— 完整历史只是用内存换一个没人看的东西。累计指标走
   * summaries() / globalSummary()，那些不受裁剪影响。
   */
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
