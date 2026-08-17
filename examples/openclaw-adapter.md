# OpenClaw 接入 SeekFleet

OpenClaw 是另一个 AI Agent 运行时。和 hermes 同样的思路：以 plugin SDK 为底层，把 DSH 当成 OpenClaw 的一个工具族。

## 方式 A：作为 OpenClaw 的 SDK 工具

```ts
import { SeekFleet } from "seekfleet";

export function createOpenClawTools() {
  const dsh = new SeekFleet({ dshHome: process.env.DSH_HOME });
  return {
    // 给 OpenClaw 注册的工具列表
    dsh_run: {
      schema: dsh.capabilities().find(c => c.id === "dsh.run")!.inputSchema,
      invoke: async (input: { task: string; profile?: string }) => dsh.run(input),
    },
    dsh_inspect: {
      schema: dsh.capabilities().find(c => c.id === "dsh.inspect")!.inputSchema,
      invoke: async () => dsh.inspect(),
    },
    dsh_cluster_route: {
      schema: dsh.capabilities().find(c => c.id === "dsh.cluster.route")!.inputSchema,
      invoke: async (input: { clusterId: string; task: string; tags?: string[] }) =>
        dsh.clusterRoute(input.clusterId, input),
    },
    // ... 其余工具同理
  };
}
```

OpenClaw 的工具注册器只需要循环 `capabilities()` 就能把全部 SDK 能力作为 OpenClaw 工具暴露——这就是「AI 化」的核心：能力清单本身是机器可读的 JSON Schema。

## 方式 B：MCP 桥接（OpenClaw 直接调 dsh）

```bash
seekfleet serve-mcp
# 暴露 stdio MCP server，OpenClaw 用其 MCP 客户端连接即可
```

## 集群用法

OpenClaw 多 Agent 场景下，让不同 agent 路由到不同 dsh 实例：

```ts
const clusterId = dsh.cluster({
  profile: "headless",
  routing: "least-loaded",
  instances: [
    { label: "coder",   tags: ["code"],    concurrency: 2 },
    { label: "planner", tags: ["plan"],    concurrency: 1 },
    { label: "reviewer",tags: ["review"],  concurrency: 1 },
  ],
});

// OpenClaw 的 coder agent 调
await dsh.clusterRoute(clusterId, { task: "...", tags: ["code"] });

// OpenClaw 的 planner agent 调
await dsh.clusterRoute(clusterId, { task: "...", tags: ["plan"] });
```

## 全 AI 自描述

```ts
// 把这套清单扔进 OpenClaw 的 system prompt，让模型自己决定怎么用
const caps = dsh.capabilities();
systemPrompt += "\n\n## Available DSH capabilities:\n" +
  caps.map(c => `- ${c.id}: ${c.description}\n  Input: ${JSON.stringify(c.inputSchema)}`).join("\n");
```
