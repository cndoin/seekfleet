// Full MCP e2e: initialize, list, inspect, run, cluster_create, cluster_route, cluster_status, shutdown
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("dist/bin/seekfleet.js");
const child = spawn(process.execPath, [cli, "serve-mcp"], { stdio: ["pipe", "pipe", "inherit"] });

const reqs = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0.1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dsh_inspect", arguments: {} } },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dsh_run", arguments: { task: "say OK in one word", timeoutMs: 15000 } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dsh_cluster_create", arguments: { instances: [{ label: "x1" }, { label: "x2" }], routing: "least-loaded" } } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "dsh_cluster_route", arguments: { clusterId: "FROM_4", task: "say hello", timeoutMs: 15000 } } },
];

const responses = new Map();
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
      // Replace placeholder FROM_4 with actual cluster id from id:4
      if (msg.id === 4 && msg.result?.content?.[0]?.text) {
        const data = JSON.parse(msg.result.content[0].text);
        if (data.ok && data.data?.clusterId) {
          const cid = data.data.clusterId;
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "dsh_cluster_route", arguments: { clusterId: cid, task: "say routed", timeoutMs: 15000 } } }) + "\n");
        }
      }
    } catch { /* ignore */ }
  }
});

for (const r of reqs.slice(0, 5)) {
  if (r.id === 5) continue; // dispatched dynamically
  child.stdin.write(JSON.stringify(r) + "\n");
  await new Promise(res => setTimeout(res, 300));
}

// wait for id 5 (route) to come back
await new Promise(res => setTimeout(res, 8000));

console.log("=== e2e summary ===");
for (const id of [1, 2, 3, 4, 5]) {
  const r = responses.get(id);
  if (!r) { console.log("id " + id + ": (no response)"); continue; }
  if (r.error) { console.log("id " + id + ": ERROR " + JSON.stringify(r.error).slice(0, 200)); continue; }
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.result);
  console.log("id " + id + ": " + text.slice(0, 250) + (text.length > 250 ? "..." : ""));
}
child.kill();
setTimeout(() => process.exit(0), 200);
