# SeekFleet

> A cross-platform control plane for DeepSeek Harness agent fleets.

SeekFleet lets AI clients run, route, monitor, budget, and stop DeepSeek Harness agents through one TypeScript SDK and one MCP server. It includes durable sessions, adaptive clusters, DAG scheduling, policy enforcement, token and cost accounting, failure isolation, and a phone-friendly LAN dashboard.

[Documentation](./INSTALL.md) · [Agent Skill](./SKILL.md) · [Security](./SECURITY.md) · [Contributing](./CONTRIBUTING.md)

## Why SeekFleet

- **AI-native:** 20 structured MCP tools with stable envelopes and annotations.
- **Controllable:** cancellation, finite timeouts, cost budgets, policies, and circuit breakers.
- **Observable:** live agent state, requests, tokens, cost, failures, cache ratio, and metrics.
- **Resilient:** durable sessions, bounded streams, atomic state, process-tree cleanup, and graceful draining.
- **Cross-platform:** Windows, Linux, and macOS on Node.js 20+.
- **Easy to teach:** ships as an Agent Skill for Codex, Claude, Cursor, Gemini, and open `.agents` clients.

## Give this repository to an AI

After the repository is published, send your AI this single instruction:

```text
Install SeekFleet from https://github.com/cndoin/seekfleet. Read INSTALL.md in that repository first, install it for this AI client, configure its MCP server, and verify the installation without exposing credentials.
```

The AI-facing installation contract is intentionally kept in [INSTALL.md](./INSTALL.md). It contains deterministic Windows, Linux, and macOS steps plus verification and rollback.

## Quick installation

Requirements:

- Node.js 20 or newer
- npm 10 or newer
- `@deepseek-ai/dsh`, or an explicit `DSH_MODULE_ROOT`

Clone and build:

```bash
git clone https://github.com/cndoin/seekfleet seekfleet
cd seekfleet
npm ci
npm run build
```

Install the bundled Skill into detected AI clients:

```bash
seekfleet skill install --target auto
```

Install for every supported client profile:

```bash
seekfleet skill install --target all --force
```

Supported targets are `agents`, `codex`, `claude`, `cursor`, and `gemini`. Use `--scope project` to install into `.agents/skills/seekfleet` for one repository.

## Start the MCP server

```bash
seekfleet serve-mcp
```

For a source checkout:

```bash
node dist/bin/seekfleet.js serve-mcp
```

The server exposes 20 tools covering inspection, one-shot tasks, profile management, clusters, DAGs, metrics, capability matching, and durable sessions. Tool names retain the `dsh_*` prefix for protocol compatibility.

## Phone dashboard

Run MCP and the LAN dashboard in the same process:

```bash
seekfleet serve-mcp --dashboard --dashboard-host 0.0.0.0 --dashboard-port 8787
```

Or from the repository:

```bash
npm run serve-lan
```

Open the printed LAN URL on a phone connected to the same trusted network. Every data and control request requires a bearer token. Do not expose the dashboard directly to the public internet.

## SDK

```ts
import { SeekFleet } from "seekfleet";

const fleet = new SeekFleet();

const one = await fleet.run("Review this module for race conditions");
console.log(one.answer);

const clusterId = fleet.cluster({
  routing: "adaptive",
  instances: [
    { label: "code-a", tags: ["code"] },
    { label: "code-b", tags: ["code"] },
    { label: "review", tags: ["review"] },
  ],
});

const result = await fleet.clusterRoute(clusterId, {
  task: "Audit the authentication flow",
  tags: ["review"],
  timeoutMs: 120_000,
});

await fleet.clusterShutdown(clusterId);
```

`DshPlugin` remains available as a deprecated alias for source compatibility.

## Execution modes

| Mode | Best for | Control surface |
|---|---|---|
| One-shot | One bounded task | `dsh_run` |
| Session | Long-running, cancellable work | `dsh_session_*` |
| Cluster | Parallel or repeated tasks | `dsh_cluster_*` |
| DAG | Dependent task graphs | `dsh_dag_run` |

Routing strategies include `least-loaded`, `round-robin`, `tag`, `adaptive`, and `random`.

## Architecture

```text
AI client (Codex / Claude / Cursor / Gemini / Hermes / OpenClaw)
                              │
                         MCP or SDK
                              │
                         SeekFleet
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    Durable sessions     Agent clusters      Policy gate
          │          routing · cache · DAG         │
          └───────────────────┼───────────────────┘
                              │
                     DeepSeek Harness
                              │
                tools · models · subprocesses
```

## Cross-platform configuration

PowerShell:

```powershell
$env:DSH_MODULE_ROOT = "C:\Tools\deepseek-harness"
$env:DSH_HOME = "$env:USERPROFILE\.dsh"
npm run serve-lan
```

Bash or zsh:

```bash
export DSH_MODULE_ROOT=/opt/deepseek-harness
export DSH_HOME="$HOME/.dsh"
npm run serve-lan
```

Use OS-native absolute paths. Do not copy Windows drive paths into Linux or macOS configuration.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DSH_MODULE_ROOT` | auto-detected | Installed DeepSeek Harness package |
| `DSH_HOME` | `~/.dsh` | Profiles and persistent runtime state |
| `CODEX_HOME` | `~/.codex` | Codex configuration root |
| `SEEKFLEET_DASHBOARD` | `0` | Start the dashboard with MCP when set to `1` |
| `SEEKFLEET_DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind host |
| `SEEKFLEET_DASHBOARD_PORT` | `8787` | Dashboard TCP port |
| `SEEKFLEET_DASHBOARD_TOKEN` | random | Fixed dashboard bearer token |

The previous `DSH_DASHBOARD*` names remain accepted as compatibility aliases.

## Development

```bash
npm ci
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
```

CI runs on Windows, Ubuntu, and macOS with Node.js 20, 22, and 24.

## Security

SeekFleet executes real agent tools and subprocesses. Configure policies, budgets, finite timeouts, and restricted workspaces before autonomous use. See [SECURITY.md](./SECURITY.md) for the threat model and disclosure process.

## License

MIT
