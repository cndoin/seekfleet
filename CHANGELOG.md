# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Role contracts (`src/role-spec.ts`).** A task can now carry `role: "<dept>"`
  or a full `RoleSpec`. The contract is compiled into an XML block that always
  includes a termination condition, is injected into the prompt before dispatch,
  and is audited afterwards against the tool-call record. Built-in departments:
  `planner` / `worker` / `reviewer` / `synthesizer` (an orchestrator-worker shape
  where `reviewer` is denied write tools so verification stays independent). A
  violation is reported as `error.code: "ROLE_CONTRACT_VIOLATION"`, not as a
  warning. An unknown department name is an error — there is no silent fallback
  to a generic worker.
- **Independent verification layer (`src/verifier.ts`).** `task.verify` accepts
  rules (`command` / `answer-schema` / `answer-match` / `file-exists` /
  `max-tool-calls` / `tool-not-used`) that the framework runs *after* the agent
  finishes. Commands always execute as an argv array with `shell: false`, and an
  unrecognised rule kind fails the run instead of being skipped, so a report that
  says "verified" means it. Verification failures become
  `error.code: "VERIFY_FAILED"`. Targets MAST's ~23% verification failures.
- **Failure attribution (`src/mast.ts`).** Every run is classified against the
  14 MAST failure modes (Cemri et al., arXiv:2503.13657; inter-annotator κ=0.88).
  Each signal carries `confidence` and reproducible `evidence`; hard evidence
  scores 0.75–0.85, indirect inference is deliberately kept at 0.4–0.55 so it can
  rank the investigation order but never convict anyone. An empty trace reports
  "no signal detected", not "success". Surface: `DshResult.audit.attribution`,
  `cluster.attributionReport()`, `cluster.status().attribution`,
  `DagResult.attribution`, and the `dsh_trace_classify` /
  `dsh_cluster_attribution` MCP tools. Batch output is comparable against the
  paper's baseline (system-design 44.2% / inter-agent 32.3% / verification 23.5%).
- **Effort scaling.** `DshClusterSpec.maxParallelSubtasks` (default 8),
  `effortPolicy` per level (low 1 / medium 3 / high 8) and
  `cluster.recommendFanout(effort)` keep a simple question from fanning out into
  dozens of agents; `DagSpec.maxNodes` rejects an over-decomposed graph outright,
  and DAG concurrency is clamped to the cluster's ceiling.
- **Thinking-token budget.** `task.thinkingTokenBudget` records actual usage and
  sets `result.audit.budget.exceeded` when it is blown, without blocking the run —
  sometimes the extra spend is worth it, but you must be able to see it.
- Two new MCP tools (`dsh_trace_classify`, `dsh_cluster_attribution`); tool count
  is 22. `dsh_run`, `dsh_cluster_route` and `dsh_dag_run` accept `role` / `verify`
  / `thinkingTokenBudget` / `effort`.
- Note: a run whose contract or verification failed is **not written to the
  result cache**, so a bad answer cannot be replayed for every later caller.
- **Self-correction (`src/repair.ts`).** `task.selfRepair` turns a failed
  acceptance into one more attempt that carries the *actual failure evidence*
  (violated contract clauses, failing checks, a clipped excerpt of the previous
  answer) back into the prompt, instead of handing the failure straight to the
  caller. Accepts `true` (2 attempts, governed mode), a number, or a full policy.
  Half of this module answers "is another round worth it": it refuses to retry
  without objective judgement, refuses to retry deterministic crashes under the
  default `governed` mode, and stops the moment a retry reproduces the identical
  failure set. `result.audit.repair` reports `rescued` / `attemptsUsed` /
  `stopReason` / `hint`. Same rules apply to DAG nodes via `node.selfRepair`.

### Fixed
- **`route()` consumed a round-robin slot just to check availability.** The
  pre-flight `pick()` advanced the round-robin cursor before the real dispatch
  picked again, so consecutive calls landed on the same instance. Replaced with a
  side-effect-free liveness check.
- **`CostTracker` recomputed everything on every record.** Each `record()` did a
  full-array filter plus five reductions, making N records O(N^2) — a long-lived
  cluster got slower the longer it ran, and the dashboard recomputed the same
  thing every 2s. Now incremental: `record()` is O(1) and the read paths derive
  from per-instance aggregates. Detail records are capped at 5000 entries, but
  accumulated totals survive trimming, so budget enforcement stays exact.
- **`AutoScaler.events` grew without bound.** A background tick appending strings
  forever is a slow leak on any cluster that runs for days; it is now a 500-entry
  ring that keeps the most recent events.
- **A crashed task no longer reports success.** `dsh` exits non-zero for hard
  failures (missing credentials, invalid flags, a crashed tool) and prints
  nothing on stdout. `summarize()` returned `{ answer: "", exitCode: 1 }` with
  no `error`, and because the cluster, the DAG executor, the session manager
  and every MCP tool keyed their success test off `error`, a failed run was
  reported as `ok: true` — and its empty answer cached. A non-zero exit now
  always surfaces as `error.code: "EXIT_NONZERO"` carrying the last stderr line.
- **A DAG node that resolved with a failed result is now `failed`.** The node
  status was keyed off "did the runner promise resolve". `cluster.route()`
  deliberately resolves with soft failures rather than throwing, so every
  crashed node was recorded as `ok` with an empty answer and its dependents
  went on to run against that empty answer.
- **A session whose runner resolved with a failed result is now `failed`**, not
  `succeeded`. Polling a crashed background session reported completion.
- **MCP task tools branch on the real outcome.** `dsh_run` and
  `dsh_cluster_route` returned `ok: true` for a failed task; `dsh_run_stream`
  returned `ok: true` for a stream ending on a non-zero exit (it does not
  throw); `dsh_dag_run` returned `ok: true` with an empty `failed` list. All
  four now return `ok: false` with the result/DAG preserved under `details`.
- The CLI exits non-zero and prints the failure to stderr for a failed
  `run` / `cluster route` / `cluster dag-run`, instead of exiting 0 with
  `(no answer)`.
- Aborted and timed-out tasks no longer report success. The stream closes with
  an `error` event (not `exit`) when a task is aborted, and only `exit` was
  parsed — so every timeout surfaced with `exitCode: null`, `durationMs: 0` and
  no error field. That made the cluster cache poisoned results, count them as
  breaker successes, and confirm budget reservations for work that never ran.
  A partial answer no longer suppresses the `ABORTED` error either.
- `skill install` no longer kills the process on Node.js 22 / Windows.
  `fs.cpSync(src, dest, { recursive: true })` terminated Node 22.22.2 outright
  (exit code 127, no exception, no stack trace) while copying the bundled
  `agents/` directory, so the documented install command crashed. Directory
  copies now walk the tree explicitly and skip symlinks.
- `--target all` can no longer leave a partial install: every destination is
  validated before the first byte is written.
- `codex-status` / `codex-install` now detect the `disabled` flag. Two broken
  regexes were involved — a `[\\s\\S]` character class built from an over-escaped
  string literal, and a literal `/disabled\\s*=\\s*true/` — so a disabled server
  was reported as enabled and the previous state was never recovered. Block
  scanning is now scoped to `[mcp_servers.<name>]` so another server's
  `disabled` key cannot be misattributed.
- `codex-install` fails loudly instead of writing `command = ""` when no launch
  command can be resolved, and a no-op install no longer rewrites the file.
- Durable sessions are no longer quadratic. Every `appendEvent` was a full
  read-parse-write-with-fsync of the whole record, so a 1500-event burst blocked
  the event loop past a 30s timeout. Appends are coalesced in memory with an
  explicit `flush()`, while `create` / `setStatus` / `addCheckpoint` stay
  synchronous so crash recovery sees a consistent status.
- The cluster no longer crashes on a concurrent scale-down: a routed instance
  could be removed between `pick()` and dispatch, and the non-null assertion
  turned that into a `TypeError`.
- Cluster streaming read token usage from `evt.data` instead of `evt.data.usage`,
  which pushed `NaN` token counts and costs into the cost tracker.
- Cluster construction resolves the DSH runtime once instead of once per
  instance (the fallback discovery path shells out to `npm root -g`), and the
  result cache fingerprint now uses the real Harness version instead of a
  hardcoded `0.1.0-rc.6` that never invalidated.
- A policy that stripped every environment variable no longer falls back to the
  caller's original env, which silently bypassed the gate and could leak
  credentials. `ValidationResult` gains an explicit `envSanitized` flag.
- Task prompts beginning with `-` are no longer parsed as CLI flags.
- `run()` applies the policy gate once rather than twice.
- `cluster dag-run` works. It always threw `cluster not found` because it looked
  the cluster up in a freshly constructed, empty `SeekFleet` instance.
- `cluster scale --persist` writes to the registry under `DSH_HOME`; it was
  passing the workspace path as `dshHome`, so the update never landed.
- `dsh_run_stream` returns an `ok: false` envelope on failure, matching the
  documented contract, instead of `ok: true` with an error event embedded.
- `dsh_run_stream` no longer points the model at the non-existent
  `dsh_session_continue` tool; it now references `dsh_session_create` and
  `dsh_session_events`.

### Changed
- `.well-known/mcp.json` is regenerated: it advertised the retired
  `dsh-plugin-sdk` name, a dead homepage, a non-existent
  `dist/bin/dsh-plugin.js` path, and only 13 of the 20 MCP tools. A test now
  asserts it against the real registrations.
- `.well-known` is included in the published package so harnesses can read the
  manifest from an installed dependency.
- CLI and MCP handshake versions are read from `package.json` instead of being
  hardcoded, so they cannot drift again.
- `dsh.cluster.create` in the capability schema now offers the documented
  `adaptive` routing strategy.
- `skill install --scope project --target <client>` writes to that client's own
  project directory (`.claude/skills`, `.cursor/skills`, ...) instead of always
  falling back to `.agents/skills`.
- Discovery of the Harness module root is memoized, so SDK self-description and
  cluster construction no longer repeat a blocking module walk per call.
- The streaming integration test asserts that events arrive well before process
  exit instead of an absolute 250ms wall-clock bound that process-spawn cost on
  Windows exceeds on its own.

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
