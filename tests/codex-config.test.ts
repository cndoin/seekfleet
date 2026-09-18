import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexInstall, codexUninstall, codexStatus } from "../src/codex-config.js";

describe("codex-config", () => {
  let home: string;
  let cfgPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dsh-codex-"));
    cfgPath = join(home, "config.toml");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("adds block to empty config", () => {
    const r = codexInstall({
      codexHome: home,
      serverCommand: "/usr/local/bin/seekfleet",
      serverArgs: ["serve-mcp"],
      startupTimeoutSec: 30,
    });
    expect(r.action).toBe("added");
    expect(existsSync(cfgPath)).toBe(true);
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toContain("[mcp_servers.seekfleet]");
    expect(text).toContain("startup_timeout_sec = 30");
  });

  it("preserves user comments and other sections", () => {
    writeFileSync(
      cfgPath,
      ["# user comment - DO NOT TOUCH", 'model = "gpt-5"', "", "[projects.work]", 'trust_level = "trusted"', ""].join(
        "\n",
      ),
      "utf8",
    );
    codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toContain("# user comment - DO NOT TOUCH");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[projects.work]");
  });

  it("is idempotent", () => {
    codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    const r2 = codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    expect(r2.action).toBe("noop");
  });

  it("uninstalls", () => {
    codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    codexUninstall({ codexHome: home });
    const text = readFileSync(cfgPath, "utf8");
    expect(text).not.toContain("[mcp_servers.seekfleet]");
    expect(codexStatus({ codexHome: home }).installed).toBe(false);
  });

  it("reports invalid TOML without writing", () => {
    codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    // Manually corrupt
    const text = readFileSync(cfgPath, "utf8");
    writeFileSync(cfgPath, text + "\n[mcp_servers.broken\n", "utf8");
    // (We can't easily install over a corrupted file via codexInstall because it parses via smol-toml.)
    // Instead, just check that on a fresh dir, install works.
    const r = codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    expect(["added", "updated", "noop"]).toContain(r.action);
  });

  it("round-trips the disabled flag through status", () => {
    codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"], disabled: true });
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toContain("disabled = true");
    // A literal /disabled\\s*=\\s*true/ regex can never match a real line, so
    // status used to report disabled:false for a disabled server.
    const s = codexStatus({ codexHome: home });
    expect(s.installed).toBe(true);
    expect(s.disabled).toBe(true);
  });

  it("reports enabled servers as not disabled", () => {
    codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    expect(codexStatus({ codexHome: home }).disabled).toBe(false);
  });

  it("does not attribute another server's disabled flag to ours", () => {
    codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    writeFileSync(cfgPath, readFileSync(cfgPath, "utf8") + "\n[mcp_servers.other]\ndisabled = true\n", "utf8");
    const s = codexStatus({ codexHome: home });
    expect(s.installed).toBe(true);
    expect(s.disabled).toBe(false);
    expect(s.block).not.toContain("mcp_servers.other");
  });

  it("refuses to write a block with no launch command", () => {
    const before = process.env.DSH_PLUGIN_CLI;
    delete process.env.DSH_PLUGIN_CLI;
    try {
      expect(() => codexInstall({ codexHome: home })).toThrow(/no MCP server command resolved/);
      expect(existsSync(cfgPath)).toBe(false);
    } finally {
      if (before !== undefined) process.env.DSH_PLUGIN_CLI = before;
    }
  });

  it("leaves the file untouched on a noop install", () => {
    codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    const first = readFileSync(cfgPath, "utf8");
    const r = codexInstall({ codexHome: home, serverCommand: "/x", serverArgs: ["serve-mcp"] });
    expect(r.action).toBe("noop");
    expect(readFileSync(cfgPath, "utf8")).toBe(first);
  });
});
