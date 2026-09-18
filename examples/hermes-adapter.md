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

之后 hermes 就能看到全部 20 个工具：

| 分组 | 工具 |
| --- | --- |
| 运行时 | `dsh_inspect`, `dsh_run`, `dsh_run_stream`, `dsh_profile_dump`, `dsh_profile_install` |
| 集群 | `dsh_cluster_create`, `dsh_cluster_route`, `dsh_cluster_status`, `dsh_cluster_scale`, `dsh_cluster_shutdown`, `dsh_dag_run`, `dsh_metrics`, `dsh_capability_match` |
| 持久会话 | `dsh_session_create`, `dsh_session_start`, `dsh_session_status`, `dsh_session_events`, `dsh_session_cancel`, `dsh_session_resume`, `dsh_session_result` |

每个工具的输入都附带完整 JSON Schema，hermes 的工具调用器会直接看懂。

## 返回体契约（重要）

所有工具都返回统一信封，hermes 应当按 `ok` 分支，而不是靠解析文本：

```jsonc
// 成功
{ "ok": true, "data": { /* 工具结果 */ } }
// 失败：包括启动失败、策略拦截、预算超限、预算拒绝、流式中断、任务本身崩溃
{ "ok": false, "error": { "code": "RUN_FAILED", "message": "...", "details": { } } }
```

`structuredContent` 字段与信封同构，便于模型直接消费。`dsh_run_stream` 在流中断时返回
`ok: false`，已采集到的事件放在 `error.details.events` 里。

### 失败不是异常，必须显式检查

**这是接入时最容易踩的坑：任务失败不会抛异常。** `dsh` 对硬失败（缺少 API key、参数非法、
工具崩溃）以非零退出码结束，此时 `run()` 会**正常 resolve** 一个带错误的 `DshResult`。所以
SDK 调用方不能只 `try/catch`，必须检查结果：

```ts
const r = await dsh.run("分析这个仓库");
if (r.error) {
  // 失败：按错误码分支，不要去读 r.answer（失败时它必定为空）
  console.error(`[${r.error.code}] ${r.error.message}`);
  return;
}
console.log(r.answer);
```

等价地，`r.exitCode !== 0` 也代表失败。MCP 侧的 `dsh_run` / `dsh_run_stream` /
`dsh_cluster_route` / `dsh_dag_run` 已经做了这个判断，直接看信封的 `ok` 即可。

| `error.code` | 含义 | 处理建议 |
| --- | --- | --- |
| `ABORTED` | 超时或被取消。可能已产出部分答案 | 不要当成功缓存；需要时调大 `timeoutMs` 重试 |
| `EXIT_NONZERO` | `dsh` 以非零码退出（硬失败） | 读 `stderrTail` 定位；缺 key 就先配置凭据 |
| `RUN_FAILED` / `RUN_STREAM_FAILED` | 进程未能启动或流中断 | 检查 `dsh inspect` 的运行时信息 |
| `CLUSTER_NOT_FOUND` | 集群 id 不在注册表中 | 先 `dsh_cluster_create` |
| `DAG_NODE_FAILED` | DAG 有节点失败或被中止 | 细节在 `error.details.dag.nodes[]`，逐节点看 `status` / `error` |

集群和 DAG 内部同样按这个契约判定成功：一个节点只有 `error` 为空且 `exitCode === 0` 才记为
`status: "ok"`，失败节点不会写进结果缓存。
