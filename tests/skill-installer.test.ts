import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyTree, installSeekFleetSkill } from "../src/skill-installer.js";

describe("SeekFleet skill installer", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seekfleet-skill-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("installs the complete skill into an explicit client", () => {
    const result = installSeekFleetSkill({ target: "codex", homeDir: home, packageRoot: resolve("."), force: true });
    const destination = join(home, ".codex", "skills", "seekfleet");
    expect(result.installed[0]?.path).toBe(destination);
    expect(existsSync(join(destination, "SKILL.md"))).toBe(true);
    expect(existsSync(join(destination, "references", "agent-control.md"))).toBe(true);
    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toContain("name: seekfleet");
  });

  it("uses the open Agent Skills location as the auto fallback", () => {
    const result = installSeekFleetSkill({ target: "auto", homeDir: home, packageRoot: resolve(".") });
    expect(result.installed.map((entry) => entry.target)).toEqual(["agents"]);
  });

  it("refuses to overwrite unless force is explicit", () => {
    installSeekFleetSkill({ target: "agents", homeDir: home, packageRoot: resolve(".") });
    expect(() => installSeekFleetSkill({ target: "agents", homeDir: home, packageRoot: resolve(".") })).toThrow(
      "--force",
    );
  });

  it("leaves no partial install when one of several targets conflicts", () => {
    installSeekFleetSkill({ target: "agents", homeDir: home, packageRoot: resolve(".") });
    expect(() => installSeekFleetSkill({ target: "all", homeDir: home, packageRoot: resolve(".") })).toThrow(/--force/);
    // Every destination is validated up front, so the untouched clients must
    // still be untouched — a mid-loop abort used to leave a partial install.
    expect(existsSync(join(home, ".claude", "skills", "seekfleet"))).toBe(false);
    expect(existsSync(join(home, ".gemini", "skills", "seekfleet"))).toBe(false);
    expect(existsSync(join(home, ".cursor", "skills", "seekfleet"))).toBe(false);
  });

  it("installs every client when force is given", () => {
    const result = installSeekFleetSkill({ target: "all", homeDir: home, packageRoot: resolve("."), force: true });
    expect(result.installed.map((entry) => entry.path)).toEqual([
      join(home, ".agents", "skills", "seekfleet"),
      join(home, ".codex", "skills", "seekfleet"),
      join(home, ".claude", "skills", "seekfleet"),
      join(home, ".cursor", "skills", "seekfleet"),
      join(home, ".gemini", "skills", "seekfleet"),
    ]);
    for (const entry of result.installed) {
      expect(existsSync(join(entry.path, "references", "agent-control.md"))).toBe(true);
    }
  });

  it("supports a client-specific project scope", () => {
    const project = mkdtempSync(join(tmpdir(), "seekfleet-proj-"));
    try {
      const result = installSeekFleetSkill({
        target: "claude",
        scope: "project",
        projectDir: project,
        packageRoot: resolve("."),
      });
      // Claude reads project skills from .claude/skills, not .agents/skills.
      expect(result.installed[0]?.path).toBe(join(project, ".claude", "skills", "seekfleet"));
      expect(existsSync(join(result.installed[0]!.path, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("rejects unknown targets", () => {
    expect(() =>
      installSeekFleetSkill({ target: "not-a-client" as never, homeDir: home, packageRoot: resolve(".") }),
    ).toThrow(/unknown skill target/);
  });
});

describe("copyTree", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seekfleet-copytree-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("copies nested directories without using fs.cpSync", () => {
    const from = join(root, "from");
    mkdirSync(join(from, "a", "b"), { recursive: true });
    writeFileSync(join(from, "top.txt"), "top");
    writeFileSync(join(from, "a", "mid.txt"), "mid");
    writeFileSync(join(from, "a", "b", "deep.txt"), "deep");

    const to = join(root, "to");
    copyTree(from, to);

    expect(readFileSync(join(to, "top.txt"), "utf8")).toBe("top");
    expect(readFileSync(join(to, "a", "mid.txt"), "utf8")).toBe("mid");
    expect(readFileSync(join(to, "a", "b", "deep.txt"), "utf8")).toBe("deep");
    expect(readdirSync(join(to, "a", "b"))).toEqual(["deep.txt"]);
  });

  it("copies a single file", () => {
    writeFileSync(join(root, "one.txt"), "x");
    copyTree(join(root, "one.txt"), join(root, "sub", "two.txt"));
    expect(readFileSync(join(root, "sub", "two.txt"), "utf8")).toBe("x");
  });
});
