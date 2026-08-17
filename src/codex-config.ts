// codex-config.ts - idempotent patcher for ~/.codex/config.toml.
// Codex uses a TOML config with [mcp_servers.<name>] sections. We never
// rewrite the file - we surgically add or replace one block so the user's
// existing settings (model, trust_level, plugins, etc.) are preserved.

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { writeFileAtomicSync } from "./atomic-file.js";

export interface CodexInstallOptions {
  /** absolute path to the SeekFleet MCP server CLI (defaults to <sdk>/dist/bin/seekfleet.js) */
  serverCommand?: string;
  /** args passed to the server (defaults to ["serve-mcp"]) */
  serverArgs?: string[];
  /** env vars passed to the server process */
  serverEnv?: Record<string, string>;
  /** startup timeout in seconds (default 60 - dsh boots Cordis which can take a few seconds) */
  startupTimeoutSec?: number;
  /** set to true to disable the server without removing the section */
  disabled?: boolean;
  /** explicit path to ~/.codex; defaults to $CODEX_HOME or %USERPROFILE%/.codex */
  codexHome?: string;
  /** name of the mcp_servers entry (default "seekfleet") */
  serverName?: string;
}

export interface CodexInstallResult {
  configPath: string;
  serverName: string;
  action: "added" | "updated" | "noop" | "invalid";
  previousDisabled?: boolean;
  newDisabled?: boolean;
  validationError?: string;
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function defaultServerCommand(): string {
  // We don't know where the SDK lives from inside the SDK itself; the caller
  // (the CLI) computes it. The default falls back to a path the CLI sets.
  return process.env.DSH_PLUGIN_CLI || "";
}

function configPath(codexHome: string): string {
  return join(codexHome, "config.toml");
}

function ensureCodexHome(codexHome: string): void {
  mkdirSync(codexHome, { recursive: true });
}

/** Build the [mcp_servers.<name>] TOML block as a string. */
function renderBlock(opts: CodexInstallOptions, serverName: string): string {
  const command = opts.serverCommand || defaultServerCommand();
  const args = opts.serverArgs ?? ["serve-mcp"];
  const lines: string[] = [];
  lines.push("");
  lines.push("[mcp_servers." + serverName + "]");
  lines.push("command = " + tomlString(command));
  lines.push("args = [" + args.map((a) => tomlString(a)).join(", ") + "]");
  if (typeof opts.startupTimeoutSec === "number") {
    lines.push("startup_timeout_sec = " + Math.max(1, Math.floor(opts.startupTimeoutSec)));
  } else {
    lines.push("startup_timeout_sec = 60");
  }
  if (opts.disabled) lines.push("disabled = true");
  const env = opts.serverEnv ?? {};
  if (Object.keys(env).length > 0) {
    lines.push("");
    lines.push("[mcp_servers." + serverName + ".env]");
    for (const [k, v] of Object.entries(env)) {
      lines.push(k + " = " + tomlString(v));
    }
  }
  return lines.join("\n");
}

function tomlString(s: string): string {
  // TOML basic string: escape backslash and double-quote.
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Strip an existing [mcp_servers.<name>] (and any nested [.env] etc.) section. */
function stripSection(text: string, serverName: string): { text: string; removed: boolean } {
  // A header line that belongs to our server block (either the root [mcp_servers.<name>]
  // or any subsection like [mcp_servers.<name>.env]).
  const ownedRe = new RegExp("^\\[mcp_servers\\." + escapeRegex(serverName) + "(?:\\.[^\\]]+)?\\]");
  const ownedHeader = (line: string) => ownedRe.test(line);
  // A header line that belongs to SOMEONE ELSE.
  const foreignRe = /^\[[^\]]+\]/;
  const foreignHeader = (line: string) => foreignRe.test(line) && !ownedHeader(line);
  const lines = text.split("\n");
  const out: string[] = [];
  let removed = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (ownedHeader(line)) {
      removed = true;
      i++;
      // Skip until we hit a header that is not part of our block.
      while (i < lines.length && !foreignHeader(lines[i]!)) i++;
      // Skip the trailing blank if present.
      if (i < lines.length && lines[i] === "") i++;
      continue;
    }
    out.push(line);
    i++;
  }
  const collapsed = out.join("\n").replace(/\n{3,}/g, "\n\n");
  return { text: collapsed.trimEnd() + "\n", removed };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read the existing config and return previous [mcp_servers.<name>].disabled if any. */
/** Validate that the merged TOML parses cleanly. Returns the error string or null. */
function validateToml(text: string, source: string): string | null {
  try {
    parseToml(text);
    return null;
  } catch (e) {
    return "generated TOML does not parse (" + source + "): " + (e instanceof Error ? e.message : String(e));
  }
}
function readExistingDisabled(text: string, serverName: string): boolean | undefined {
  const re = new RegExp(
    "^\\[mcp_servers\\." + escapeRegex(serverName) + "\\][\\\\s\\\\S]*?disabled\\s*=\\s*(true|false)",
    "m",
  );
  const m = text.match(re);
  if (!m) return undefined;
  return m[1] === "true";
}

export function codexInstall(opts: CodexInstallOptions = {}): CodexInstallResult {
  const codexHome = opts.codexHome || defaultCodexHome();
  ensureCodexHome(codexHome);
  const cfgPath = configPath(codexHome);
  const serverName = opts.serverName || "seekfleet";

  const existing = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
  const prevDisabled = readExistingDisabled(existing, serverName);

  const stripped = stripSection(existing, serverName);
  const block = renderBlock(opts, serverName);
  const merged = stripped.text.trimEnd() + "\n" + block + "\n";

  let action: CodexInstallResult["action"];
  if (merged.trimEnd() + "\n" === existing.trimEnd() + "\n") {
    action = "noop";
  } else if (stripped.removed) {
    action = "updated";
  } else {
    action = "added";
  }

  const validationError = validateToml(merged, "merged");
  if (validationError) {
    return {
      configPath: cfgPath,
      serverName,
      action: "invalid",
      previousDisabled: prevDisabled,
      newDisabled: opts.disabled,
      validationError,
    };
  }

  // atomic write: temp + rename so a crash mid-write never corrupts the config
  writeFileAtomicSync(cfgPath, merged);

  return {
    configPath: cfgPath,
    serverName,
    action,
    previousDisabled: prevDisabled,
    newDisabled: opts.disabled,
  };
}

export function codexUninstall(opts: { codexHome?: string; serverName?: string } = {}): CodexInstallResult {
  const codexHome = opts.codexHome || defaultCodexHome();
  const cfgPath = configPath(codexHome);
  const serverName = opts.serverName || "seekfleet";

  if (!existsSync(cfgPath)) {
    return { configPath: cfgPath, serverName, action: "noop" };
  }
  const existing = readFileSync(cfgPath, "utf8");
  const prevDisabled = readExistingDisabled(existing, serverName);
  const stripped = stripSection(existing, serverName);
  if (!stripped.removed) {
    return { configPath: cfgPath, serverName, action: "noop", previousDisabled: prevDisabled };
  }
  const validationError = validateToml(stripped.text, "uninstall");
  if (validationError) {
    return {
      configPath: cfgPath,
      serverName,
      action: "invalid",
      previousDisabled: prevDisabled,
      validationError,
    };
  }
  writeFileAtomicSync(cfgPath, stripped.text);
  return { configPath: cfgPath, serverName, action: "updated", previousDisabled: prevDisabled };
}

export function codexStatus(opts: { codexHome?: string; serverName?: string } = {}): {
  configPath: string;
  installed: boolean;
  disabled?: boolean;
  block?: string;
} {
  const codexHome = opts.codexHome || defaultCodexHome();
  const cfgPath = configPath(codexHome);
  const serverName = opts.serverName || "seekfleet";
  if (!existsSync(cfgPath)) return { configPath: cfgPath, installed: false };
  const text = readFileSync(cfgPath, "utf8");
  const headerRe = new RegExp("^\\[mcp_servers\\." + escapeRegex(serverName) + "\\]", "m");
  const headerMatch = headerRe.exec(text);
  if (!headerMatch) return { configPath: cfgPath, installed: false };
  const start = headerMatch.index;
  const after = text.slice(start);
  // Walk lines; stop at first foreign header.
  const allLines = after.split("\n");
  const blockLines: string[] = [];
  for (let k = 0; k < allLines.length; k++) {
    const l = allLines[k]!;
    if (
      k > 0 &&
      /^\[[^\]]+\]/.test(l) &&
      !new RegExp("^\\[mcp_servers\\." + escapeRegex(serverName) + "(\\.|$)").test(l)
    )
      break;
    blockLines.push(l);
  }
  const block = blockLines.join("\n");
  const disabled = /disabled\\s*=\\s*true/.test(block);
  return { configPath: cfgPath, installed: true, disabled, block };
}
