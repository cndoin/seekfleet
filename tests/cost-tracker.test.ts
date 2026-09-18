// cost-tracker.test.ts — 成本聚合的正确性与有界性。
//
// 这个文件存在的理由：CostTracker.record() 是热路径，同时又是预算闸门的依据。
// 两件事必须同时成立 ——
//   1. 累计指标不能因为「明细被裁剪」而丢失（否则 HardBudget 会算错钱）
//   2. 明细必须有上限（否则长跑集群是一条稳定的内存泄漏曲线）
// 只要有人把这两个性质之一改回去，这里的用例会红。

import { describe, expect, it } from "vitest";
import { CostTracker } from "../src/cost-tracker.js";

function usage(instanceLabel: string, input: number, output: number, model = "default") {
  return {
    instanceLabel,
    profile: "headless",
    model,
    inputTokens: input,
    outputTokens: output,
    durationMs: 100,
    ts: Date.now(),
    taskPreview: "task",
  };
}

describe("CostTracker aggregation", () => {
  it("accumulates per-instance totals", () => {
    const tracker = new CostTracker();
    tracker.record(usage("a", 1000, 500));
    tracker.record(usage("a", 2000, 1000));
    tracker.record(usage("b", 500, 500));

    const a = tracker.summaryFor("a");
    expect(a.totalRuns).toBe(2);
    expect(a.totalInputTokens).toBe(3000);
    expect(a.totalOutputTokens).toBe(1500);
    expect(a.avgInputTokens).toBe(1500);
    expect(a.avgDurationMs).toBe(100);

    const b = tracker.summaryFor("b");
    expect(b.totalRuns).toBe(1);
    expect(b.totalInputTokens).toBe(500);
  });

  it("tracks models separately inside each instance", () => {
    const tracker = new CostTracker();
    tracker.record(usage("a", 1000, 0, "deepseek-chat"));
    tracker.record(usage("a", 1000, 0, "deepseek-reasoner"));
    const summary = tracker.summaryFor("a");
    expect(Object.keys(summary.models).sort()).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(summary.models["deepseek-chat"]!.runs).toBe(1);
    // model 维度的对象必须是副本：调用方改它不能把 tracker 内部的聚合改坏。
    summary.models["deepseek-chat"]!.runs = 999;
    expect(tracker.summaryFor("a").models["deepseek-chat"]!.runs).toBe(1);
  });

  it("keeps global totals consistent with instance totals", () => {
    const tracker = new CostTracker();
    tracker.record(usage("a", 1000, 500));
    tracker.record(usage("b", 3000, 100));
    const global = tracker.globalSummary();
    expect(global.instances).toBe(2);
    expect(global.totalRuns).toBe(2);
    expect(global.totalTokens.input).toBe(4000);
    expect(global.totalCostUsd).toBeCloseTo(
      tracker.summaryFor("a").totalCostUsd + tracker.summaryFor("b").totalCostUsd,
      12,
    );
  });

  it("reports zeros for an unknown instance instead of throwing", () => {
    const tracker = new CostTracker();
    const s = tracker.summaryFor("ghost");
    expect(s.totalRuns).toBe(0);
    expect(s.totalCostUsd).toBe(0);
    expect(s.avgCostUsd).toBe(0);
  });
});

describe("CostTracker bounded memory", () => {
  it("caps retained detail records but keeps every accumulated total", () => {
    const tracker = new CostTracker();
    const N = 6000; // 超过 MAX_USAGE_RECORDS(5000)
    for (let i = 0; i < N; i++) tracker.record(usage("a", 10, 10));

    // 明细必须封顶 —— 不封顶的话每条还带着 taskPreview 字符串，就是内存泄漏。
    expect(tracker.records_().length).toBeLessThanOrEqual(5000);
    expect(tracker.recent(3)).toHaveLength(3);

    // 累计值绝对不能跟着丢：这直接决定预算闸门什么时候拦人。
    const summary = tracker.summaryFor("a");
    expect(summary.totalRuns).toBe(N);
    expect(summary.totalInputTokens).toBe(N * 10);
    expect(tracker.globalSummary().totalRuns).toBe(N);
  });

  it("still sees old instances after the detail window rolls over", () => {
    // 一个实例可能只跑过一次然后就被缩容掉；它的成本必须还在 Total 里，
    // 否则集群总花费会被系统性低估。
    const tracker = new CostTracker();
    tracker.record(usage("short-lived", 1000, 1000));
    for (let i = 0; i < 5500; i++) tracker.record(usage("busy", 1, 1));
    expect(tracker.summaryFor("short-lived").totalRuns).toBe(1);
    expect(tracker.summaries()).toHaveLength(2);
  });
});
