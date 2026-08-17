import { parse } from "smol-toml";
import { readFileSync } from "node:fs";
try {
  const text = readFileSync("C:\\Users\\Ljj86\\.codex\\config.toml", "utf8");
  const obj = parse(text);
  console.log("TOML parses OK");
  console.log("Top-level keys:", Object.keys(obj));
  if (obj.mcp_servers) console.log("mcp_servers keys:", Object.keys(obj.mcp_servers));
  if (obj.mcp_servers?.seekfleet) {
    console.log("SeekFleet server config:", JSON.stringify(obj.mcp_servers.seekfleet, null, 2));
  }
} catch (e) {
  console.error("TOML parse FAILED:", e.message);
  process.exit(1);
}
