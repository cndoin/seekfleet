# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Future changes will be listed here.

## [0.1.1] - 2026-08-17

### Fixed
- Lazily resolve the optional DeepSeek Harness runtime so embedded runners and CI can construct session managers without a local Harness installation
- Increase the cross-platform Vitest timeout for slower filesystems and hosted runners
- Make GitHub Release creation independent of optional npm publishing credentials

## [0.1.0] - 2026-08-17

### Added
- SeekFleet brand, CLI, Agent Skill metadata, AI-first installation contract, and cross-client Skill installer
- Windows, Linux, and macOS CI matrix across Node.js 20, 22, and 24
- Portable path-policy helpers and platform-specific runtime details in `dsh_inspect`
- Mobile LAN dashboard controls and cross-platform setup guidance
- Cross-process file locking for cluster registry and durable session updates
- Token-protected, mobile-responsive LAN operations dashboard for live clusters and sessions
- Seven durable session MCP tools for create/start/status/events/cancel/resume/result
- Persisted policy enforcement across SDK, CLI, cluster, session, and MCP entry points
- Real-time child-process streaming with bounded buffering and globally ordered event cursors
- Dependency-result injection for DAG synthesis nodes
- CircuitBreaker (per-instance failure isolation, opossum-style API)
- ResultCache (task-level result memoization, persistent JSONL store, TTL)
- CostTracker (token + cost accounting, soft/hard budgets)
- AdaptiveRouter (6-dimension scoring: success, latency, load, freshness, tag, cost)
- AutoScaler (queue-depth driven cluster scaling)
- TaskDagExecutor (`dsh_dag_run` tool, topological scheduling)
- WorkspaceSync (chokidar-style file sharing between instances)
- ReplayRecorder (event stream recording + playback)
- CapabilityRegistry (instance self-reporting, shared via DSH_HOME)
- MetricsRegistry (Prometheus text exposition + JSON)
- 3 new MCP tools: `dsh_dag_run`, `dsh_metrics`, `dsh_capability_match`
- 3 new CLI commands: `cluster dag-run`, `metrics`, `cap-match`
- Codex integration: `codex-install` / `codex-status` / `codex-uninstall` (TOML patcher with smol-toml validation + atomic write)
- MCP server name normalized to `dsh-mcp-server` (per `{service}-mcp-server` convention)
- Tool annotations: `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`
- `structuredContent` field on all MCP tool responses
- Server-level `instructions` field on MCP initialize
- Pagination (`limit` / `offset`) on `dsh_cluster_status`
- `CHARACTER_LIMIT = 25000` with truncation markers on long output
- split2-based Transform parser for dsh stdout streaming
- Zod schemas on all MCP tool inputs (auto-validated, auto-derived JSON Schema)

### Changed
- Renamed the public package and command from `dsh-plugin-sdk` / `dsh-plugin` to `seekfleet`; retained `DshPlugin` as a deprecated SDK alias and `dsh_*` MCP tools for compatibility
- Atomic persistence now uses unique same-directory temporary files with transient Windows rename retries
- Child-process cancellation terminates complete process trees on Windows, Linux, and macOS
- DSH discovery now supports ESM-safe file URLs plus local, npm-global, pnpm-global, and npx-cache installs
- Persistent capability filenames are hashed so arbitrary agent labels cannot escape their storage directory
- Cluster routing now honors round-robin, least-loaded, tag, random, and adaptive strategies
- Scale-down drains in-flight agents; budget reservations are race-safe and cannot leak capacity
- NPM SDK entry points now target the actual `dist/src` build output
- MCP server migrated from low-level `Server` API to high-level `McpServer.registerTool` API
- event-parser now exports a split2-based `createEventTransform()` for backpressure-safe NDJSON parsing
- DshClient wires split2-compatible classifier directly into the stream pipeline
- codex-config now uses `smol-toml` to validate generated TOML before writing
- All file writes (codex-config) use atomic temp + rename to avoid mid-write corruption

### Fixed
- Fixed relative `DSH_MODULE_ROOT` and `DSH_HOME` paths breaking after a task changes its working directory
- Fixed UTF-8 output limits undercounting multibyte text and ignoring the client-level limit
- Fixed policy root matching accepting sibling prefixes such as `/workspace-old`
- Fixed session and workspace paths allowing parent-directory traversal from untrusted identifiers or logs
- Fixed dashboard tests intermittently failing when the OS selected a Fetch-standard blocked ephemeral port
- Fixed a regex literal bug in codex-config where `+` concatenation inside a `/.../` regex caused the strip function to silently match wrong characters; replaced with `new RegExp(...)`
- Fixed `z.record(z.string())` to use the new 2-arg signature `z.record(z.string(), z.string())` (zod >= 3.23)
- Fixed `clientOpts?.dshHome` optional chain where `clientOpts` itself could be undefined
- Fixed capability-registry field initialization order (must happen after `this.spec` is set)

## [0.1.0] - 2025-XX-XX

### Added
- Initial release
- Single-instance wrapper: `DshClient.run()` / `stream()` / `serve()`
- Multi-instance cluster: `DshCluster` with 4 routing strategies (round-robin, least-loaded, tag, random)
- `DshPlugin` unified API for hermes / openclaw / any AI agent framework
- MCP stdio server exposing 10 tools
- Profile management: `dumpProfileConfig` + `profilePluginAction` (pnpm add/remove/why)
- AI self-description: `inspect()` + `SDK_CAPABILITIES` (JSON Schema list)
- Cluster registry: persisted to `$DSH_HOME/clusters.json` for cross-invocation reuse
- CLI: `inspect`, `run`, `cluster {create,route,status,scale,shutdown,list}`
- Adapter docs: `examples/hermes-adapter.md`, `examples/openclaw-adapter.md`
- Demo: `examples/cluster-demo.mjs` (3-instance tag-routed cluster)
