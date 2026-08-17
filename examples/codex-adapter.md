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
