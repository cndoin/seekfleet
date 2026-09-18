// mcp-server.ts - stdio MCP server exposing DSH capabilities to any MCP-aware AI.
//
// Built on the modern McpServer high-level API (Anthropic MCP TypeScript SDK).
// Every tool is registered with:
//   - Zod input schema (auto-validated, auto-converted to JSON Schema)
//   - annotations: readOnlyHint / destructiveHint / idempotentHint / openWorldHint
//   - structuredContent envelope ({ok, data, error}) so AI callers can branch reliably
//   - pagination + character-limit handling where applicable
//
// Tools (22): runtime/profile, cluster/DAG/metrics, capability matching,
//             seven durable session lifecycle operations, and two failure
//             attribution tools (MAST).
//
// 为什么要有归因工具：多 agent 系统 40%-90% 的失败率里，绝大部分集中在
// 固定的十几条模式上（arXiv:2503.13657）。一个 harness 如果在失败时只知道
// 「失败了」，它下一次会以完全相同的方式再失败一次。把「这次是哪种失败」
// 回给调用方，才有可能让它改结构而不是改 prompt。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { DshClient } from "./dsh-client.js";
import { DshCluster } from "./dsh-cluster.js";
import { inspect, SDK_CAPABILITIES } from "./discovery.js";
import { dumpProfileConfig, profilePluginAction } from "./profiles.js";
import { loadPolicy, PolicyEnforcer } from "./policy-enforcer.js";
import { resolveDsh } from "./install.js";
import { SessionManager } from "./session-manager.js";
import { packageVersion } from "./version.js";
import { startDashboardServer, type DashboardServerHandle, type DashboardSnapshot } from "./dashboard-server.js";
import { DEPARTMENTS } from "./role-spec.js";
import { aggregateFailures, classifyTrace, formatAttribution, MAST_BASELINE, type TraceView } from "./mast.js";
import type { DshClusterSpec, DshEnvelope, DshInstanceSpec, DshResult, DshTask } from "./types.js";
import type { RoleSpec } from "./role-spec.js";
import type { VerifyRule } from "./verifier.js";

/** MCP 2025-11-25 recommended CHARACTER_LIMIT for tool output. */
export const CHARACTER_LIMIT = 25_000;

/**
 * Canonical tool list. Kept next to the registrations so that the discovery
 * manifest (.well-known/mcp.json) and the docs can be asserted against it —
 * the manifest previously advertised 13 of the 20 tools and a binary path that
 * did not exist, which silently broke harness auto-configuration.
 */
export const MCP_TOOL_NAMES = [
  "dsh_inspect",
  "dsh_run",
  "dsh_run_stream",
  "dsh_profile_dump",
  "dsh_profile_install",
  "dsh_cluster_create",
  "dsh_cluster_route",
  "dsh_cluster_status",
  "dsh_cluster_scale",
  "dsh_cluster_shutdown",
  "dsh_dag_run",
  "dsh_metrics",
  "dsh_session_create",
  "dsh_session_start",
  "dsh_session_status",
  "dsh_session_events",
  "dsh_session_cancel",
  "dsh_session_resume",
  "dsh_session_result",
  "dsh_capability_match",
  "dsh_trace_classify",
  "dsh_cluster_attribution",
] as const;

/** 内置部门名，用于 zod enum 与工具描述（保持和 DEPARTMENTS 单一数据源）。 */
const DEPARTMENT_NAMES = Object.keys(DEPARTMENTS) as [string, ...string[]];

/**
 * 描述性的 role / verify 参数说明。
 *
 * Anthropic 的经验：把工具描述当成产品文案来写、并用 agent 反复试用重写，
 * 任务完成时间能降 40%。SeekFleet 的核心就是把工具暴露给 harness，
 * 所以这里的描述必须让一个从没见过的模型也能立刻用对。
 */
const ROLE_DESCRIPTION =
  "内置部门名(" +
  DEPARTMENT_NAMES.join("/") +
  ")或一份完整 RoleSpec 对象。给角色=给约束：会编译成契约注入 prompt，并在任务结束后审计工具边界/步数/输出 schema。";

const VERIFY_DESCRIPTION =
  "任务结束后由框架独立执行的校验规则列表。模型自评不可靠，这一层才是验收。kind 取值: " +
  "command(argv 数组) | answer-schema | answer-match | answer-not-match | answer-min-length | " +
  "file-exists | max-tool-calls | tool-not-used。未知 kind 会被明确判失败，不会静默跳过。";

interface ClusterEntry {
  cluster: DshCluster;
  client: DshClient;
  spec: DshClusterSpec;
  createdAt: number;
}
const clusters = new Map<string, ClusterEntry>();
let sharedClient: DshClient | null = null;

/** PART-2: load persisted policy at startup so the MCP server enforces it. */
function getPolicy() {
  const { dshHome } = resolveDsh({});
  return loadPolicy(dshHome);
}

function getClient(): DshClient {
  if (!sharedClient) {
    sharedClient = new DshClient({ policy: getPolicy() ?? undefined });
  }
  return sharedClient;
}

// PART-3: singleton SessionManager for long-running task lifecycle.
let sessionManager: SessionManager | null = null;
function getSessionManager(): SessionManager {
  if (!sessionManager) {
    const { dshHome } = resolveDsh({});
    const policy = getPolicy();
    sessionManager = new SessionManager({
      dshHome,
      policy: policy ? new PolicyEnforcer(policy) : undefined,
    });
  }
  return sessionManager;
}

function ok<T>(data: T): DshEnvelope<T> {
  return { ok: true, data };
}
function err(code: string, message: string, details?: unknown): DshEnvelope<never> {
  return { ok: false, error: { code, message, details } };
}

/**
 * Failure carried by a *resolved* DshResult, or undefined when the run
 * succeeded. Task runners resolve with a failed result instead of throwing —
 * `summarize()` reports a non-zero exit through `result.error`, and
 * `cluster.route()` deliberately returns soft failures. An envelope that only
 * looked for a thrown error therefore told the harness `ok: true` for a task
 * that had actually crashed, which is what made the harness integrations
 * unreliable.
 */
function taskFailure(result: DshResult | undefined): { code: string; message: string } | undefined {
  if (!result) return undefined;
  if (result.error) return { code: result.error.code ?? "RUN_FAILED", message: result.error.message };
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return { code: "EXIT_NONZERO", message: "dsh exited with code " + result.exitCode };
  }
  return undefined;
}

/** Same check as taskFailure, but read off a collected DshEvent stream. */
function streamFailure(events: unknown[]): { code: string; message: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as {
      kind?: string;
      data?: { exitCode?: number | null; aborted?: boolean; message?: string };
    };
    if (e?.kind !== "exit" && e?.kind !== "error") continue;
    if (e.data?.aborted === true) return { code: "ABORTED", message: "task aborted or timed out" };
    if (typeof e.data?.exitCode === "number" && e.data.exitCode !== 0) {
      return { code: "EXIT_NONZERO", message: "dsh exited with code " + e.data.exitCode };
    }
    return undefined; // the latest terminal event reports success
  }
  return undefined;
}

/** Render an envelope as a truncated text block. */
function renderText(
  env: DshEnvelope<unknown>,
  maxChars = CHARACTER_LIMIT,
): {
  text: string;
  truncated: boolean;
  originalLength: number;
} {
  const full = JSON.stringify(env, null, 2);
  if (full.length <= maxChars) return { text: full, truncated: false, originalLength: full.length };
  const truncated =
    full.slice(0, maxChars) +
    `\n\n... [TRUNCATED: ${full.length - maxChars} chars omitted; increase tool-specific limit or stream the call] ...`;
  return { text: truncated, truncated: true, originalLength: full.length };
}

/** Wrap envelope into MCP tool result. Uses structuredContent for AI-validated JSON. */
function toMcpResult(env: DshEnvelope<unknown>) {
  const rendered = renderText(env);
  const out: { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> } = {
    content: [{ type: "text", text: rendered.text }],
  };
  if (env.ok && env.data !== undefined) {
    out.structuredContent = {
      ok: true,
      data: env.data,
      truncated: rendered.truncated,
      originalLength: rendered.originalLength,
    };
  } else if (!env.ok && env.error) {
    out.structuredContent = {
      ok: false,
      error: env.error,
      truncated: rendered.truncated,
      originalLength: rendered.originalLength,
    };
  }
  return out;
}

/** Apply limit/offset pagination to an array. Returns {items, hasMore, total}. */
function paginate<T>(
  items: T[],
  limit?: number,
  offset?: number,
): {
  items: T[];
  hasMore: boolean;
  total: number;
  nextOffset?: number;
} {
  const total = items.length;
  const start = Math.max(0, offset ?? 0);
  const end = limit !== undefined ? start + limit : total;
  const slice = items.slice(start, end);
  const hasMore = end < total;
  return { items: slice, hasMore, total, nextOffset: hasMore ? end : undefined };
}

export interface ServeMcpOptions {
  dashboard?: boolean;
  dashboardHost?: string;
  dashboardPort?: number;
  dashboardToken?: string;
}

export async function serveMcp(opts: ServeMcpOptions = {}): Promise<void> {
  const server = new McpServer(
    { name: "seekfleet-mcp-server", version: packageVersion() },
    {
      capabilities: { tools: {} },
      instructions:
        "SeekFleet MCP server. Exposes " +
        MCP_TOOL_NAMES.length +
        " tools for running and controlling DeepSeek Harness " +
        "(dsh) as one-shot tasks and as a multi-instance cluster. Every tool returns " +
        "a {ok, data?, error?} envelope; the structuredContent field mirrors the envelope " +
        "for AI-validated consumption. Use dsh_inspect first to discover the runtime.\n" +
        "Multi-agent quality controls: pass `role` (planner/worker/reviewer/synthesizer or a full " +
        "RoleSpec) and `verify` rules to dsh_run / dsh_cluster_route — the contract is injected " +
        "into the prompt and audited afterwards; a violation is reported as a failure, not a " +
        "warning. When a task fails, call dsh_trace_classify to find out which of the 14 MAST " +
        "failure modes it hit, and dsh_cluster_attribution to see where the cluster loses the " +
        "most money.",
    },
  );

  // ---------- dsh_inspect (read-only, idempotent, no side effects) ----------
  server.registerTool(
    "dsh_inspect",
    {
      title: "Inspect DSH install",
      description:
        "Return the dsh install location, version, available profiles, builtin tools, " +
        "and SDK capabilities. AI uses this for self-orientation. No side effects.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return toMcpResult(ok(inspect({}))) as never;
      } catch (e) {
        return toMcpResult(err("INSPECT_FAILED", e instanceof Error ? e.message : String(e))) as never;
      }
    },
  );

  // ---------- dsh_run (not read-only, not idempotent, may affect external state) ----------
  server.registerTool(
    "dsh_run",
    {
      title: "Run a one-shot DSH task",
      description:
        "Spawn dsh headless profile with a single task string. Returns the final answer " +
        "plus usage and tool-call audit. The agent may invoke external tools (file system, " +
        "shell, web) per its profile; treat as open-world.",
      inputSchema: {
        task: z.string().min(1).describe("Natural-language task for the agent"),
        profile: z.string().optional().describe("Profile name (default: headless)"),
        cwd: z.string().optional().describe("Workspace cwd"),
        timeoutMs: z.number().int().positive().optional().describe("Per-task timeout in ms (default 600000)"),
        patches: z.array(z.string()).optional().describe("Patch overlay files"),
        env: z.record(z.string(), z.string()).optional().describe("Extra env vars"),
        tags: z.array(z.string()).optional().describe("Tags for cluster routing"),
        label: z.string().optional().describe("Human-readable label"),
        role: z
          .union([z.string(), z.record(z.unknown())])
          .optional()
          .describe(ROLE_DESCRIPTION),
        verify: z.array(z.record(z.unknown())).optional().describe(VERIFY_DESCRIPTION),
        thinkingTokenBudget: z.number().int().positive().optional().describe("思考 token 预算；超出只记录不禁行"),
        effort: z.enum(["low", "medium", "high"]).optional().describe("工作量档位，用于上层决定并行度"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await getClient().run(toTask(args));
        const failure = taskFailure(result);
        if (failure) return toMcpResult(err(failure.code, failure.message, { result })) as never;
        return toMcpResult(ok({ result, instance: "shared" })) as never;
      } catch (e) {
        return toMcpResult(err("RUN_FAILED", e instanceof Error ? e.message : String(e))) as never;
      }
    },
  );

  // ---------- dsh_run_stream ----------
  server.registerTool(
    "dsh_run_stream",
    {
      title: "Stream a DSH task event-by-event",
      description:
        "Run a task and yield each DshEvent (log, tool_call, tool_result, answer, exit) " +
        "as it arrives. Returns the full event sequence in one response. For very long " +
        "tasks, create a durable session (dsh_session_create) and poll it with " +
        "dsh_session_events instead.",
      inputSchema: {
        task: z.string().min(1),
        profile: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const events: unknown[] = [];
      try {
        for await (const evt of getClient().stream(toTask(args))) events.push(evt);
        // A stream that ends on a non-zero exit does not throw, so the terminal
        // event has to be inspected or a crashed run looks like a clean one.
        const failure = streamFailure(events);
        if (failure) return toMcpResult(err(failure.code, failure.message, { events })) as never;
        return toMcpResult(ok({ events })) as never;
      } catch (e) {
        // The documented contract is {ok, data?, error?} so callers can branch.
        // Reporting ok:true here made a failed stream indistinguishable from a
        // successful one; the collected events are preserved under details.
        const message = e instanceof Error ? e.message : String(e);
        events.push({ kind: "error", ts: Date.now(), seq: -1, data: { message } });
        return toMcpResult(err("RUN_STREAM_FAILED", message, { events })) as never;
      }
    },
  );

  // ---------- dsh_profile_dump ----------
  server.registerTool(
    "dsh_profile_dump",
    {
      title: "Dump a profile's composed config tree",
      description:
        "Equivalent of `dsh --dump-config <profile>`. Returns the composed patch layer " +
        "tree as YAML plus a tail of stderr for debugging. Read-only.",
      inputSchema: {
        profile: z.string().min(1).describe("Profile name"),
        patches: z.array(z.string()).optional(),
        defaultOnly: z.boolean().optional().describe("Skip user layer and --patch overlays"),
        limit: z
          .number()
          .int()
          .positive()
          .max(CHARACTER_LIMIT)
          .optional()
          .describe("Max chars to return for the YAML (default 25000)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const r = await dumpProfileConfig(getClient(), {
          profile: args.profile,
          patches: args.patches,
          defaultOnly: args.defaultOnly,
        });
        const limit = args.limit ?? CHARACTER_LIMIT;
        const yaml =
          r.yaml.length > limit
            ? r.yaml.slice(0, limit) + `\n# ... [TRUNCATED ${r.yaml.length - limit} chars]`
            : r.yaml;
        return toMcpResult(ok({ yaml, stderrTail: r.stderr.split("\n").slice(-10).join("\n") })) as never;
      } catch (e) {
        return toMcpResult(err("DUMP_FAILED", e instanceof Error ? e.message : String(e))) as never;
      }
    },
  );

  // ---------- dsh_profile_install (writes to pnpm/npm, definitely not read-only) ----------
  server.registerTool(
    "dsh_profile_install",
    {
      title: "Install/uninstall a plugin for a profile",
      description:
        "Adds or removes a plugin from a profile by forwarding to pnpm in the profile " +
        "directory. May download packages from npm; treat as open-world.",
      inputSchema: {
        profile: z.string().min(1),
        action: z.enum(["add", "remove", "why"]),
        pkg: z.string().min(1).describe("Package name, e.g. @deepseek-ai/dsh-tool-bash"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const r = await profilePluginAction(getClient(), args);
        return toMcpResult(ok(r)) as never;
      } catch (e) {
        return toMcpResult(err("INSTALL_FAILED", e instanceof Error ? e.message : String(e))) as never;
      }
    },
  );

  // ---------- dsh_cluster_create ----------
  server.registerTool(
    "dsh_cluster_create",
    {
      title: "Create a cluster of N DSH instances",
      description:
        "Spawns N instances under a shared workspace + dshHome. Returns the cluster id " +
        "and a status snapshot. Instances are spawned lazily on first route.",
      inputSchema: {
        profile: z.string().optional().describe("Shared default profile"),
        routing: z
          .enum(["round-robin", "least-loaded", "tag", "random"])
          .optional()
          .describe("Routing strategy (default least-loaded)"),
        instances: z
          .array(
            z.object({
              label: z.string().min(1),
              profile: z.string().optional(),
              tags: z.array(z.string()).optional(),
              concurrency: z.number().int().positive().optional(),
              patches: z.array(z.string()).optional(),
              env: z.record(z.string(), z.string()).optional(),
              cwd: z.string().optional(),
            }),
          )
          .min(1),
        workspace: z.string().optional(),
        dshHome: z.string().optional(),
        healthIntervalMs: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const spec: DshClusterSpec = {
          profile: args.profile,
          instances: args.instances as DshInstanceSpec[],
          routing: args.routing,
          workspace: args.workspace,
          dshHome: args.dshHome,
          healthIntervalMs: args.healthIntervalMs,
        };
        const client = getClient();
        const cluster = new DshCluster({
          ...spec,
          client: {
            dshModuleRoot: client.resolved.moduleRoot,
            dshHome: client.resolved.dshHome,
            workspace: client.resolved.dshHome,
          },
          // PART-2: pass policy through so every cluster.route() / stream() enforces it.
          policy: getPolicy() ?? undefined,
        });
        const id = randomUUID();
        clusters.set(id, { cluster, client, spec, createdAt: Date.now() });
        return toMcpResult(ok({ clusterId: id, status: cluster.status() })) as never;
      } catch (e) {
        return toMcpResult(err("CLUSTER_CREATE_FAILED", e instanceof Error ? e.message : String(e))) as never;
      }
    },
  );

  // ---------- dsh_cluster_route ----------
  server.registerTool(
    "dsh_cluster_route",
    {
      title: "Route a task through a cluster",
      description:
        "Pick an instance via the cluster's routing strategy and run the task. " +
        "Returns the result + which instance handled it.",
      inputSchema: {
        clusterId: z.string().min(1),
        task: z.string().min(1),
        tags: z.array(z.string()).optional(),
        profile: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        label: z.string().optional(),
        role: z
          .union([z.string(), z.record(z.unknown())])
          .optional()
          .describe(ROLE_DESCRIPTION),
        verify: z.array(z.record(z.unknown())).optional().describe(VERIFY_DESCRIPTION),
        thinkingTokenBudget: z.number().int().positive().optional(),
        effort: z.enum(["low", "medium", "high"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const e = clusters.get(args.clusterId);
        if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
        const t: DshTask = toTask(args as unknown as Record<string, unknown>);
        const result = await e.cluster.route(t);
        // route() 会把契约违约/验证失败翻译成 result.error；这里不二次转换，
        // 直接沿用 dsh_run 的那条判定路径，保证两个工具的失败语义一致。
        const failure = taskFailure(result);
        if (failure) return toMcpResult(err(failure.code, failure.message, { result })) as never;
        return toMcpResult(ok({ result, instance: result.instance })) as never;
      } catch (e2) {
        return toMcpResult(err("CLUSTER_ROUTE_FAILED", e2 instanceof Error ? e2.message : String(e2))) as never;
      }
    },
  );

  // ---------- dsh_cluster_status (paginated) ----------
  server.registerTool(
    "dsh_cluster_status",
    {
      title: "Get cluster status",
      description:
        "Returns a snapshot: routing strategy, instance count, per-instance state, " +
        "in-flight count, total runs, last error. Supports limit/offset pagination over " +
        "the instance list.",
      inputSchema: {
        clusterId: z.string().min(1),
        limit: z.number().int().positive().max(100).optional().describe("Max instances per page (default 50)"),
        offset: z.number().int().nonnegative().optional().describe("Pagination offset (default 0)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const e = clusters.get(args.clusterId);
        if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
        const status = e.cluster.status();
        const page = paginate(status.instances, args.limit, args.offset);
        return toMcpResult(
          ok({
            routing: status.routing,
            workspace: status.workspace,
            dshHome: status.dshHome,
            createdAt: status.createdAt,
            instances: page.items,
            pagination: {
              total: page.total,
              hasMore: page.hasMore,
              nextOffset: page.nextOffset,
              limit: args.limit,
              offset: args.offset ?? 0,
            },
          }),
        ) as never;
      } catch (e2) {
        return toMcpResult(err("CLUSTER_STATUS_FAILED", e2 instanceof Error ? e2.message : String(e2))) as never;
      }
    },
  );

  // ---------- dsh_cluster_scale ----------
  server.registerTool(
    "dsh_cluster_scale",
    {
      title: "Scale a cluster",
      description: "Add or remove instances by profile and replica count, or by explicit add/remove lists.",
      inputSchema: {
        clusterId: z.string().min(1),
        profile: z.string().optional(),
        replicas: z.number().int().nonnegative().optional(),
        add: z
          .array(
            z.object({
              label: z.string(),
              profile: z.string().optional(),
              tags: z.array(z.string()).optional(),
              concurrency: z.number().int().positive().optional(),
            }),
          )
          .optional(),
        remove: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const e = clusters.get(args.clusterId);
        if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
        const status = await e.cluster.scale({
          profile: args.profile,
          replicas: args.replicas,
          add: args.add as DshInstanceSpec[] | undefined,
          remove: args.remove,
        });
        return toMcpResult(ok({ status })) as never;
      } catch (e2) {
        return toMcpResult(err("CLUSTER_SCALE_FAILED", e2 instanceof Error ? e2.message : String(e2))) as never;
      }
    },
  );

  // ---------- dsh_cluster_shutdown ----------
  server.registerTool(
    "dsh_cluster_shutdown",
    {
      title: "Shutdown a cluster",
      description: "Gracefully stops all instances. Waits up to timeoutMs for in-flight tasks to drain.",
      inputSchema: {
        clusterId: z.string().min(1),
        timeoutMs: z.number().int().nonnegative().optional().describe("Drain timeout in ms (default 5000)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const e = clusters.get(args.clusterId);
        if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
        const timeoutMs = args.timeoutMs ?? 5000;
        await e.cluster.shutdown(timeoutMs);
        clusters.delete(args.clusterId);
        return toMcpResult(ok({ clusterId: args.clusterId, status: "shutdown" })) as never;
      } catch (e2) {
        return toMcpResult(err("CLUSTER_SHUTDOWN_FAILED", e2 instanceof Error ? e2.message : String(e2))) as never;
      }
    },
  );

  // ---------- dsh_dag_run ----------
  server.registerTool(
    "dsh_dag_run",
    {
      title: "Run a DAG of dependent tasks",
      description:
        "Submit a DAG of tasks with dependencies. Tasks run in topological order; independent tasks run in parallel up to concurrency.",
      inputSchema: {
        clusterId: z.string().min(1),
        nodes: z
          .array(
            z.object({
              id: z.string().min(1),
              task: z.string().min(1),
              dependsOn: z.array(z.string()).optional(),
              profile: z.string().optional(),
              tags: z.array(z.string()).optional(),
              timeoutMs: z.number().int().positive().optional(),
              critical: z.boolean().optional(),
              includeDependencyResults: z.boolean().optional(),
              role: z
                .union([z.string(), z.record(z.unknown())])
                .optional()
                .describe(ROLE_DESCRIPTION),
              verify: z.array(z.record(z.unknown())).optional().describe(VERIFY_DESCRIPTION),
              effort: z.enum(["low", "medium", "high"]).optional(),
            }),
          )
          .min(1),
        concurrency: z.number().int().positive().optional(),
        abortOnFailure: z.boolean().optional(),
        maxDependencyChars: z.number().int().positive().max(100_000).optional(),
        maxNodes: z.number().int().positive().optional().describe("节点数上限，防止过度拆分"),
        maxParallel: z.number().int().positive().optional().describe("并行度上限"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const e = clusters.get(args.clusterId);
        if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
        const result = await e.cluster.runDag({
          nodes: args.nodes as unknown as Parameters<DshCluster["runDag"]>[0]["nodes"],
          concurrency: args.concurrency,
          abortOnFailure: args.abortOnFailure,
          maxDependencyChars: args.maxDependencyChars,
          maxNodes: args.maxNodes,
          maxParallel: args.maxParallel,
        });
        // A DAG whose nodes all failed would otherwise be reported as ok:true
        // with an empty answer list, hiding the failure from the harness.
        if (result.failed.length > 0 || result.aborted) {
          return toMcpResult(
            err("DAG_NODE_FAILED", result.failed.length + " node(s) failed", { dag: result }),
          ) as never;
        }
        return toMcpResult(ok(result)) as never;
      } catch (e2) {
        return toMcpResult(err("DAG_FAILED", e2 instanceof Error ? e2.message : String(e2))) as never;
      }
    },
  );

  // ---------- dsh_metrics ----------
  server.registerTool(
    "dsh_metrics",
    {
      title: "Get cluster metrics",
      description: "Return cluster metrics as either Prometheus text exposition format or structured JSON.",
      inputSchema: {
        clusterId: z.string().optional(),
        format: z.enum(["prometheus", "json"]).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const fmt = args.format ?? "json";
        if (args.clusterId) {
          const e = clusters.get(args.clusterId);
          if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
          const out = fmt === "prometheus" ? e.cluster.metrics.toPrometheus() : e.cluster.metrics.toJSON();
          return toMcpResult(ok({ format: fmt, output: out })) as never;
        }
        const all: Record<string, unknown> = {};
        for (const [id, e] of clusters) {
          all[id] = fmt === "prometheus" ? e.cluster.metrics.toPrometheus() : e.cluster.metrics.toJSON();
        }
        return toMcpResult(ok({ format: fmt, clusters: all })) as never;
      } catch (e2) {
        return toMcpResult(err("METRICS_FAILED", e2 instanceof Error ? e2.message : String(e2))) as never;
      }
    },
  );

  // ============================================================
  // PART-3: Session lifecycle tools (7 tools)
  // ============================================================

  // ---------- dsh_session_create ----------
  server.registerTool(
    "dsh_session_create",
    {
      title: "Create a durable session for a long-running task",
      description:
        "Create a SessionRecord (status=queued). Returns {runId, status, createdAt}. Use dsh_session_start to actually run.",
      inputSchema: {
        task: z.string().min(1),
        profile: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const rec = getSessionManager().create({ task: args.task, profile: args.profile, tags: args.tags });
        return toMcpResult(ok({ runId: rec.runId, status: rec.status, createdAt: rec.createdAt }));
      } catch (e: unknown) {
        return toMcpResult(err("SESSION_CREATE_FAILED", e instanceof Error ? e.message : String(e))) as never;
      }
    },
  );

  // ---------- dsh_session_start ----------
  server.registerTool(
    "dsh_session_start",
    {
      title: "Start a queued/paused session (runs in background)",
      description:
        "Mark the session as running and execute the task in the background. Policy gates before execution. Use dsh_session_events to stream progress or dsh_session_status to poll.",
      inputSchema: {
        runId: z.string().min(1),
        estimatedCostUsd: z.number().optional(),
        estimatedRuntimeMs: z.number().int().optional(),
        tools: z.array(z.string()).optional(),
        hasNetworkAccess: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const rec = await getSessionManager().start(args.runId, {
          ctx: {
            estimatedCostUsd: args.estimatedCostUsd,
            estimatedRuntimeMs: args.estimatedRuntimeMs,
            tools: args.tools,
            hasNetworkAccess: args.hasNetworkAccess,
          },
        });
        return toMcpResult(ok({ runId: rec.runId, status: rec.status, startedAt: rec.startedAt }));
      } catch (e: unknown) {
        return toMcpResult(err("SESSION_START_FAILED", e instanceof Error ? e.message : String(e))) as never;
      }
    },
  );

  // ---------- dsh_session_status ----------
  server.registerTool(
    "dsh_session_status",
    {
      title: "Get the current status of a session",
      description: "Returns the full SessionRecord including status, timestamps, lastSeq, and checkpoint count.",
      inputSchema: {
        runId: z.string().min(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const rec = getSessionManager().status(args.runId);
      if (!rec) return toMcpResult(err("NOT_FOUND", "session not found: " + args.runId)) as never;
      return toMcpResult(ok(rec));
    },
  );

  // ---------- dsh_session_events ----------
  server.registerTool(
    "dsh_session_events",
    {
      title: "Stream events since a given seq (paginated)",
      description:
        "Returns events with seq > sinceSeq, up to `limit` (default 200). Use the returned lastSeq for the next page.",
      inputSchema: {
        runId: z.string().min(1),
        sinceSeq: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const out = getSessionManager().events(args.runId, args.sinceSeq, args.limit);
      return toMcpResult(ok(out));
    },
  );

  // ---------- dsh_session_cancel ----------
  server.registerTool(
    "dsh_session_cancel",
    {
      title: "Cancel a running session",
      description:
        "Abort the live execution. The session is marked 'cancelled' and its AbortSignal is triggered. The runner is expected to honor the signal.",
      inputSchema: {
        runId: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const rec = getSessionManager().cancel(args.runId);
      if (!rec) return toMcpResult(err("NOT_FOUND", "session not found: " + args.runId)) as never;
      return toMcpResult(ok({ runId: rec.runId, status: rec.status }));
    },
  );

  // ---------- dsh_session_resume ----------
  server.registerTool(
    "dsh_session_resume",
    {
      title: "Resume a crash-paused session",
      description:
        "Restart an idempotent task whose session was paused after a process restart. Cancelled and completed sessions are terminal.",
      inputSchema: {
        runId: z.string().min(1),
        estimatedCostUsd: z.number().optional(),
        estimatedRuntimeMs: z.number().int().optional(),
        tools: z.array(z.string()).optional(),
        hasNetworkAccess: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const rec = await getSessionManager().resume(args.runId, {
          ctx: {
            estimatedCostUsd: args.estimatedCostUsd,
            estimatedRuntimeMs: args.estimatedRuntimeMs,
            tools: args.tools,
            hasNetworkAccess: args.hasNetworkAccess,
          },
        });
        return toMcpResult(ok({ runId: rec.runId, status: rec.status, startedAt: rec.startedAt }));
      } catch (e: unknown) {
        return toMcpResult(err("SESSION_RESUME_FAILED", e instanceof Error ? e.message : String(e))) as never;
      }
    },
  );

  // ---------- dsh_session_result ----------
  server.registerTool(
    "dsh_session_result",
    {
      title: "Get the final result (or error) of a terminal session",
      description:
        "Returns the DshResult if status is 'succeeded', or the error if 'failed'. For 'cancelled', returns both fields empty.",
      inputSchema: {
        runId: z.string().min(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const rec = getSessionManager().status(args.runId);
      if (!rec) return toMcpResult(err("NOT_FOUND", "session not found: " + args.runId)) as never;
      const out = { runId: rec.runId, status: rec.status, result: rec.result, error: rec.error };
      return toMcpResult(ok(out));
    },
  );

  // ---------- dsh_capability_match ----------
  server.registerTool(
    "dsh_capability_match",
    {
      title: "Find instances matching a capability query",
      description:
        "Find cluster instances whose capabilities match a query (tools / tags / profile). Returns ranked matches.",
      inputSchema: {
        clusterId: z.string().min(1),
        requireTools: z.array(z.string()).optional(),
        requireTags: z.array(z.string()).optional(),
        preferProfiles: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const e = clusters.get(args.clusterId);
        if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
        const matches = e.cluster.capabilities
          .match({
            requireTools: args.requireTools,
            requireTags: args.requireTags,
            preferProfiles: args.preferProfiles,
          })
          .slice(0, args.limit ?? 20);
        return toMcpResult(ok({ matches, total: matches.length })) as never;
      } catch (e2) {
        return toMcpResult(err("MATCH_FAILED", e2 instanceof Error ? e2.message : String(e2))) as never;
      }
    },
  );

  // ---------- dsh_trace_classify (MAST failure attribution) ----------
  server.registerTool(
    "dsh_trace_classify",
    {
      title: "Classify a failed trace into the MAST failure taxonomy",
      description:
        "把一次执行轨迹打到 MAST 的 14 种失败模式里(Cemri et al., arXiv:2503.13657)。" +
        "输入是客观痕迹(退出码/中断标记/工具调用序列/答案长度/校验报告/角色审计)，" +
        "输出按置信度排序的信号，每条带 evidence 和对应的**结构级修法**。" +
        "用途是决定下一次该改哪一处结构——换个模型解决不了前两类失败。" +
        "给 traces(数组) 时返回聚合分布，可直接和 MAST 基准(system-design 44.2% / " +
        "inter-agent 32.3% / verification 23.5%)对照。",
      inputSchema: {
        trace: z
          .record(z.unknown())
          .optional()
          .describe(
            "单条轨迹。字段: task / roleName / answer / exitCode / aborted / errorCode / " +
              "toolCalls([{name,args}]) / toolResults([{name,ok}]) / durationMs / declaredMaxToolCalls / " +
              "declaredMaxToolCalls / upstream([{id,answer}]) / dependencyResultsInjected / " +
              "verification({ok,unknownKinds,checks}) / roleAudit({ok,violations})",
          ),
        traces: z.array(z.record(z.unknown())).optional().describe("多条轨迹；提供则返回聚合报告"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        // 至少要有一样东西可分析，否则「没有输入」会被当成「没有失败」返回出去。
        if (!args.trace && !args.traces) {
          return toMcpResult(err("MISSING_TRACE", "provide either `trace` or `traces`")) as never;
        }
        if (args.traces) {
          if (args.traces.length === 0) return toMcpResult(err("EMPTY_TRACES", "traces must not be empty")) as never;
          const attributions = args.traces.map((t) => classifyTrace(toTraceView(t)));
          const report = aggregateFailures(attributions);
          return toMcpResult(
            ok({
              report,
              baseline: MAST_BASELINE,
              note:
                "对比 baseline 时看的是 shape 而非绝对值：偏向系统设计类说明是规格/边界没写清，" +
                "换模型没用；偏向验证类说明缺可执行验收。",
              attributions: attributions.filter((a) => a.signals.length > 0),
            }),
          ) as never;
        }
        const attribution = classifyTrace(toTraceView(args.trace ?? {}));
        return toMcpResult(
          ok({
            attribution,
            summary: formatAttribution(attribution),
            modeCount: 14,
          }),
        ) as never;
      } catch (e) {
        return toMcpResult(err("CLASSIFY_FAILED", e instanceof Error ? e.message : String(e))) as never;
      }
    },
  );

  // ---------- dsh_cluster_attribution ----------
  server.registerTool(
    "dsh_cluster_attribution",
    {
      title: "Read the cluster's failure attribution roll-up",
      description:
        "返回这个集群最近若干次运行的失败归因汇总：失败率、三类失败分布、命中次数最多的模式及其修法。" +
        "想知道「这批任务到底在哪一类上最吃亏」就调这个。样本不足时会在 note 里说明。",
      inputSchema: {
        clusterId: z.string().min(1),
        limit: z.number().int().positive().max(50).optional().describe("返回前 N 个最常命中的模式（默认 10）"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const e = clusters.get(args.clusterId);
        if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
        const report = e.cluster.attributionReport();
        const limit = args.limit ?? 10;
        return toMcpResult(
          ok({
            totalTraces: report.totalTraces,
            failedTraces: report.failedTraces,
            failureRate: report.failureRate,
            byCategory: report.byCategory,
            rows: report.rows.slice(0, limit),
            baseline: MAST_BASELINE,
            note:
              report.totalTraces === 0
                ? "还没有样本。这里返回的是「没有数据」，不是「零失败」。"
                : report.totalTraces < 20
                  ? "样本偏少(小于 20)，分布仅供参考，别拿它做结构性决策。"
                  : undefined,
          }),
        ) as never;
      } catch (e2) {
        return toMcpResult(err("ATTRIBUTION_FAILED", e2 instanceof Error ? e2.message : String(e2))) as never;
      }
    },
  );

  let dashboard: DashboardServerHandle | undefined;
  if (opts.dashboard) {
    dashboard = await startDashboardServer({
      host: opts.dashboardHost,
      port: opts.dashboardPort,
      token: opts.dashboardToken,
      getSnapshot: buildDashboardSnapshot,
      cancelSession: (runId) => getSessionManager().cancel(runId) !== null,
      shutdownCluster: async (clusterId) => {
        const entry = clusters.get(clusterId);
        if (!entry) return false;
        await entry.cluster.shutdown(30_000);
        clusters.delete(clusterId);
        return true;
      },
    });
    console.error("[seekfleet-dashboard] local: " + dashboard.localUrl);
    for (const url of dashboard.lanUrls) console.error("[seekfleet-dashboard] LAN:   " + url);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Per MCP best practice: never log to stdout. Use stderr.
  // 这里行数容易误导：SDK_CAPABILITIES 是 discovery 里的能力清单（dsh.run 之类
  // 的语义能力），跟 MCP 工具数不是一回事。以前两个数字恰好都是 20，改工具时
  // 就会对不上还查不出原因 —— 分开打。
  console.error(
    "[seekfleet-mcp-server] stdio transport ready; " +
      MCP_TOOL_NAMES.length +
      " MCP tools, " +
      SDK_CAPABILITIES.length +
      " capabilities",
  );
}

function buildDashboardSnapshot(): DashboardSnapshot {
  const clusterList = Array.from(clusters.entries()).map(([id, entry]) => {
    const status = entry.cluster.status();
    const agents = status.instances.map((agent) => ({
      label: agent.label,
      profile: agent.profile,
      state: agent.state,
      inFlight: agent.inFlight,
      concurrency: agent.concurrency,
      totalRun: agent.totalRun,
      totalErrors: agent.totalErrors,
      breaker: agent.breaker,
      tokens: agent.cost?.totalTokens ?? 0,
      costUsd: agent.cost?.totalCostUsd ?? 0,
      lastError: agent.lastError,
      tags: agent.tags,
    }));
    return {
      id,
      routing: status.routing,
      createdAt: status.createdAt,
      agents,
      requests: agents.reduce((sum, agent) => sum + agent.totalRun, 0),
      tokens: status.cost ? status.cost.totalTokens.input + status.cost.totalTokens.output : 0,
      costUsd: status.cost?.totalCostUsd ?? 0,
      failures: agents.reduce((sum, agent) => sum + agent.totalErrors, 0),
      cacheHitRatio: status.cache?.hitRatio ?? 0,
      budgetUsd: status.cost?.budgetUsd,
      budgetSpent: status.cost?.budgetSpent ?? 0,
    };
  });
  const sessions = getSessionManager()
    .list()
    .map((session) => {
      const checkpoint = session.checkpoints.at(-1);
      const usage = session.result?.usage;
      return {
        runId: session.runId,
        task: session.task,
        profile: session.profile,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        tokens: usage?.totalTokens ?? (checkpoint?.inputTokens ?? 0) + (checkpoint?.outputTokens ?? 0),
        costUsd: usage?.costUsd ?? checkpoint?.costUsd ?? 0,
        eventCount: Math.max(session.events.length, session.lastSeq),
        error: session.error?.message,
      };
    });
  return { generatedAt: Date.now(), uptimeMs: Math.round(process.uptime() * 1000), clusters: clusterList, sessions };
}

function toTask(args: Record<string, unknown>): DshTask {
  return {
    task: String(args.task ?? ""),
    profile: args.profile as string | undefined,
    cwd: args.cwd as string | undefined,
    timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
    patches: Array.isArray(args.patches) ? (args.patches as string[]) : undefined,
    env: (args.env as Record<string, string> | undefined) ?? undefined,
    tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
    label: args.label as string | undefined,
    role: args.role === undefined ? undefined : (args.role as string | RoleSpec),
    verify: Array.isArray(args.verify) ? (args.verify as VerifyRule[]) : undefined,
    thinkingTokenBudget: typeof args.thinkingTokenBudget === "number" ? args.thinkingTokenBudget : undefined,
    effort: isEffort(args.effort) ? args.effort : undefined,
  };
}

function isEffort(v: unknown): v is DshTask["effort"] {
  return v === "low" || v === "medium" || v === "high";
}

/**
 * 把 MCP 传进来的松散对象窄化成 TraceView。
 *
 * 这里刻意不做「缺字段就补默认值」：classifyTrace 的语义是「有什么证据说什么话」，
 * 补出来的字段会变成假证据。拿不准的字段直接丢掉。
 */
function toTraceView(raw: Record<string, unknown>): TraceView {
  const view: TraceView = {};
  if (typeof raw.task === "string") view.task = raw.task;
  if (typeof raw.roleName === "string") view.roleName = raw.roleName;
  if (typeof raw.answer === "string") view.answer = raw.answer;
  if (typeof raw.exitCode === "number" || raw.exitCode === null) view.exitCode = raw.exitCode;
  if (typeof raw.aborted === "boolean") view.aborted = raw.aborted;
  if (typeof raw.errorCode === "string") view.errorCode = raw.errorCode;
  if (typeof raw.durationMs === "number") view.durationMs = raw.durationMs;
  if (typeof raw.declaredMaxToolCalls === "number") view.declaredMaxToolCalls = raw.declaredMaxToolCalls;
  if (typeof raw.dependencyResultsInjected === "boolean") {
    view.dependencyResultsInjected = raw.dependencyResultsInjected;
  }
  if (Array.isArray(raw.expectedArtifacts)) {
    view.expectedArtifacts = raw.expectedArtifacts.filter((x): x is string => typeof x === "string");
  }
  if (Array.isArray(raw.toolCalls)) {
    view.toolCalls = raw.toolCalls.map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") {
        return { name: (c as { name: string }).name, args: (c as { args?: unknown }).args };
      }
      return "";
    });
  }
  if (Array.isArray(raw.toolResults)) {
    view.toolResults = raw.toolResults
      .filter((r): r is { name: string; ok: boolean } => {
        return !!r && typeof r === "object" && typeof (r as { name?: unknown }).name === "string";
      })
      .map((r) => ({ name: (r as { name: string }).name, ok: (r as { ok?: unknown }).ok === true }));
  }
  if (Array.isArray(raw.upstream)) {
    view.upstream = raw.upstream.map((u) => {
      const o = (u ?? {}) as Record<string, unknown>;
      return {
        id: typeof o.id === "string" ? o.id : "",
        answer: typeof o.answer === "string" ? o.answer : undefined,
        status: typeof o.status === "string" ? o.status : undefined,
      };
    });
  }
  if (raw.verification && typeof raw.verification === "object") {
    const v = raw.verification as Record<string, unknown>;
    view.verification = {
      ok: v.ok === true,
      unknownKinds: Array.isArray(v.unknownKinds)
        ? v.unknownKinds.filter((x): x is string => typeof x === "string")
        : [],
      checks: Array.isArray(v.checks)
        ? v.checks.map((c) => {
            const o = (c ?? {}) as Record<string, unknown>;
            return {
              kind: typeof o.kind === "string" ? o.kind : undefined,
              ok: o.ok === true,
              detail: typeof o.detail === "string" ? o.detail : undefined,
            };
          })
        : [],
    };
  }
  if (raw.roleAudit && typeof raw.roleAudit === "object") {
    const r = raw.roleAudit as Record<string, unknown>;
    view.roleAudit = {
      ok: r.ok === true,
      violations: Array.isArray(r.violations)
        ? r.violations.map((x) => {
            const o = (x ?? {}) as Record<string, unknown>;
            return {
              code: String(o.code ?? ""),
              message: String(o.message ?? ""),
              evidence: typeof o.evidence === "string" ? o.evidence : undefined,
            };
          })
        : [],
    };
  }
  return view;
}

export async function main(): Promise<void> {
  await serveMcp();
}
