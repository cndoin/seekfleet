import { spawn } from "node:child_process";
import { resolve } from "node:path";

const cli = resolve("dist/bin/seekfleet.js");
const child = spawn(process.execPath, [cli, "serve-mcp"], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
    let responseCount = 0;
    let nextId = 1;
    const responses = new Map();
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    const callTool = (name, args = {}) => {
      const id = nextId++;
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      return id;
    };
    const callAndWait = (name, args = {}) => new Promise((resolveP, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error("timeout " + name)), 30000);
      const handler = (msg) => {
        if (msg.id === id) { clearTimeout(t); child.stdout.off("data", dataHandler); resolveP(msg); }
      };
      const dataHandler = (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          try { handler(JSON.parse(line)); } catch {}
        }
      };
      child.stdout.on("data", dataHandler);
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    });

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
        } catch {}
      }
    });

    // initialize
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ult", version: "0.1" } } });
    await new Promise(r => setTimeout(r, 200));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise(r => setTimeout(r, 200));

    // create cluster
    const cr = await callAndWait("dsh_cluster_create", {
      instances: [
        { label: "a", tags: ["code"] },
        { label: "b", tags: ["research"] },
      ],
      routing: "least-loaded",
    });
    const cid = JSON.parse(cr.result.structuredContent.data ? JSON.stringify(cr.result.structuredContent.data) : cr.result.content[0].text).clusterId;
    console.log("cluster created:", cid);

    // DAG run
    const dr = await callAndWait("dsh_dag_run", {
      clusterId: cid,
      nodes: [
        { id: "x", task: "say X in one word" },
        { id: "y", task: "say Y in one word", dependsOn: ["x"] },
      ],
    });
    console.log("DAG result preview:", dr.result.content[0].text.slice(0, 300));

    // metrics
    const mt = await callAndWait("dsh_metrics", { clusterId: cid, format: "prometheus" });
    const promText = mt.result.content[0].text;
    console.log("\nPrometheus first 600 chars:");
    console.log(promText.slice(0, 600));

    // capability match
    const cm = await callAndWait("dsh_capability_match", { clusterId: cid, requireTags: ["code"] });
    console.log("\nCapability match for tag=code:");
    console.log(cm.result.content[0].text.slice(0, 400));

    child.kill();
    setTimeout(() => process.exit(0), 200);
  
