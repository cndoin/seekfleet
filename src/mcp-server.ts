// mcp-server.ts - stdio MCP server exposing DSH capabilities to any MCP-aware AI.
//
// Built on the modern McpServer high-level API (Anthropic MCP TypeScript SDK).
// Every tool is registered with:
//   - Zod input schema (auto-validated, auto-converted to JSON Schema)
//   - annotations: readOnlyHint / destructiveHint / idempotentHint / openWorldHint
//   - structuredContent envelope ({ok, data, error}) so AI callers can branch reliably
//   - pagination + character-limit handling where applicable
//
// Tools (20): runtime/profile, cluster/DAG/metrics, capability matching,
//             and seven durable session lifecycle operations.

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
import { startDashboardServer, type DashboardServerHandle, type DashboardSnapshot } from "./dashboard-server.js";
import type { DshClusterSpec, DshEnvelope, DshInstanceSpec, DshTask } from "./types.js";

/** MCP 2025-11-25 recommended CHARACTER_LIMIT for tool output. */
export const CHARACTER_LIMIT = 25_000;

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
    { name: "seekfleet-mcp-server", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "SeekFleet MCP server. Exposes 20 tools for running and controlling DeepSeek Harness " +
        "(dsh) as one-shot tasks and as a multi-instance cluster. Every tool returns " +
        "a {ok, data?, error?} envelope; the structuredContent field mirrors the envelope " +
        "for AI-validated consumption. Use dsh_inspect first to discover the runtime.",
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
        "tasks, consider polling via dsh_session_continue instead.",
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
        return toMcpResult(ok({ events })) as never;
      } catch (e) {
        events.push({
          kind: "error",
          ts: Date.now(),
          seq: -1,
          data: { message: e instanceof Error ? e.message : String(e) },
        });
        return toMcpResult(ok({ events })) as never;
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
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const e = clusters.get(args.clusterId);
        if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
        const t: DshTask = {
          task: args.task,
          profile: args.profile,
          timeoutMs: args.timeoutMs,
          tags: args.tags,
          label: args.label,
        };
        const result = await e.cluster.route(t);
        return toMcpResult(ok({ result })) as never;
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
            }),
          )
          .min(1),
        concurrency: z.number().int().positive().optional(),
        abortOnFailure: z.boolean().optional(),
        maxDependencyChars: z.number().int().positive().max(100_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const e = clusters.get(args.clusterId);
        if (!e) return toMcpResult(err("CLUSTER_NOT_FOUND", args.clusterId)) as never;
        const result = await e.cluster.runDag({
          nodes: args.nodes,
          concurrency: args.concurrency,
          abortOnFailure: args.abortOnFailure,
          maxDependencyChars: args.maxDependencyChars,
        });
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
  console.error("[seekfleet-mcp-server] stdio transport ready; " + SDK_CAPABILITIES.length + " tools registered");
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
  };
}

export async function main(): Promise<void> {
  await serveMcp();
}
