// discovery.ts - AI self-description.
// The MCP server and the CLI 'inspect' command both call this to enumerate
// what the SDK can do, so an AI can read the capabilities without prior knowledge.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveDsh } from "./install.js";
import type { DshCapability, DshInspection } from "./types.js";

const BUILTIN_TOOLS = [
  "pwsh",
  "bash",
  "fs",
  "fs-search",
  "str-replace-editor",
  "web",
  "web-search",
  "skill",
  "skills-filesystem",
  "subagent",
  "subagent-control",
  "workflow",
  "ralph",
  "goal",
  "jobs",
  "todo",
  "cordis",
  "mcp-client",
];

const KNOWN_PROFILES: Array<{ name: string; description?: string }> = [
  { name: "headless", description: "One-shot task: prints final answer and exits. Best for AI callers." },
  { name: "web", description: "Long-running browser GUI on http://localhost:port." },
  { name: "tui", description: "Terminal UI (if installed)." },
  { name: "cordis", description: "Cordis plugin stack only." },
];

export function inspect(opts: { dshModuleRoot?: string; dshHome?: string } = {}): DshInspection {
  const resolved = resolveDsh({ dshModuleRoot: opts.dshModuleRoot, dshHome: opts.dshHome });
  const profiles = listProfiles(resolved.dshHome);
  return {
    dshHome: resolved.dshHome,
    dshModuleRoot: resolved.moduleRoot,
    version: resolved.version,
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    profiles,
    builtinTools: BUILTIN_TOOLS,
    capabilities: SDK_CAPABILITIES,
  };
}

function listProfiles(dshHome: string): Array<{ name: string; description?: string }> {
  const profiles: Array<{ name: string; description?: string }> = [];
  const profilesDir = join(dshHome, "profiles");
  try {
    if (existsSync(profilesDir)) {
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        profiles.push({ name: entry.name });
      }
    }
  } catch {
    /* swallow */
  }

  for (const kp of KNOWN_PROFILES) {
    if (!profiles.find((p) => p.name === kp.name)) profiles.push(kp);
  }
  return profiles;
}

export function readDshManifest(dshModuleRoot: string): { version: string; deps: string[] } {
  try {
    const pkg = JSON.parse(readFileSync(join(dshModuleRoot, "package.json"), "utf8"));
    return {
      version: pkg.version ?? "0.0.0",
      deps: Object.keys(pkg.dependencies ?? {}),
    };
  } catch {
    return { version: "0.0.0", deps: [] };
  }
}

export const SDK_CAPABILITIES: DshCapability[] = [
  {
    id: "dsh.run",
    label: "Run a one-shot headless task",
    description:
      "Spawn dsh headless profile with a single task string. Returns the final answer plus usage and tool-call audit.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "The natural-language task for the agent." },
        profile: { type: "string", description: "Profile name (default: headless)." },
        cwd: { type: "string", description: "Workspace cwd (default: caller cwd)." },
        timeoutMs: { type: "integer", description: "Per-task timeout in ms (default 600000)." },
        patches: { type: "array", items: { type: "string" }, description: "Patch overlay files." },
        env: { type: "object", additionalProperties: { type: "string" }, description: "Extra env vars." },
        tags: { type: "array", items: { type: "string" }, description: "Tags for cluster routing." },
        label: { type: "string", description: "Human-readable label for logs." },
      },
    },
  },
  {
    id: "dsh.run_stream",
    label: "Stream a headless task event-by-event",
    description: "Run a task and yield each DshEvent (log, tool_call, tool_result, answer, exit) as it arrives.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        profile: { type: "string" },
        timeoutMs: { type: "integer" },
      },
    },
  },
  {
    id: "dsh.inspect",
    label: "Inspect installed dsh",
    description: "Return the dsh install location, version, available profiles, builtin tools, and SDK capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    id: "dsh.profile.dump",
    label: "Dump a profile's composed config tree",
    description: "Equivalent of `dsh --dump-config <profile>`. Returns the composed patch layer tree as YAML.",
    inputSchema: {
      type: "object",
      required: ["profile"],
      properties: {
        profile: { type: "string" },
        patches: { type: "array", items: { type: "string" } },
        defaultOnly: { type: "boolean", description: "Skip user layer and --patch overlays." },
      },
    },
  },
  {
    id: "dsh.profile.install",
    label: "Install/uninstall a plugin for a profile",
    description: "Adds or removes a plugin from a profile by forwarding to pnpm in the profile directory.",
    inputSchema: {
      type: "object",
      required: ["profile", "action", "pkg"],
      properties: {
        profile: { type: "string" },
        action: { type: "string", enum: ["add", "remove", "why"] },
        pkg: { type: "string", description: "Package name, e.g. @deepseek-ai/dsh-tool-bash" },
      },
    },
  },
  {
    id: "dsh.cluster.create",
    label: "Create a cluster of N dsh instances",
    description: "Spawns N instances under a shared workspace + dshHome.",
    inputSchema: {
      type: "object",
      required: ["instances"],
      properties: {
        profile: { type: "string" },
        routing: { type: "string", enum: ["round-robin", "least-loaded", "tag", "random"] },
        instances: {
          type: "array",
          items: {
            type: "object",
            required: ["label"],
            properties: {
              label: { type: "string" },
              profile: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              concurrency: { type: "integer", minimum: 1 },
              patches: { type: "array", items: { type: "string" } },
              env: { type: "object", additionalProperties: { type: "string" } },
              cwd: { type: "string" },
            },
          },
        },
        workspace: { type: "string" },
        dshHome: { type: "string" },
        healthIntervalMs: { type: "integer", minimum: 1000 },
      },
    },
  },
  {
    id: "dsh.cluster.route",
    label: "Route a task through a cluster",
    description: "Pick an instance via the cluster's routing strategy and run the task.",
    inputSchema: {
      type: "object",
      required: ["clusterId", "task"],
      properties: {
        clusterId: { type: "string" },
        task: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        profile: { type: "string" },
        timeoutMs: { type: "integer" },
        label: { type: "string" },
      },
    },
  },
  {
    id: "dsh.cluster.status",
    label: "Get cluster status",
    description:
      "Returns routing strategy, instance count, per-instance state, in-flight count, total runs, last error.",
    inputSchema: {
      type: "object",
      required: ["clusterId"],
      properties: { clusterId: { type: "string" } },
    },
  },
  {
    id: "dsh.cluster.scale",
    label: "Scale a cluster",
    description: "Add or remove instances by profile and replica count, or by explicit add/remove lists.",
    inputSchema: {
      type: "object",
      required: ["clusterId"],
      properties: {
        clusterId: { type: "string" },
        profile: { type: "string" },
        replicas: { type: "integer", minimum: 0 },
        add: { type: "array", items: { type: "object" } },
        remove: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    id: "dsh.cluster.shutdown",
    label: "Shutdown a cluster",
    description: "Gracefully stops all instances. Waits up to timeoutMs for in-flight tasks to drain.",
    inputSchema: {
      type: "object",
      required: ["clusterId"],
      properties: {
        clusterId: { type: "string" },
        timeoutMs: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    id: "dsh.dag.run",
    label: "Run a dependency graph",
    description: "Execute dependent tasks in topological waves with bounded concurrency and failure propagation.",
    inputSchema: {
      type: "object",
      required: ["clusterId", "nodes"],
      properties: {
        clusterId: { type: "string" },
        nodes: { type: "array" },
        concurrency: { type: "integer", minimum: 1 },
      },
    },
  },
  {
    id: "dsh.metrics",
    label: "Read cluster metrics",
    description: "Return live request, latency, cache, token, cost, breaker, and instance metrics.",
    inputSchema: {
      type: "object",
      properties: { clusterId: { type: "string" }, format: { type: "string", enum: ["json", "prometheus"] } },
    },
  },
  {
    id: "dsh.capability.match",
    label: "Match capable agents",
    description: "Rank cluster instances by required tools, tags, and preferred profiles before dispatch.",
    inputSchema: {
      type: "object",
      required: ["clusterId"],
      properties: { clusterId: { type: "string" }, requireTools: { type: "array" }, requireTags: { type: "array" } },
    },
  },
  ...[
    ["create", "Create a durable queued session"],
    ["start", "Start a queued or paused long-running session"],
    ["status", "Read the current session status"],
    ["events", "Read paginated events after a sequence cursor"],
    ["cancel", "Cancel a live session"],
    ["resume", "Restart a crash-paused idempotent session"],
    ["result", "Read the terminal session result or error"],
  ].map(([action, description]) => ({
    id: `dsh.session.${action}`,
    label: `Session ${action}`,
    description: description!,
    inputSchema: {
      type: "object",
      required: action === "create" ? ["task"] : ["runId"],
      properties:
        action === "create" ? { task: { type: "string" }, profile: { type: "string" } } : { runId: { type: "string" } },
    },
  })),
];
