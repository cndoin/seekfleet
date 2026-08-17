---
name: seekfleet
description: Control DeepSeek Harness agents as one-shot tasks, durable sessions, routed clusters, or dependency DAGs. Use when an AI needs parallel agents, long-running task monitoring, token or cost budgets, policy enforcement, failure isolation, capability routing, or a phone-friendly LAN operations dashboard. Do not use for a simple response that needs no tools or execution control.
---

# SeekFleet

Use SeekFleet as the control plane for DeepSeek Harness agents. Select the smallest execution mode that safely completes the task.

## Select a mode

- Use `dsh_run` for one short task that should finish in the current call.
- Use a durable session for work that needs progress polling, cancellation, or crash recovery.
- Use a cluster for repeated or parallel work, specialization, budgets, caching, or failure isolation.
- Use `dsh_dag_run` when tasks have explicit dependencies and independent nodes can run concurrently.

Do not create a cluster for one simple task. Do not use a one-shot call when reliable cancellation or progress monitoring is required.

## Required workflow

1. Call `dsh_inspect` when runtime availability or profiles are unknown.
2. Select one-shot, session, cluster, or DAG using the rules above.
3. Set finite timeouts and a cost budget before dispatching open-ended work.
4. Save returned `clusterId` and `runId` values; never invent identifiers.
5. Poll at a moderate interval and reuse the returned event cursor.
6. Report relevant artifacts, token usage, cost, and failures.
7. Shut down temporary clusters when no work remains.

## Durable sessions

1. Call `dsh_session_create` with the task, profile, and tags.
2. Call `dsh_session_start` with the returned `runId`.
3. Poll `dsh_session_events` with `sinceSeq`; check `dsh_session_status` for lifecycle state.
4. Call `dsh_session_cancel` when requested or when a policy limit is reached.
5. Call `dsh_session_result` only after a terminal status.

Use `dsh_session_resume` only for crash-paused, idempotent work. It restarts the task and cannot guarantee continuation from an arbitrary tool call.

## Clusters

Create instances with unique labels and meaningful tags. Choose routing deliberately:

- `least-loaded`: general default.
- `round-robin`: even distribution.
- `tag`: strict specialization such as code, research, or review.
- `adaptive`: optimize for success, latency, load, failures, tags, and cost.
- `random`: testing only.

Use `dsh_capability_match` when tools or profiles are mandatory. Monitor `dsh_cluster_status` and `dsh_metrics`. Pause or reroute when breakers open, failures repeat, or the budget is exhausted.

## Safety

- Never bypass a policy failure; surface pending approvals.
- Treat working directories, patch paths, package installation, shell tools, and network access as potentially destructive.
- Keep dashboard tokens private. Bind to `0.0.0.0` only on a trusted LAN.
- Use OS-native absolute paths. Windows uses drive or UNC paths; Linux and macOS use `/` roots.
- Do not wrap DSH in an extra shell unless the task requires one; SeekFleet already terminates complete process trees across Windows, Linux, and macOS.

## LAN dashboard

Start MCP and the dashboard in one process:

```bash
seekfleet serve-mcp --dashboard --dashboard-host 0.0.0.0 --dashboard-port 8787
```

Open the printed LAN URL on a phone. The page shows agent state, load, requests, tokens, cost, failures, cache ratio, sessions, and protected cancel or shutdown controls.

Read [references/agent-control.md](references/agent-control.md) when implementing an integration, diagnosing reliability, or configuring network exposure.
