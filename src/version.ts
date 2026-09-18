// version.ts - single source of truth for the SeekFleet package version.
//
// The CLI banner, the MCP server handshake and the discovery manifest all
// advertise a version. Hardcoding it in each place let them drift apart from
// package.json, which makes it impossible for a harness to tell which build it
// is actually talking to. Read the manifest instead.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/** Version from the nearest `seekfleet` package.json. Works from src/ and dist/. */
export function packageVersion(): string {
  if (cached !== null) return cached;
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "seekfleet" && typeof pkg.version === "string") {
          cached = pkg.version;
          return cached;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  cached = "0.0.0";
  return cached;
}
