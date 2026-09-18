// Guards the machine-readable discovery surface that harnesses read to
// auto-configure SeekFleet. This file drifted badly in practice (it advertised
// the old project name "dsh-plugin-sdk", a dead homepage, the wrong binary path
// `dist/bin/dsh-plugin.js`, and 13 of the 20 MCP tools), so it is now asserted
// against the real registrations instead of being trusted.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MCP_TOOL_NAMES } from "../src/mcp-server.js";
import { packageVersion } from "../src/version.js";

interface Manifest {
  name: string;
  version: string;
  homepage: string;
  transport: { type: string; command: string; args: string[] };
  tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
}

const repoRoot = resolve(".");
const manifestPath = join(repoRoot, ".well-known", "mcp.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  repository: { url: string };
  bin: Record<string, string>;
};

describe("discovery manifest", () => {
  it("advertises the real package identity", () => {
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.homepage).toBe(pkg.repository.url.replace(/\.git$/, ""));
    expect(manifest.homepage).toContain("cndoin/seekfleet");
  });

  it("points at a binary path that actually exists in the published layout", () => {
    // package.json bin maps the CLI to ./dist/bin/seekfleet.js
    const binTarget = pkg.bin["seekfleet"]!;
    expect(binTarget).toBe("./dist/bin/seekfleet.js");
    expect(manifest.transport.type).toBe("stdio");
    expect(manifest.transport.command).toBe("node");
    expect(manifest.transport.args[0]).toBe(binTarget.replace(/^\.\//, ""));
    expect(manifest.transport.args[1]).toBe("serve-mcp");
  });

  it("lists exactly the tools the MCP server registers", () => {
    expect(manifest.tools.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
  });

  it("declares only known annotation keys", () => {
    const allowed = new Set(["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint", "title"]);
    for (const tool of manifest.tools) {
      for (const key of Object.keys(tool.annotations ?? {})) {
        expect(allowed.has(key), `unexpected annotation "${key}" on ${tool.name}`).toBe(true);
      }
    }
  });
});

describe("package version helper", () => {
  it("matches package.json", () => {
    expect(packageVersion()).toBe(pkg.version);
  });

  it("is discovered from the compiled output too", () => {
    // dist/ mirrors src/ one level deeper; the walk-up must still find the root.
    expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
    expect(packageVersion()).not.toBe("0.0.0");
  });
});
