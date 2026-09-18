// 部门化编排示例 —— planner 拆 -> worker 并行做 -> reviewer 独立验收。
//
// Run: node examples/orchestration-departments.mjs
//
// 这个示例演示的是「怎么让一组 agent 真的像一个组织那样干活」，而不是怎么
// 并发发出去。每一步背后都有论文依据：
//
//   1. 先用 planner 拆解，且 planner 被禁止执行任何改动类工具
//      —— MAST: 任务规格与角色边界不清 => 系统设计类失败占 44.2%
//   2. worker 并行执行，但并行度由 recommendFanout(effort) 决定
//      —— Anthropic: 不写 effort 规则，模型会为简单问题开出几十个子 agent
//   3. reviewer 独立执行**可执行的**验收命令，且禁止它自己动手改文件
//      —— MAST: 任务验证类失败占 ~23%；模型自评不可靠
//   4. 最后打印归因报告：这批任务到底在哪一类失败上最吃亏
//      —— 归因的目的永远是改结构，不是换模型
//
// 三件事做对了，多 agent 才划算；做不对的话，等算力预算下单个 agent 更强
// （Tran & Kiela, arXiv:2604.02460 —— 每次交接只丢信息，不增加信息）。

import { DshPlugin } from "../dist/src/index.js";

const plugin = new DshPlugin({});

// 每个 effort 档位允许的实例数；maxParallelSubtasks 是硬闸门。
const clusterId = plugin.cluster({
  profile: "headless",
  instances: [
    { label: "thinker", profile: "headless", tags: ["plan"], concurrency: 1 },
    { label: "doer-1", profile: "headless", tags: ["work"], concurrency: 2 },
    { label: "doer-2", profile: "headless", tags: ["work"], concurrency: 2 },
    { label: "checker", profile: "headless", tags: ["review"], concurrency: 1 },
  ],
  routing: "tag",
  maxParallelSubtasks: 3,
});

const goal = process.argv[2] ?? "给 SeekFleet 的 README 补一段“快速上手”，要求给出一条可直接复制的命令。";

console.log("[step 1] planner 拆解任务");
// planner 的输出被契约约束成 { subtasks: [{id, goal, dependsOn, acceptance}] }，
// 交不出合规 JSON 即为失败 —— 这一步就挡住了「违反任务规格」。
const plan = await plugin.clusterRoute(clusterId, {
  task: `把下面这个目标拆成互不重叠、可并行的最小子任务：\n${goal}`,
  tags: ["plan"],
  role: "planner",
  effort: "low",
});

if (plan.error) {
  // 关键：失败时不要只看 message，先把归因打出来，才知道该改哪里。
  console.error("[plan failed]", plan.error.message);
  console.error("[attribution]", JSON.stringify(plan.audit?.attribution?.signals ?? [], null, 2));
  process.exit(1);
}

const subtasks = plan.audit?.role?.parsedOutput?.subtasks ?? [];
console.log("[step 1] 拆出", subtasks.length, "个子任务");
for (const s of subtasks) console.log("   -", s.id, "|", s.goal);

if (subtasks.length === 0) {
  console.error("[abort] planner 没有产出任何子任务 —— 多半是目标本身不清楚");
  process.exit(1);
}

// effort 闸门：并行度不是「有多少实例就开多少」。
if (subtasks.length > 8) {
  console.error("[abort] 子任务过多（" + subtasks.length + "）。拆分本身有损，先让 planner 收敛范围。");
  process.exit(1);
}

console.log("\n[step 2] worker 并行执行");
const workerResults = await Promise.all(
  subtasks.map((s) =>
    plugin.clusterRoute(clusterId, {
      task: `执行子任务 ${s.id}：\n${s.goal}\n\n验收标准：${s.acceptance}`,
      tags: ["work"],
      role: "worker",
      effort: "medium",
      // worker 必须按 {status, summary} 交差 —— 空话不算完成。
      verify: [{ kind: "answer-min-length", min: 20, name: "必须给出实质总结" }],
    }),
  ),
);

for (const [i, r] of workerResults.entries()) {
  const s = subtasks[i];
  const status = r.error ? "FAILED " + r.error.code : "ok";
  console.log("   -", s.id, "=>", status);
  if (r.audit?.role?.parsedOutput?.summary) console.log("       ", r.audit.role.parsedOutput.summary);
}

console.log("\n[step 3] reviewer 独立验收（禁止它自己动手改）");
const handoff = subtasks
  .map((s, i) => {
    const r = workerResults[i];
    return {
      id: s.id,
      acceptance: s.acceptance,
      worker: r.error ? "FAILED: " + r.error.message : r.audit?.role?.parsedOutput?.summary ?? "(no summary)",
    };
  })
  .map((x) => JSON.stringify(x))
  .join("\n");

const review = await plugin.clusterRoute(clusterId, {
  task: `以下是若干子任务的执行结果，请你逐条对照验收标准裁定：\n${handoff}`,
  tags: ["review"],
  role: "reviewer",
  effort: "low",
  verify: [
    // 独立、可执行、与执行者隔离：这才是验收。
    { kind: "answer-match", pattern: '"verdict"', name: "必须给出 verdict" },
  ],
});

if (review.error) {
  console.error("[review failed]", review.error.message);
} else {
  console.log("[review]", JSON.stringify(review.audit?.role?.parsedOutput, null, 2));
}

console.log("\n[step 4] 归因：这批任务在哪一类失败上最吃亏");
for (const line of formatAttributionLines(plugin, clusterId)) console.log(line);

await plugin.clusterShutdown(clusterId);

function formatAttributionLines(p, clusterIdentifier) {
  // DshPlugin 没有直接暴露 attributionReport，走 status() 的汇总即可。
  const status = p.clusterStatus(clusterIdentifier);
  const a = status.attribution;
  if (!a) return ["   （没有样本 —— 这是「没有数据」，不是「零失败」）"];
  const lines = [
    `   失败率 ${(a.failureRate * 100).toFixed(0)}%（${a.failedTraces}/${a.totalTraces}）`,
    "   三类分布：",
    ...a.byCategory.map((c) => `     ${c.category.padEnd(14)} ${(c.share * 100).toFixed(0)}%`),
    "   最常命中的模式（对照 MAST 基准 system-design 44.2% / inter-agent 32.3% / verification 23.5%）：",
  ];
  for (const row of a.top ?? []) lines.push(`     ${row.code} ${row.labelZh} ×${row.count} → ${row.fix}`);
  return lines;
}
