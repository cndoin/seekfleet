import { spawn } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("dist/bin/seekfleet.js");
const child = spawn(process.execPath, [cli, "serve-mcp"], { stdio: ["pipe", "pipe", "inherit"] });

const reqs = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0.1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
];

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
      if (msg.id === 2 && msg.result) {
        const tools = msg.result.tools;
        console.log("Total tools:", tools.length);
        for (const t of tools) {
          console.log(`\n  - ${t.name}`);
          if (t.title) console.log(`    title: ${t.title}`);
          if (t.annotations) console.log(`    annotations: ${JSON.stringify(t.annotations)}`);
          if (t.inputSchema && t.inputSchema.properties) {
            const props = Object.keys(t.inputSchema.properties);
            console.log(`    inputs: ${props.length} fields [${props.join(", ")}]`);
          }
        }
        child.kill();
        setTimeout(() => process.exit(0), 200);
      }
    } catch { /* ignore */ }
  }
});

for (const r of reqs) {
  child.stdin.write(JSON.stringify(r) + "\n");
  await new Promise(res => setTimeout(res, 200));
}

setTimeout(() => process.exit(1), 8000);
