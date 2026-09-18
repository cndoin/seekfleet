# OpenAI Codex adapter

Build SeekFleet, then register its MCP server without rewriting unrelated Codex settings:

```bash
npm ci
npm run build
node dist/bin/seekfleet.js codex-install
node dist/bin/seekfleet.js codex-status
```

`codex-install` writes an idempotent MCP block to `~/.codex/config.toml`. The command uses the current Node.js executable plus the absolute built script path, which works on Windows, Linux, and macOS.

To enable the LAN dashboard inside the same MCP process:

```bash
node dist/bin/seekfleet.js codex-install \
  --env SEEKFLEET_DASHBOARD=1 \
  --env SEEKFLEET_DASHBOARD_HOST=0.0.0.0 \
  --env SEEKFLEET_DASHBOARD_PORT=8787 \
  --env SEEKFLEET_DASHBOARD_TOKEN=replace-with-a-strong-token
```

After changing MCP configuration, restart Codex. Call `dsh_inspect` to verify runtime discovery and tool availability.

Remove the integration without touching other MCP servers:

```bash
node dist/bin/seekfleet.js codex-uninstall
```

## Failure handling (read this before branching on results)

Task failure is **not** an exception. `dsh` exits non-zero for hard failures
(missing credentials, invalid flags, a crashed tool) and the SDK still resolves
with a `DshResult`. Codex must therefore branch on the envelope / the result,
never on "did the promise reject":

```ts
const r = await dsh.run("summarise this repo");
if (r.error) {
  // r.error.code is ABORTED | EXIT_NONZERO | RUN_FAILED | ...
  // r.answer is always "" on failure — do not use it.
  return { ok: false, message: r.error.message };
}
return { ok: true, answer: r.answer };
```

Over MCP every tool returns `{ ok, data?, error? }` and the task-running tools
(`dsh_run`, `dsh_run_stream`, `dsh_cluster_route`, `dsh_dag_run`) set
`ok: false` when the underlying run failed. `structuredContent` mirrors the
envelope. A `dsh_dag_run` failure keeps the full per-node detail under
`error.details.dag`.
