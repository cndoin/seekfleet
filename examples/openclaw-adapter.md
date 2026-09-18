# OpenClaw 接入 SeekFleet

OpenClaw 是另一个 AI Agent 运行时。和 hermes 同样的思路：以 plugin SDK 为底层，把 DSH 当成 OpenClaw 的一个工具族。

## 方式 A：作为 OpenClaw 的 SDK 工具

```ts
import { SeekFleet, type DshCapability } from "seekfleet";

const dsh = new SeekFleet({ dshHome: process.env.DSH_HOME });

// 能力清单是机器可读的；缺失时不要用 `!` 断言硬取，否则一旦升级改名
// 就会在注册工具时抛 TypeError，把整个 agent 启动流程打断。
function capability(id: string): DshCapability {
  const found = dsh.capabilities().find((c) => c.id === id);
  if (!found) throw new Error(`SeekFleet capability not available: ${id}`);
  return found;
}

export function createOpenClawTools() {
  return {
    // 给 OpenClaw 注册的工具列表
    dsh_run: {
      schema: capability("dsh.run").inputSchema,
      invoke: async (input: { task: string; profile?: string }) => dsh.run(input),
    },
    dsh_inspect: {
      schema: capability("dsh.inspect").inputSchema,
      invoke: async () => dsh.inspect(),
    },
    dsh_cluster_route: {
      schema: capability("dsh.cluster.route").inputSchema,
      invoke: async (input: { clusterId: string; task: string; tags?: string[] }) =>
        dsh.clusterRoute(input.clusterId, input),
    },
    // ... 其余工具同理
  };
}
```

OpenClaw 的工具注册器只需要循环 `capabilities()` 就能把全部 SDK 能力作为 OpenClaw 工具暴露——这就是「AI 化」的核心：能力清单本身是机器可读的 JSON Schema。

`dsh.capabilities()` 会返回 `DshCapability[]`，每项形如：

```ts
{ id: "dsh.run", label: "...", description: "...", inputSchema: { /* JSON Schema */ } }
```

注意能力 id 用点号（`dsh.cluster.route`），而 MCP 工具名用下划线（`dsh_cluster_route`）；两者一一对应，不要混用。

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

## 失败契约（接入必读）

**任务失败不会抛异常。** `dsh` 遇到硬失败（缺 API key、参数非法、工具崩溃）会以非零退出码
结束，而 SDK 仍然**正常 resolve** 一个 `DshResult`。所以上面的 `invoke` 不能只依赖
`try/catch`——它必须把失败翻译成 OpenClaw 能识别的错误：

```ts
dsh_run: {
  schema: capability("dsh.run").inputSchema,
  invoke: async (input: { task: string; profile?: string }) => {
    const r = await dsh.run(input);
    if (r.error) {
      // 失败时 r.answer 一定是空串，直接读它会得到"成功的空答案"
      throw new Error(`dsh run failed [${r.error.code}]: ${r.error.message}`);
    }
    return r;
  },
},
```

`dsh_cluster_route` 同理（`route()` 返回软失败而不抛错）。DAG 的节点状态已经按
`error` / `exitCode !== 0` 判定，失败节点不会被写进结果缓存，其下游节点会被 `skipped`。

常见的 `error.code`：`ABORTED`（超时/取消，可能已有部分答案）、`EXIT_NONZERO`（硬失败，
看 `stderrTail`）、`RUN_FAILED`（进程没起来或流中断）。

## 全 AI 自描述

```ts
// 把这套清单扔进 OpenClaw 的 system prompt，让模型自己决定怎么用
const caps = dsh.capabilities();
systemPrompt += "\n\n## Available DSH capabilities:\n" +
  caps.map(c => `- ${c.id}: ${c.description}\n  Input: ${JSON.stringify(c.inputSchema)}`).join("\n");
```
