#!/usr/bin/env node
// SeekFleet CLI:
//   inspect                                     - print capabilities + dsh install info
//   run "<task>" [--profile P] [--json]        - one-shot headless task
//   cluster create --replicas N [--persist]     - create a cluster (in-process)
//   cluster route --id ID --task "..."          - route task (loads from registry if persisted)
//   cluster status --id ID                      - cluster status
//   cluster scale  --id ID --profile P --replicas N
//   cluster shutdown --id ID
//   serve-mcp                                   - run the MCP stdio server
//   demo                                        - run examples/cluster-demo.mjs

import { Command } from "commander";
import { spawn } from "node:child_process";
import { SeekFleet } from "../src/index.js";
import { addEntry, getEntry, removeEntry, listEntries } from "../src/registry.js";
import { DshCluster } from "../src/dsh-cluster.js";
import { resolveDsh } from "../src/install.js";
import { codexInstall, codexUninstall, codexStatus } from "../src/codex-config.js";
import { loadPolicy, savePolicy, PolicyEnforcer } from "../src/policy-enforcer.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installSeekFleetSkill, type SkillInstallTarget, type SkillInstallScope } from "../src/skill-installer.js";

function makePlugin() {
  // PART-2: load policy from $DSH_HOME/policy.json at startup
  const { dshHome } = resolveDsh({ dshHome: process.env.DSH_HOME });
  const policy = loadPolicy(dshHome);
  return new SeekFleet({
    dshHome,
    dshModuleRoot: process.env.DSH_MODULE_ROOT,
    policy: policy ?? undefined,
  });
}

async function main() {
  const program = new Command();
  program.name("seekfleet").description("Control plane for DeepSeek Harness agent fleets").version("0.1.0");

  program
    .command("inspect")
    .description("print dsh install info + SDK capabilities as JSON")
    .action(() => {
      const p = makePlugin();
      console.log(JSON.stringify(p.inspect(), null, 2));
    });

  const skill = program.command("skill").description("install the SeekFleet skill into AI clients");

  skill
    .command("install")
    .description("copy the bundled skill into Codex, Claude, Cursor, Gemini, or the open .agents location")
    .option("--target <name>", "auto | all | agents | codex | claude | cursor | gemini", "auto")
    .option("--scope <scope>", "user | project", "user")
    .option("--force", "replace an existing SeekFleet skill", false)
    .option("--json", "output JSON", false)
    .action((opts: { target: SkillInstallTarget; scope: SkillInstallScope; force: boolean; json: boolean }) => {
      const result = installSeekFleetSkill({ target: opts.target, scope: opts.scope, force: opts.force });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log("SeekFleet skill installed:");
        for (const entry of result.installed) console.log(`  ${entry.target}: ${entry.path}`);
      }
    });

  program
    .command("run")
    .description("one-shot headless task")
    .argument("<task>", "the task prompt")
    .option("--profile <name>", "profile name", "headless")
    .option("--cwd <dir>", "workspace cwd")
    .option("--timeout <ms>", "timeout in ms", (v) => parseInt(v, 10), 600000)
    .option("--json", "output structured result as JSON", false)
    .action(async (task, opts) => {
      const p = makePlugin();
      const result = await p.run({
        task,
        profile: opts.profile,
        cwd: opts.cwd,
        timeoutMs: opts.timeout,
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(result.answer || "(no answer)");
    });

  const cluster = program.command("cluster").description("multi-instance cluster operations");

  cluster
    .command("create")
    .description("create a cluster (persist spec to $DSH_HOME/clusters.json for cross-invocation reuse)")
    .option("--profile <name>", "shared profile", "headless")
    .option("--replicas <n>", "number of replicas", (v) => parseInt(v, 10), 2)
    .option("--routing <s>", "routing strategy: round-robin|least-loaded|tag|random", "least-loaded")
    .option("--workspace <dir>", "workspace root")
    .option("--dsh-home <dir>", "DSH_HOME")
    .option(
      "--tag <tag>",
      "add a tag to all instances (repeatable)",
      ((v: string, a: string[]) => [...a, v]) as never,
      [] as string[],
    )
    .option("--concurrency <n>", "per-instance concurrency", (v) => parseInt(v, 10), 1)
    .option("--persist", "persist the cluster spec to DSH_HOME/clusters.json", false)
    .option("--json", "output JSON", false)
    .action((opts) => {
      const p = makePlugin();
      const id = p.cluster({
        profile: opts.profile,
        routing: opts.routing,
        workspace: opts.workspace,
        dshHome: opts.dshHome,
        instances: Array.from({ length: opts.replicas }, (_, i) => ({
          label: opts.profile + "-" + (i + 1),
          profile: opts.profile,
          tags: opts.tag,
          concurrency: opts.concurrency,
        })),
      });
      if (opts.persist) {
        const resolved = resolveDsh({ dshHome: opts.dshHome });
        addEntry(resolved.dshHome, {
          clusterId: id,
          spec: {
            profile: opts.profile,
            instances: Array.from({ length: opts.replicas }, (_, i) => ({
              label: opts.profile + "-" + (i + 1),
              profile: opts.profile,
              tags: opts.tag,
              concurrency: opts.concurrency,
            })),
            routing: opts.routing,
            workspace: opts.workspace,
            dshHome: opts.dshHome,
          },
          createdAt: Date.now(),
        });
      }
      const out = { clusterId: id, persisted: opts.persist, status: p.clusterStatus(id) };
      if (opts.json) console.log(JSON.stringify(out, null, 2));
      else console.log("cluster created:", id, opts.persist ? "(persisted)" : "");
    });

  cluster
    .command("route")
    .description("route a task through a cluster")
    .requiredOption("--id <clusterId>", "cluster id")
    .requiredOption("--task <task>", "the task prompt")
    .option(
      "--tag <tag>",
      "tag for routing (repeatable)",
      ((v: string, a: string[]) => [...a, v]) as never,
      [] as string[],
    )
    .option("--timeout <ms>", "timeout in ms", (v) => parseInt(v, 10), 600000)
    .option("--json", "output JSON", false)
    .action(async (opts) => {
      const result = await runWithPersistedCluster(opts.id, async (cluster) => {
        return await cluster.route({
          task: opts.task,
          tags: opts.tag,
          timeoutMs: opts.timeout,
        });
      });
      if (!result) return;
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log("[" + result.instance + "] " + (result.answer || "(no answer)"));
    });

  cluster
    .command("status")
    .description("cluster status (loads from registry if persisted)")
    .requiredOption("--id <clusterId>", "cluster id")
    .option("--json", "output JSON", false)
    .action(async (opts) => {
      const status = await statusWithPersistedCluster(opts.id);
      if (!status) {
        console.error("cluster not found (and not persisted):", opts.id);
        process.exit(1);
      }
      console.log(JSON.stringify(status, null, 2));
    });

  cluster
    .command("scale")
    .description("scale cluster (loads from registry if persisted)")
    .requiredOption("--id <clusterId>", "cluster id")
    .option("--profile <name>", "profile to scale")
    .option("--replicas <n>", "target replica count", (v) => parseInt(v, 10))
    .option(
      "--remove <label>",
      "remove by label (repeatable)",
      ((v: string, a: string[]) => [...a, v]) as never,
      [] as string[],
    )
    .option("--persist", "update the persisted registry entry", false)
    .action(async (opts) => {
      const result = await runWithPersistedCluster(opts.id, async (cluster) => {
        return await cluster.scale({
          profile: opts.profile,
          replicas: opts.replicas,
          remove: opts.remove,
        });
      });
      if (!result) {
        console.error("cluster not found (and not persisted):", opts.id);
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
      if (opts.persist) {
        const resolved = resolveDsh({ dshHome: result.workspace });
        const entry = getEntry(resolved.dshHome, opts.id);
        if (entry) {
          entry.spec = { ...entry.spec, profile: opts.profile ?? entry.spec.profile };
          addEntry(resolved.dshHome, entry);
        }
      }
    });

  cluster
    .command("shutdown")
    .description("shutdown cluster and remove from registry")
    .requiredOption("--id <clusterId>", "cluster id")
    .option("--timeout <ms>", "drain timeout ms", (v) => parseInt(v, 10), 5000)
    .action(async (opts) => {
      await runWithPersistedCluster(opts.id, async (cluster) => {
        await cluster.shutdown(opts.timeout);
        return true;
      });
      const resolved = resolveDsh({});
      removeEntry(resolved.dshHome, opts.id);
      console.log("cluster " + opts.id + " shutdown");
    });

  cluster
    .command("list")
    .description("list persisted clusters")
    .action(() => {
      const resolved = resolveDsh({});
      const entries = listEntries(resolved.dshHome);
      console.log(JSON.stringify(entries, null, 2));
    });

  program
    .command("serve-mcp")
    .description("start the MCP stdio server, optionally with a LAN dashboard")
    .option(
      "--dashboard",
      "start the live web dashboard",
      (process.env.SEEKFLEET_DASHBOARD ?? process.env.DSH_DASHBOARD) === "1",
    )
    .option(
      "--dashboard-host <host>",
      "dashboard bind host; use 0.0.0.0 for LAN",
      process.env.SEEKFLEET_DASHBOARD_HOST ?? process.env.DSH_DASHBOARD_HOST ?? "127.0.0.1",
    )
    .option(
      "--dashboard-port <port>",
      "dashboard port",
      (v: string) => parseInt(v, 10),
      Number(process.env.SEEKFLEET_DASHBOARD_PORT ?? process.env.DSH_DASHBOARD_PORT ?? 8787),
    )
    .option(
      "--dashboard-token <token>",
      "fixed access token; random when omitted",
      process.env.SEEKFLEET_DASHBOARD_TOKEN ?? process.env.DSH_DASHBOARD_TOKEN,
    )
    .action(async (opts) => {
      const { serveMcp } = await import("../src/mcp-server.js");
      await serveMcp({
        dashboard: opts.dashboard,
        dashboardHost: opts.dashboardHost,
        dashboardPort: opts.dashboardPort,
        dashboardToken: opts.dashboardToken,
      });
    });

  program
    .command("codex-status")
    .description("show whether the dsh MCP server is registered in ~/.codex/config.toml")
    .option("--codex-home <dir>", "path to ~/.codex (default: $CODEX_HOME or %USERPROFILE%/.codex)")
    .option("--server-name <name>", "mcp_servers entry name (default: seekfleet)")
    .action((opts) => {
      const s = codexStatus({ codexHome: opts.codexHome, serverName: opts.serverName });
      console.log(JSON.stringify(s, null, 2));
    });

  program
    .command("codex-install")
    .description("add or update the dsh MCP server entry in ~/.codex/config.toml (preserves existing config)")
    .option("--codex-home <dir>", "path to ~/.codex")
    .option("--server-name <name>", "mcp_servers entry name (default: seekfleet)")
    .option("--server-command <path>", "custom executable used to launch the MCP server")
    .option(
      "--server-arg <arg>",
      "extra arg for the server (repeatable)",
      (v: string, a: string[]) => [...a, v],
      [] as string[],
    )
    .option(
      "--env <kv>",
      "server env in KEY=VALUE form (repeatable)",
      (v: string, acc: Record<string, string>) => {
        const eq = v.indexOf("=");
        if (eq > 0) acc[v.slice(0, eq)] = v.slice(eq + 1);
        return acc;
      },
      {} as Record<string, string>,
    )
    .option("--startup-timeout <sec>", "startup timeout seconds (default 60)", (v: string) => parseInt(v, 10), 60)
    .option("--disabled", "register but disable the server", false)
    .action((opts) => {
      const cliScript = process.argv[1] ?? "";
      const serverCommand = opts.serverCommand || process.execPath;
      const serverArgs = opts.serverCommand
        ? ["serve-mcp", ...opts.serverArg]
        : [cliScript, "serve-mcp", ...opts.serverArg];
      const r = codexInstall({
        codexHome: opts.codexHome,
        serverName: opts.serverName,
        serverCommand,
        serverArgs,
        serverEnv: opts.env,
        startupTimeoutSec: opts.startupTimeout,
        disabled: opts.disabled,
      });
      console.log(JSON.stringify(r, null, 2));
    });

  program
    .command("codex-uninstall")
    .description("remove the dsh MCP server entry from ~/.codex/config.toml")
    .option("--codex-home <dir>", "path to ~/.codex")
    .option("--server-name <name>", "mcp_servers entry name (default: seekfleet)")
    .action((opts) => {
      const r = codexUninstall({ codexHome: opts.codexHome, serverName: opts.serverName });
      console.log(JSON.stringify(r, null, 2));
    });

  cluster
    .command("dag-run")
    .description("run a DAG of dependent tasks on a cluster")
    .requiredOption("--id <clusterId>", "cluster id")
    .requiredOption("--nodes <json>", "JSON array of {id, task, dependsOn?, profile?, tags?, timeoutMs?, critical?}")
    .option("--concurrency <n>", "parallel workers", (v: string) => parseInt(v, 10), 4)
    .option("--no-abort-on-failure", "continue after a critical node fails")
    .action(async (opts) => {
      const plugin = new SeekFleet({});
      const nodes = JSON.parse(opts.nodes);
      const r = await plugin.clusterDagRun(opts.id, {
        nodes,
        concurrency: opts.concurrency,
        abortOnFailure: opts.abortOnFailure,
      });
      console.log(
        JSON.stringify(
          {
            order: r.order,
            cacheHits: r.cacheHits,
            failed: r.failed,
            durationMs: r.durationMs,
            nodes: r.nodes.map(
              (n: {
                id: string;
                status: string;
                instance?: string;
                cached?: boolean;
                result?: { answer?: string };
              }) => ({ id: n.id, status: n.status, instance: n.instance, cached: n.cached, answer: n.result?.answer }),
            ),
          },
          null,
          2,
        ),
      );
    });

  program
    .command("metrics")
    .description("print cluster metrics in JSON or Prometheus format")
    .option("--id <clusterId>", "specific cluster id")
    .option("--format <fmt>", "json or prometheus", "json")
    .action(async (opts) => {
      // metrics are in-memory per process, so the cli just shows example of structure
      // For real data, use the in-process plugin instance.
      console.log(
        JSON.stringify(
          {
            note: "metrics are in-memory; use dsh_metrics MCP tool for live data",
            format: opts.format,
            clusters: {},
          },
          null,
          2,
        ),
      );
    });

  program
    .command("cap-match")
    .description("find instances in a cluster matching a capability query")
    .requiredOption("--id <clusterId>", "cluster id")
    .option("--require-tools <tools>", "comma-separated required dsh tools")
    .option("--require-tags <tags>", "comma-separated required tags")
    .option("--prefer-profiles <profiles>", "comma-separated preferred profiles")
    .option("--limit <n>", "max results", (v: string) => parseInt(v, 10), 20)
    .action(async (opts) => {
      const { SeekFleet } = await import("../src/harness-sdk.js");
      const plugin = new SeekFleet({});
      const c = plugin.clusterRaw(opts.id);
      if (!c) {
        console.error("cluster not found");
        process.exit(1);
      }
      const matches = c.capabilities
        .match({
          requireTools: opts.requireTools?.split(","),
          requireTags: opts.requireTags?.split(","),
          preferProfiles: opts.preferProfiles?.split(","),
        })
        .slice(0, opts.limit);
      console.log(JSON.stringify(matches, null, 2));
    });

  program
    .command("policy")
    .description("manage the persistent policy (allowedPaths, allowedProfiles, maxCostUsd, requireApprovalFor, ...)")
    .argument("[action]", "show | save | delete | validate", "show")
    .option("--file <path>", "load policy JSON from file")
    .option("--strict", "treat warnings as errors when validating", false)
    .action(async (action: string, opts: { file?: string; strict?: boolean }) => {
      const { dshHome } = resolveDsh({ dshHome: process.env.DSH_HOME });
      if (action === "show") {
        const p = loadPolicy(dshHome);
        const policyPath = join(dshHome, "policy.json");
        if (!p) {
          console.log(JSON.stringify({ note: "no policy configured at " + policyPath }, null, 2));
        } else {
          console.log(JSON.stringify(p, null, 2));
        }
        return;
      }
      if (action === "save") {
        if (!opts.file) {
          console.error("--file <path> required");
          process.exit(1);
        }
        const fs = await import("node:fs");
        const raw = fs.readFileSync(opts.file, "utf8");
        const policy = JSON.parse(raw);
        savePolicy(dshHome, policy);
        console.log(JSON.stringify({ ok: true, saved: join(dshHome, "policy.json") }, null, 2));
        return;
      }
      if (action === "delete") {
        const fs = await import("node:fs");
        try {
          fs.unlinkSync(join(dshHome, "policy.json"));
          console.log("{ok:true}");
        } catch {
          console.log("{ok:true,alreadyAbsent:true}");
        }
        return;
      }
      if (action === "validate") {
        const p = loadPolicy(dshHome);
        if (!p) {
          console.error("no policy at " + join(dshHome, "policy.json"));
          process.exit(2);
        }
        const e = new PolicyEnforcer(p);
        try {
          const v = e.check({ task: "dry-run" }, { estimatedCostUsd: 0.001, estimatedRuntimeMs: 1000 });
          console.log(JSON.stringify({ ok: true, errors: v.errors, pendingApprovals: v.pendingApprovals }, null, 2));
        } catch (e: unknown) {
          const pe = e as { errors?: string[]; pendingApprovals?: string[] };
          console.log(JSON.stringify({ ok: false, errors: pe.errors, pendingApprovals: pe.pendingApprovals }, null, 2));
          process.exit(opts.strict ? 1 : 0);
        }
        return;
      }
      console.error("unknown action:", action);
      process.exit(1);
    });

  program
    .command("session")
    .description("manage long-running task sessions (create/start/status/events/cancel/resume/result)")
    .argument("[action]", "list | create | start | status | events | cancel | resume | result | stats", "list")
    .option("--run-id <id>", "session run id")
    .option("--task <text>", "task prompt (for create)")
    .option("--profile <name>", "profile (for create)")
    .option("--since-seq <n>", "event cursor", (v: string) => parseInt(v, 10), 0)
    .option("--limit <n>", "events limit", (v: string) => parseInt(v, 10), 100)
    .action(
      async (
        action: string,
        opts: { runId?: string; task?: string; profile?: string; sinceSeq?: number; limit?: number; run_id?: string },
      ) => {
        // accept both --run-id and --runId
        const runId = opts.runId ?? opts.run_id;
        const { resolveDsh } = await import("../src/install.js");
        const { SessionManager } = await import("../src/session-manager.js");
        const { dshHome } = resolveDsh({ dshHome: process.env.DSH_HOME });
        const sessionPolicy = loadPolicy(dshHome);
        const sm = new SessionManager({
          dshHome,
          policy: sessionPolicy ? new PolicyEnforcer(sessionPolicy) : undefined,
        });
        if (action === "list") {
          const list = sm.list();
          console.log(
            JSON.stringify(
              {
                count: list.length,
                sessions: list.map((r) => ({
                  runId: r.runId,
                  task: r.task,
                  profile: r.profile,
                  status: r.status,
                  createdAt: r.createdAt,
                  finishedAt: r.finishedAt,
                })),
              },
              null,
              2,
            ),
          );
          return;
        }
        if (action === "stats") {
          console.log(JSON.stringify(sm.stats(), null, 2));
          return;
        }
        if (action === "create") {
          if (!opts.task) {
            console.error("--task <text> required");
            process.exit(1);
          }
          const r = sm.create({ task: opts.task, profile: opts.profile });
          console.log(JSON.stringify({ runId: r.runId, status: r.status, createdAt: r.createdAt }, null, 2));
          return;
        }
        if (!runId) {
          console.error("--run-id <id> required");
          process.exit(1);
        }
        if (action === "start" || action === "resume") {
          const r = action === "start" ? await sm.start(runId) : await sm.resume(runId);
          console.log(JSON.stringify({ runId: r.runId, status: r.status, startedAt: r.startedAt }, null, 2));
          return;
        }
        if (action === "status") {
          const r = sm.status(runId);
          if (!r) {
            console.error("not found");
            process.exit(2);
          }
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        if (action === "events") {
          const out = sm.events(runId, opts.sinceSeq ?? 0, opts.limit ?? 100);
          console.log(JSON.stringify(out, null, 2));
          return;
        }
        if (action === "cancel") {
          const r = sm.cancel(runId);
          if (!r) {
            console.error("not found");
            process.exit(2);
          }
          console.log(JSON.stringify({ runId: r.runId, status: r.status }, null, 2));
          return;
        }
        if (action === "result") {
          const out = sm.result(runId);
          console.log(JSON.stringify({ runId, ...out }, null, 2));
          return;
        }
        console.error("unknown action:", action);
        process.exit(1);
      },
    );

  program
    .command("demo")
    .description("run examples/cluster-demo.mjs")
    .action(() => {
      const here = dirname(fileURLToPath(import.meta.url));
      const child = spawn(process.execPath, [join(here, "..", "examples", "cluster-demo.mjs")], { stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
    });

  await program.parseAsync(process.argv);
}

async function runWithPersistedCluster<T>(
  clusterId: string,
  fn: (cluster: DshCluster) => Promise<T>,
): Promise<T | null> {
  const resolved = resolveDsh({});
  const entry = getEntry(resolved.dshHome, clusterId);
  if (!entry) {
    console.error("cluster not persisted:", clusterId, "(recreate with --persist)");
    return null;
  }
  const cluster = new DshCluster({
    ...entry.spec,
    client: { dshModuleRoot: resolved.moduleRoot, dshHome: resolved.dshHome },
  });
  try {
    return await fn(cluster);
  } finally {
    await cluster.shutdown(1000).catch(() => {});
  }
}

async function statusWithPersistedCluster(clusterId: string) {
  const resolved = resolveDsh({});
  const entry = getEntry(resolved.dshHome, clusterId);
  if (!entry) return null;
  const cluster = new DshCluster({
    ...entry.spec,
    client: { dshModuleRoot: resolved.moduleRoot, dshHome: resolved.dshHome },
  });
  const status = cluster.status();
  await cluster.shutdown(100).catch(() => {});
  return status;
}

main().catch((err) => {
  console.error("seekfleet error:", err);
  process.exit(1);
});
