// auto-scaler.test.ts — 事件历史必须是有界的。
//
// AutoScaler 是常驻后台任务（默认每 5 秒一个 tick），每条事件还带着 reason 字符串。
// 一个跑几天的集群如果不封顶，这就是一条稳定向上的内存曲线。这个文件的存在
// 就是为了防止有人把 trim 改回去。

import { describe, expect, it } from "vitest";
import { AutoScaler, type ScalingEvent } from "../src/auto-scaler.js";

/** 通过类型断言触达 private 方法 —— 这里要验的是内部不变量，不是公开 API。 */
type Internals = {
  scaleUp(nBefore: number): Promise<void>;
  scaleDown(replicas: string[], nBefore: number): Promise<void>;
};

function scaler(hooks: { spawn?: () => Promise<void>; despawn?: () => Promise<void> } = {}) {
  return new AutoScaler(
    {
      profile: "headless",
      minReplicas: 1,
      maxReplicas: 8,
      scaleUpThreshold: 4,
      scaleUpAfterMs: 1000,
      scaleDownThreshold: 1,
      scaleDownAfterMs: 1000,
      pollIntervalMs: 50,
      cooldownMs: 0,
    },
    {
      spawn: hooks.spawn ?? (async () => undefined),
      despawn: hooks.despawn ?? (async () => undefined),
      queueDepth: () => 0,
      replicas: () => ["a", "b"],
    },
  );
}

describe("AutoScaler event history", () => {
  it("caps retained events no matter how many actions are taken", async () => {
    const value = scaler();
    const internal = value as unknown as Internals;
    for (let i = 0; i < 600; i++) await internal.scaleUp(1);
    expect(value.events.length).toBeLessThanOrEqual(500);
  });

  it("keeps the most recent events when trimming", async () => {
    const value = scaler();
    const internal = value as unknown as Internals;
    for (let i = 0; i < 520; i++) await internal.scaleUp(i);
    const last = value.events[value.events.length - 1] as ScalingEvent;
    // 环形缓冲必须保留尾部：排查「刚刚为什么扩容了」靠的就是最后这几条。
    expect(last.action).toBe("up");
    expect(last.replicasBefore).toBe(519);
  });

  it("records both successes and failures, since a failed scale is the interesting one", async () => {
    const failing = scaler({
      spawn: async () => {
        throw new Error("quota exceeded");
      },
    });
    const internal = failing as unknown as Internals;
    await internal.scaleUp(2);
    expect(failing.events).toHaveLength(1);
    expect(failing.events[0]!.action).toBe("noop");
    // 失败原因必须留下来 —— 「实例没扩上来」和「扩失败了」是完全不同的两件事。
    expect(failing.events[0]!.reason).toContain("quota exceeded");
  });

  it("bounds down-scale events too", async () => {
    const value = scaler();
    const internal = value as unknown as Internals;
    for (let i = 0; i < 520; i++) await internal.scaleDown(["a", "b"], 2);
    expect(value.events.length).toBeLessThanOrEqual(500);
  });
});
