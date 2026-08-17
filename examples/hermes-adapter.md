# Hermes 接入 SeekFleet

Hermes 是一个 AI Agent 框架，下面是把它和 DSH 接通的最小示例。

## 安装

```bash
npm install seekfleet
```

确保 `@deepseek-ai/dsh` 已经被安装（或设置 `DSH_MODULE_ROOT` 环境变量指向它）。

## 最小集成

```ts
import { SeekFleet } from "seekfleet";

const dsh = new SeekFleet({
  dshHome: process.env.DSH_HOME,         // 可选；默认 ~/.dsh
  workspace: process.cwd(),              // 工作区根
  installIfMissing: true,                // 找不到 dsh 时自动尝试安装
});

// 1. 让 hermes 先做自描述：把 capabilities() 拼进 system prompt
const sys = [
  "你可以调用以下 DSH 能力（每个对应一个 JSON Schema 工具）：",
  JSON.stringify(dsh.capabilities(), null, 2),
].join("\n");

// 2. 单任务
const result = await dsh.run("分析 src/index.ts 的依赖");
console.log(result.answer);

// 3. 流式（hermes 想看中间事件就用 stream）
for await (const evt of dsh.stream("重构这个模块")) {
  if (evt.kind === "tool_call") console.log("[tool]", evt.data);
  if (evt.kind === "answer")     console.log("[ans]",  evt.data);
}

// 4. 集群
const clusterId = dsh.cluster({
  profile: "headless",
  instances: [
    { label: "a", profile: "headless", tags: ["code"] },
    { label: "b", profile: "headless", tags: ["code"] },
    { label: "c", profile: "headless", tags: ["research"] },
  ],
  routing: "tag",
});

const r = await dsh.clusterRoute(clusterId, {
  task: "解释 React Server Components",
  tags: ["code"],
});
console.log(r.instance, r.answer);

await dsh.clusterShutdown(clusterId);
```

## 通过 MCP 接入（推荐）

如果 hermes 原生支持 MCP，直接 stdio 启动：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "npx",
      "args": ["-y", "seekfleet", "serve-mcp"],
      "env": { "DSH_HOME": "/path/to/dsh-home" }
    }
  }
}

```

之后 hermes 就能看到这些工具：`dsh_inspect`, `dsh_run`, `dsh_run_stream`, `dsh_cluster_create`, `dsh_cluster_route`, `dsh_cluster_status`, `dsh_cluster_scale`, `dsh_cluster_shutdown`, `dsh_profile_dump`, `dsh_profile_install`。

每个工具的输入都附带完整 JSON Schema，hermes 的工具调用器会直接看懂。
