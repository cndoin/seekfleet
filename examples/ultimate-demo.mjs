import { DshPlugin } from "../dist/src/index.js";

const plugin = new DshPlugin({});
console.log("[1] dsh version:", plugin.inspect().version);

// Create cluster with all the new features enabled
const cid = plugin.cluster({
  profile: "headless",
  instances: [
    { label: "code",    tags: ["code", "default"], concurrency: 1 },
    { label: "research", tags: ["research"],          concurrency: 1 },
    { label: "fast",    tags: ["default"],             concurrency: 1 },
  ],
  routing: "least-loaded",
}, {
  enableCache: true,
  cacheTtlMs: 60_000,
  enableBreaker: true,
  costBudgetUsd: 1.0,
});
console.log("[2] cluster created:", cid);

// Run a few tasks
const tasks = [
  { task: "say CODE", tags: ["code"] },
  { task: "say RESEARCH", tags: ["research"] },
  { task: "say DEFAULT", tags: ["default"] },
  { task: "say CODE", tags: ["code"] },   // duplicate (cache hit)
  { task: "say RESEARCH", tags: ["research"] }, // duplicate (cache hit)
];

for (const t of tasks) {
  try {
    const r = await plugin.clusterRoute(cid, t);
    console.log(`[task ${t.task}] -> instance=${r.instance} cached=${r.cached ?? false} answer=${r.answer}`);
  } catch (e) {
    console.error(`[task ${t.task}] FAIL:`, e.message);
  }
}

// Show cluster status with all the new metrics
console.log("\n[3] cluster status (post-tasks):");
const status = plugin.clusterStatus(cid);
console.log(JSON.stringify({
  routing: status.routing,
  instances: status.instances.map(i => ({
    label: i.label, state: i.state, breaker: i.breaker, score: i.score?.toFixed(3),
    totalRun: i.totalRun, totalErrors: i.totalErrors,
    cost: i.cost ? { totalUsd: i.cost.totalCostUsd.toFixed(6), tokens: i.cost.totalTokens } : null,
  })),
  cache: status.cache,
  cost: status.cost,
}, null, 2));

// Show router score breakdown
console.log("\n[4] router scores for next task:");
const pick = plugin.clusterRaw(cid).pick({ task: "dummy", tags: ["code"] });
console.log(JSON.stringify(pick, null, 2));

// Capability match
console.log("\n[5] capability match:");
const caps = plugin.clusterRaw(cid).capabilities.list();
console.log(JSON.stringify(caps.map(c => ({ label: c.label, profile: c.profile, tags: c.tags, ttlMs: c.ttlMs })), null, 2));

// DAG run
console.log("\n[6] DAG run (3 nodes, 2 with dependency):");
const dagResult = await plugin.clusterDagRun(cid, {
  nodes: [
    { id: "a", task: "say A in one word" },
    { id: "b", task: "say B in one word", dependsOn: ["a"] },
    { id: "c", task: "say C in one word" },
  ],
  concurrency: 2,
});
console.log("DAG result:", JSON.stringify({
  durationMs: dagResult.durationMs,
  order: dagResult.order,
  cacheHits: dagResult.cacheHits,
  failed: dagResult.failed,
  nodes: dagResult.nodes.map(n => ({ id: n.id, status: n.status, instance: n.instance, cached: n.cached, answer: n.result?.answer })),
}, null, 2));

// Metrics as Prometheus
console.log("\n[7] Prometheus metrics:");
console.log(plugin.metricsPrometheus().slice(0, 800));

await plugin.clusterShutdown(cid);
console.log("\n[done] cluster shut down");
