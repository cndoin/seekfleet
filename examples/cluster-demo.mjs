// Cluster demo - shows 3-instance cluster routing 5 tasks.
// Run: node examples/cluster-demo.mjs

import { DshPlugin } from "../dist/src/index.js";

const plugin = new DshPlugin({});
const insp = plugin.inspect();
console.log("[demo] dsh version:", insp.version, "at", insp.dshModuleRoot);

const clusterId = plugin.cluster({
  profile: "headless",
  instances: [
    { label: "code-1",   profile: "headless", tags: ["code", "default"], concurrency: 1 },
    { label: "code-2",   profile: "headless", tags: ["code", "default"], concurrency: 1 },
    { label: "research", profile: "headless", tags: ["research"],        concurrency: 1 },
  ],
  routing: "tag",
});

console.log("[demo] cluster created:", clusterId);
console.log(plugin.clusterStatus(clusterId));

const tasks = [
  { task: "回答我：1+1 等于几？", tags: ["default"] },
  { task: "解释 Rust 的所有权机制。", tags: ["code"] },
  { task: "总结 2025 年 LLM 领域三个最重要进展。", tags: ["research"] },
  { task: "写一个 Python 函数计算斐波那契。", tags: ["code"] },
  { task: "评估 Transformer 是否会被 Mamba 取代。", tags: ["research"] },
];

for (const t of tasks) {
  console.log("\n[demo] routing task tagged", t.tags, "->", t.task.slice(0, 30) + "...");
  try {
    const result = await plugin.clusterRoute(clusterId, t);
    console.log("[demo] -> instance:", result.instance);
    console.log("[demo] -> answer:", result.answer.slice(0, 200));
  } catch (err) {
    console.error("[demo] route failed:", err.message);
  }
}

console.log("\n[demo] final cluster status:");
console.log(JSON.stringify(plugin.clusterStatus(clusterId), null, 2));

await plugin.clusterShutdown(clusterId);
console.log("[demo] cluster shut down");