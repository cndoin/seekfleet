import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function installSeekFleetSkill(opts: SkillInstallOptions = {}): SkillInstallResult {
  const source = opts.packageRoot ? resolve(opts.packageRoot) : findPackageRoot();
  const sourceSkill = join(source, "SKILL.md");
  if (!existsSync(sourceSkill)) throw new Error("SeekFleet SKILL.md not found at " + sourceSkill);

  const destinations = resolveDestinations(opts);
  const installed: SkillInstallResult["installed"] = [];
  for (const destination of destinations) {
    if (existsSync(destination.path)) {
      if (!opts.force) throw new Error(`skill already exists at ${destination.path}; pass --force to replace it`);
      rmSync(destination.path, { recursive: true, force: true });
    }
    mkdirSync(destination.path, { recursive: true });
    cpSync(sourceSkill, join(destination.path, "SKILL.md"));
    for (const folder of ["agents", "references"] as const) {
      const from = join(source, folder);
      if (existsSync(from)) cpSync(from, join(destination.path, folder), { recursive: true });
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
  if (scope === "project") {
    return [
      { target: "agents", path: join(resolve(opts.projectDir ?? process.cwd()), ".agents", "skills", "seekfleet") },
    ];
  }

  const home = resolve(opts.homeDir ?? homedir());
  const codexHome = opts.homeDir
    ? join(home, ".codex")
    : process.env.CODEX_HOME
      ? resolve(process.env.CODEX_HOME)
      : join(home, ".codex");
  const roots: Record<Exclude<SkillInstallTarget, "auto" | "all">, string> = {
    agents: join(home, ".agents", "skills"),
    codex: join(codexHome, "skills"),
    claude: join(home, ".claude", "skills"),
    cursor: join(home, ".cursor", "skills"),
    gemini: join(home, ".gemini", "skills"),
  };

  let selected: Array<keyof typeof roots>;
  if (target === "all") {
    selected = ["agents", "codex", "claude", "cursor", "gemini"];
  } else if (target === "auto") {
    selected = (["codex", "claude", "cursor", "gemini"] as Array<keyof typeof roots>).filter((name) =>
      existsSync(dirname(roots[name])),
    );
    if (selected.length === 0) selected = ["agents"];
  } else {
    selected = [target];
  }
  return selected.map((name) => ({ target: name, path: join(roots[name], "seekfleet") }));
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
