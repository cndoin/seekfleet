<div align="center">

<img src="./docs/og.png" alt="SeekFleet — Run agents like a fleet" width="100%" />

# SeekFleet

### Run agents like a fleet.

Cross-platform control plane for DeepSeek Harness agent fleets — with MCP, durable sessions, adaptive routing, policy gates, token budgets, and a phone-friendly LAN dashboard.

<p>
  <a href="https://cndoin.github.io/seekfleet/">Live product page</a> ·
  <a href="./INSTALL.md">AI installation contract</a> ·
  <a href="./SKILL.md">Agent Skill</a> ·
  <a href="./SECURITY.md">Security</a>
</p>

<p>
  <a href="https://github.com/cndoin/seekfleet/actions/workflows/ci.yml"><img src="https://github.com/cndoin/seekfleet/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/cndoin/seekfleet/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cndoin/seekfleet?color=42dce8" alt="MIT License" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-43e0a2" alt="Node.js 20 or newer" /></a>
  <a href="https://github.com/cndoin/seekfleet/commits/main"><img src="https://img.shields.io/github/last-commit/cndoin/seekfleet?color=648bff" alt="Last commit" /></a>
</p>

</div>

> Give an AI the repository URL. It can install the Skill, configure MCP, verify the runtime, and explain exactly what changed.

## International overview

The product page includes a persistent language switcher with five localized experiences: [简体中文](https://cndoin.github.io/seekfleet/?lang=zh-CN), [English](https://cndoin.github.io/seekfleet/?lang=en), [日本語](https://cndoin.github.io/seekfleet/?lang=ja), [한국어](https://cndoin.github.io/seekfleet/?lang=ko), and [Español](https://cndoin.github.io/seekfleet/?lang=es). The page detects the browser language automatically, accepts a direct `?lang=` link, and remembers the visitor's choice.

| Language | Product summary |
| --- | --- |
| 简体中文 | 面向 DeepSeek Harness Agent 集群的跨平台控制平面，统一调度、监控、预算、策略与局域网控制台。 |
| English | A cross-platform control plane for routing, observing, budgeting, governing, and stopping DeepSeek Harness agent fleets. |
| 日本語 | DeepSeek Harness Agent艦隊をルーティング、監視、予算管理、制御するクロスプラットフォーム基盤。 |
| 한국어 | DeepSeek Harness 에이전트 함대를 라우팅, 관찰, 예산 관리, 정책 적용, 중지하는 크로스 플랫폼 제어 플레인. |
| Español | Un plano de control multiplataforma para enrutar, observar, presupuestar, gobernar y detener flotas de agentes DeepSeek Harness. |

## The 30-second version

SeekFleet turns DeepSeek Harness from a collection of processes into an observable, governable fleet:

| Surface | What it gives you |
| --- | --- |
| **MCP server** | 20 structured tools with stable envelopes and annotations |
| **SDK** | One TypeScript API for one-shot tasks, sessions, clusters, and DAGs |
| **Control plane** | Routing, cache, circuit breakers, budgets, policies, and cancellation |
| **LAN dashboard** | Live agents, requests, tokens, cost, failures, sessions, and protected controls |
| **Agent Skill** | One deterministic install path for Codex, Claude, Cursor, Gemini, and `.agents` clients |

## Give this repository to an AI

Copy this prompt as-is:

```text
Install SeekFleet from https://github.com/cndoin/seekfleet.
Read INSTALL.md first, install it for this AI client, configure its MCP server,
and verify the installation without exposing credentials.
```

The machine-readable contract lives in [INSTALL.md](./INSTALL.md). It includes Windows PowerShell, Linux, and macOS paths, user/project Skill scopes, verification, update, and rollback behavior.

## Install from source

Requirements: Node.js 20+, npm 10+, and `@deepseek-ai/dsh` or an explicit `DSH_MODULE_ROOT`.

```bash
git clone https://github.com/cndoin/seekfleet seekfleet
cd seekfleet
npm ci
npm run build
node dist/bin/seekfleet.js skill install --target auto
node dist/bin/seekfleet.js inspect
```

Install the Skill into every supported AI client:

```bash
node dist/bin/seekfleet.js skill install --target all --force
```

For a project-local Skill, use `--scope project`; it installs into `.agents/skills/seekfleet` without changing the user profile.

## Start the fleet

```bash
node dist/bin/seekfleet.js serve-mcp
```

Run MCP and the phone dashboard together on a trusted LAN:

```bash
node dist/bin/seekfleet.js serve-mcp \
  --dashboard \
  --dashboard-host 0.0.0.0 \
  --dashboard-port 8787
```

Open the printed URL on a phone connected to the same network. The dashboard is bearer-token protected; do not expose it directly to the public internet.

## SDK at a glance

```ts
import { SeekFleet } from "seekfleet";

const fleet = new SeekFleet();

const review = await fleet.run("Review this module for race conditions");
console.log(review.answer);

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

`DshPlugin` remains available as a deprecated source-compatibility alias. MCP tool names retain the `dsh_*` prefix so existing integrations keep working.

## Choose your execution mode

| Mode | Best for | Control surface |
| --- | --- | --- |
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
| --- | --- | --- |
| `DSH_MODULE_ROOT` | auto-detected | Installed DeepSeek Harness package |
| `DSH_HOME` | `~/.dsh` | Profiles and persistent runtime state |
| `CODEX_HOME` | `~/.codex` | Codex configuration root |
| `SEEKFLEET_DASHBOARD` | `0` | Start the dashboard with MCP when set to `1` |
| `SEEKFLEET_DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind host |
| `SEEKFLEET_DASHBOARD_PORT` | `8787` | Dashboard TCP port |
| `SEEKFLEET_DASHBOARD_TOKEN` | random | Fixed dashboard bearer token |

The previous `DSH_DASHBOARD*` names remain accepted as compatibility aliases.

## Project map

- [`src/`](./src/) — SDK, routing, sessions, policies, metrics, dashboard, and MCP server
- [`bin/seekfleet.ts`](./bin/seekfleet.ts) — cross-platform CLI entry point
- [`SKILL.md`](./SKILL.md) — compact AI operating instructions
- [`agents/openai.yaml`](./agents/openai.yaml) — AI client discovery metadata
- [`docs/`](./docs/) — GitHub Pages product site and social preview asset
- [`examples/`](./examples/) — MCP, SDK, adapter, and cluster examples
- [`tests/`](./tests/) — 94 behavior and integration tests

## Development

```bash
npm ci
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
```

CI runs on Windows, Ubuntu, and macOS with Node.js 20, 22, and 24. The live product page is published from [`docs/`](./docs/) by [GitHub Pages](https://github.com/cndoin/seekfleet/actions/workflows/pages.yml).

## Security

SeekFleet executes real agent tools and subprocesses. Configure policies, budgets, finite timeouts, and restricted workspaces before autonomous use. See [SECURITY.md](./SECURITY.md) for the threat model and disclosure process.

## License

MIT — see [LICENSE](./LICENSE).
