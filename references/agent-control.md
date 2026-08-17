# SeekFleet agent control reference

## Stable response handling

Every MCP tool returns an envelope with `ok`, `data`, or `error`. Branch on `ok`; do not parse the human-readable text when `structuredContent` is available.

Session statuses are `queued`, `running`, `paused`, `succeeded`, `failed`, and `cancelled`. Only `paused` sessions may be resumed. `succeeded`, `failed`, and `cancelled` are terminal.

## Failure handling

- Retry transient spawn/provider failures with capped exponential backoff and jitter.
- Do not retry policy errors, budget rejection, invalid DAGs, or an open breaker without changing the cause.
- A failed DAG dependency skips critical downstream nodes. Design side-effecting nodes to be idempotent.
- Cluster scale-down drains in-flight work before removing an instance.
- Cached results are isolated by task, profile, environment, workspace, patches, and runtime version context.

## Dashboard network model

The dashboard is an HTTP server embedded in the MCP process. It defaults to `127.0.0.1`; use `0.0.0.0` only for trusted local networks. All data and control API endpoints require a bearer token. The HTML shell and health endpoint contain no task data.

Recommended firewall policy: allow the selected TCP port only from the local subnet. For access across untrusted networks, place the server behind TLS and an authenticated reverse proxy or VPN.

## Operational limits

- Always set finite task timeouts.
- Set `maxOutputBytes` for untrusted or verbose tasks.
- Set cluster budget before dispatching autonomous loops.
- Keep concurrency aligned with provider rate limits and host CPU/memory.
- Monitor failure rate, p95 latency, open breakers, queue depth, and cache hit ratio.
