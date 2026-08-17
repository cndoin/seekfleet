// Locate or install the DeepSeek Harness (dsh) module.
// We DO NOT modify DSH. We only detect / install / verify it, then spawn
// `node <moduleRoot>/lib/bin.js` as a subprocess.
//
// Resolution order:
//   1. explicit `dshModuleRoot` argument
//   2. DSH_MODULE_ROOT env var
//   3. require.resolve('@deepseek-ai/dsh/package.json', { paths: [thisPkg, cwd, ...] })
//   4. walk up from cwd looking for node_modules/@deepseek-ai/dsh
//   5. global npm / pnpm root
//   6. (optional) installIfMissing => npm install --no-save @deepseek-ai/dsh
//
// DSH_HOME resolution:
//   1. explicit `dshHome`
//   2. DSH_HOME env var
//   3. <workspace>/.dsh-home (if workspace given)
//   4. process.env.HOME / USERPROFILE + '/.dsh'

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);

export interface ResolvedDsh {
  moduleRoot: string;
  binJs: string;
  version: string;
  dshHome: string;
}

export interface ResolveOptions {
  dshModuleRoot?: string;
  dshHome?: string;
  workspace?: string;
  installIfMissing?: boolean;
}

/** Find @deepseek-ai/dsh by walking node_modules + a couple of well-known locations. */
export function resolveDshModuleRoot(explicit?: string): string | null {
  if (explicit && existsSync(join(explicit, "package.json"))) return resolve(explicit);

  const envRoot = process.env.DSH_MODULE_ROOT;
  if (envRoot && existsSync(join(envRoot, "package.json"))) return resolve(envRoot);

  const tried: string[] = [];

  // 1. require.resolve from cwd
  for (const fromDir of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    try {
      const pkgPath = requireCjs.resolve("@deepseek-ai/dsh/package.json", { paths: [fromDir] });
      const modRoot = dirname(pkgPath);
      if (existsSync(join(modRoot, "lib", "bin.js"))) return modRoot;
      tried.push(modRoot);
    } catch {
      /* swallow */
    }
  }

  // 2. global npx cache — common locations on this machine
  const candidates: string[] = [];
  const appData = process.env.APPDATA || join(homedir(), "AppData/Roaming");
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData/Local");
  candidates.push(join(appData, "npm-cache/_npx"), join(localAppData, "npm-cache/_npx"), join(homedir(), ".npm/_npx"));
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    // pick the newest hash dir that contains @deepseek-ai/dsh
    let newest: { mtime: number; path: string } | null = null;
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dshPath = join(root, e.name, "node_modules", "@deepseek-ai", "dsh");
        if (existsSync(join(dshPath, "package.json")) && existsSync(join(dshPath, "lib", "bin.js"))) {
          const stat = statSync(join(dshPath, "package.json"));
          if (!newest || stat.mtimeMs > newest.mtime) newest = { mtime: stat.mtimeMs, path: dshPath };
        }
      }
    } catch {
      /* swallow */
    }
    if (newest) return newest.path;
  }

  // 3. npm / pnpm global roots
  for (const manager of ["npm", "pnpm"] as const) {
    const globalRoot = packageManagerOutput(manager, ["root", "-g"]);
    if (!globalRoot) continue;
    const cand = join(globalRoot, "@deepseek-ai", "dsh");
    if (existsSync(join(cand, "package.json")) && existsSync(join(cand, "lib", "bin.js"))) return cand;
  }

  return null;
}

/** Install dsh into the current project when explicitly requested. */
export function installDsh(): string | null {
  try {
    runPackageManager("npm", ["install", "--no-save", "--no-audit", "--no-fund", "@deepseek-ai/dsh"]);
  } catch {
    return null;
  }
  return resolveDshModuleRoot();
}

function packageManagerExecutable(manager: "npm" | "pnpm"): { command: string; prefix: string[] } {
  if (manager === "npm" && process.env.npm_execpath) {
    return { command: process.execPath, prefix: [process.env.npm_execpath] };
  }
  return { command: process.platform === "win32" ? manager + ".cmd" : manager, prefix: [] };
}

function packageManagerOutput(manager: "npm" | "pnpm", args: string[]): string | null {
  try {
    const executable = packageManagerExecutable(manager);
    return execFileSync(executable.command, [...executable.prefix, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function runPackageManager(manager: "npm" | "pnpm", args: string[]): void {
  const executable = packageManagerExecutable(manager);
  execFileSync(executable.command, [...executable.prefix, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

function readVersion(moduleRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(moduleRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function ensureDshHome(explicit?: string, workspace?: string): string {
  const candidates = [
    explicit,
    process.env.DSH_HOME,
    workspace ? join(resolve(workspace), ".dsh-home") : undefined,
    join(homedir(), ".dsh"),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  for (const c of candidates) {
    try {
      const absolute = resolve(c);
      mkdirSync(absolute, { recursive: true });
      return absolute;
    } catch {
      /* try next */
    }
  }
  throw new Error("seekfleet: cannot create DSH_HOME in any candidate location");
}

export function resolveDsh(opts: ResolveOptions = {}): ResolvedDsh {
  const moduleRoot = resolveDshModuleRoot(opts.dshModuleRoot) ?? (opts.installIfMissing ? installDsh() : null);
  if (!moduleRoot) {
    throw new Error(
      "seekfleet: @deepseek-ai/dsh not found.\n" +
        "Resolution tried: DSH_MODULE_ROOT, require.resolve, npm/_npx cache, pnpm global.\n" +
        "Fix: install it locally (npm i @deepseek-ai/dsh) or set DSH_MODULE_ROOT.",
    );
  }
  const binJs = join(moduleRoot, "lib", "bin.js");
  if (!existsSync(binJs)) {
    throw new Error("seekfleet: @deepseek-ai/dsh found but lib/bin.js missing at " + binJs);
  }
  const dshHome = ensureDshHome(opts.dshHome, opts.workspace);
  return {
    moduleRoot,
    binJs,
    version: readVersion(moduleRoot),
    dshHome,
  };
}
