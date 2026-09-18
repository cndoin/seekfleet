import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Recursively copy a directory tree, file by file.
 *
 * `fs.cpSync(src, dest, { recursive: true })` cannot be used here: on Node
 * 22.22.x / Windows it terminates the process outright (observed exit code 127,
 * with no exception and no stack trace) while copying a plain directory. Since
 * `seekfleet skill install` is the primary onboarding step and Node 22 is the
 * documented minimum, the installer must not depend on that code path.
 * Symlinks are skipped rather than followed, so a link cycle cannot recurse
 * forever.
 */
export function copyTree(from: string, to: string): void {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      copyTree(join(from, entry.name), join(to, entry.name));
    }
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

export type SkillInstallTarget = "auto" | "all" | "agents" | "codex" | "claude" | "cursor" | "gemini";
export type SkillInstallScope = "user" | "project";

export interface SkillInstallOptions {
  target?: SkillInstallTarget;
  scope?: SkillInstallScope;
  force?: boolean;
  homeDir?: string;
  projectDir?: string;
  packageRoot?: string;
}

export interface SkillInstallResult {
  skill: "seekfleet";
  source: string;
  installed: Array<{ target: string; path: string }>;
}

/** Client directory names under $HOME for the user scope. */
const USER_ROOTS: Record<Exclude<SkillInstallTarget, "auto" | "all">, string[]> = {
  agents: [".agents"],
  codex: [".codex"],
  claude: [".claude"],
  cursor: [".cursor"],
  gemini: [".gemini"],
};

/**
 * Install the bundled skill into every selected client.
 *
 * Ordering matters: every destination is validated *before* the first byte is
 * written, so a refusal can never leave a half-installed skill behind. The
 * previous implementation threw on the first existing directory mid-loop, which
 * made `--target all` leave some clients updated and others untouched.
 */
export function installSeekFleetSkill(opts: SkillInstallOptions = {}): SkillInstallResult {
  const source = opts.packageRoot ? resolve(opts.packageRoot) : findPackageRoot();
  const sourceSkill = join(source, "SKILL.md");
  if (!existsSync(sourceSkill)) throw new Error("SeekFleet SKILL.md not found at " + sourceSkill);

  const destinations = resolveDestinations(opts);
  if (destinations.length === 0) throw new Error("no skill target selected");

  if (!opts.force) {
    const conflicts = destinations.filter((d) => existsSync(d.path)).map((d) => d.path);
    if (conflicts.length > 0) {
      throw new Error(
        "skill already exists at " + conflicts.join(", ") + "; pass --force to replace it (nothing was written)",
      );
    }
  }

  const installed: SkillInstallResult["installed"] = [];
  for (const destination of destinations) {
    if (existsSync(destination.path)) rmSync(destination.path, { recursive: true, force: true });
    mkdirSync(destination.path, { recursive: true });
    copyTree(sourceSkill, join(destination.path, "SKILL.md"));
    for (const folder of ["agents", "references"] as const) {
      const from = join(source, folder);
      if (existsSync(from)) copyTree(from, join(destination.path, folder));
    }
    installed.push(destination);
  }
  return { skill: "seekfleet", source, installed };
}

function resolveDestinations(opts: SkillInstallOptions): Array<{ target: string; path: string }> {
  const scope = opts.scope ?? "user";
  const target = opts.target ?? "auto";
  const validTargets: SkillInstallTarget[] = ["auto", "all", "agents", "codex", "claude", "cursor", "gemini"];
  if (!validTargets.includes(target)) throw new Error("unknown skill target: " + target);
  if (scope !== "user" && scope !== "project") throw new Error("unknown skill scope: " + scope);

  const home = resolve(opts.homeDir ?? homedir());
  const codexHome = opts.homeDir
    ? join(home, ".codex")
    : process.env.CODEX_HOME
      ? resolve(process.env.CODEX_HOME)
      : join(home, ".codex");

  const rootFor = (name: keyof typeof USER_ROOTS): string =>
    name === "codex" ? codexHome : join(home, ...USER_ROOTS[name]);

  if (scope === "project") {
    // Project-scoped skills are per-client directories; `.agents` stays the
    // default because that is the documented, client-agnostic location.
    const projectDir = resolve(opts.projectDir ?? process.cwd());
    const names: Array<keyof typeof USER_ROOTS> =
      target === "all" ? ["agents", "codex", "claude", "cursor", "gemini"] : target === "auto" ? ["agents"] : [target];
    return names.map((name) => ({
      target: `${name} (project)`,
      path: join(projectDir, USER_ROOTS[name][0]!, "skills", "seekfleet"),
    }));
  }

  let selected: Array<keyof typeof USER_ROOTS>;
  if (target === "all") {
    selected = ["agents", "codex", "claude", "cursor", "gemini"];
  } else if (target === "auto") {
    selected = (["codex", "claude", "cursor", "gemini"] as Array<keyof typeof USER_ROOTS>).filter((name) =>
      existsSync(rootFor(name)),
    );
    if (selected.length === 0) selected = ["agents"];
  } else {
    selected = [target];
  }
  return selected.map((name) => ({ target: name, path: join(rootFor(name), "skills", "seekfleet") }));
}

function findPackageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (pkg.name === "seekfleet") return current;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("cannot locate the SeekFleet package root");
}
