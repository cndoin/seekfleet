import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installSeekFleetSkill } from "../src/skill-installer.js";

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
});
