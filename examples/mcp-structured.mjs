import { spawn } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("dist/bin/seekfleet.js");
const child = spawn(process.execPath, [cli, "serve-mcp"], { stdio: ["pipe", "pipe", "inherit"] });

const reqs = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0.1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  // create cluster with 5 instances
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dsh_cluster_create", arguments: { instances: [{ label: "i1" }, { label: "i2" }, { label: "i3" }, { label: "i4" }, { label: "i5" }], routing: "least-loaded" } } },
  // status with limit=2, offset=0
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dsh_cluster_status", arguments: { clusterId: "FROM_2", limit: 2, offset: 0 } } },
  // status with limit=2, offset=4 (last page)
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dsh_cluster_status", arguments: { clusterId: "FROM_2", limit: 2, offset: 4 } } },
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
      // Once we have clusterId from id 2, send paginated calls
      if (msg.id === 2 && msg.result?.structuredContent?.data?.clusterId) {
        const cid = msg.result.structuredContent.data.clusterId;
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dsh_cluster_status", arguments: { clusterId: cid, limit: 2, offset: 0 } } }) + "\n");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "dsh_cluster_status", arguments: { clusterId: cid, limit: 2, offset: 4 } } }) + "\n");
      }
    } catch { /* ignore */ }
  }
});

for (const r of reqs.slice(0, 2)) {
  child.stdin.write(JSON.stringify(r) + "\n");
  await new Promise(res => setTimeout(res, 200));
}
// Send create now (id 2)
child.stdin.write(JSON.stringify(reqs[2]) + "\n");

await new Promise(res => setTimeout(res, 4000));

console.log("=== structuredContent + pagination test ===");

const r2 = responses.get(2);
if (r2?.result?.structuredContent) {
  console.log("[id 2] cluster create structuredContent keys:", Object.keys(r2.result.structuredContent));
  console.log("[id 2] clusterId:", r2.result.structuredContent.data.clusterId);
}

const r3 = responses.get(3);
if (r3?.result?.structuredContent) {
  const pg = r3.result.structuredContent.data.pagination;
  console.log("\n[id 3] status limit=2 offset=0:");

  console.log("  pagination:", JSON.stringify(pg));

  console.log("  instances returned:", r3.result.structuredContent.data.instances.length);
}

const r4 = responses.get(4);
if (r4?.result?.structuredContent) {
  const pg = r4.result.structuredContent.data.pagination;
  console.log("\n[id 4] status limit=2 offset=4 (last page):");

  console.log("  pagination:", JSON.stringify(pg));

  console.log("  instances returned:", r4.result.structuredContent.data.instances.length);
}

child.kill();
setTimeout(() => process.exit(0), 200);
