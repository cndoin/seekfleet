import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasParentTraversal, matchesPortablePath, resolveInside, resolvePortablePath } from "../src/platform-path.js";

describe("portable paths", () => {
  it("normalizes Windows paths independently of the host OS", () => {
    expect(resolvePortablePath("C:\\Agents\\..\\Workspace")).toBe("C:\\Workspace");
    expect(matchesPortablePath("c:\\WORKSPACE\\project", "C:\\Workspace")).toBe(true);
    expect(matchesPortablePath("C:\\Workspace-other", "C:\\Workspace")).toBe(false);
  });

  it("keeps POSIX path matching case-sensitive and segment-aware", () => {
    expect(matchesPortablePath("/srv/agents/one", "/srv/agents")).toBe(true);
    expect(matchesPortablePath("/srv/Agents/one", "/srv/agents")).toBe(false);
    expect(matchesPortablePath("/srv/agents-old", "/srv/agents")).toBe(false);
  });

  it("detects traversal with either separator", () => {
    expect(hasParentTraversal("a/../b")).toBe(true);
    expect(hasParentTraversal("a\\..\\b")).toBe(true);
  });

  it("contains untrusted workspace paths", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-path-"));
    try {
      expect(resolveInside(root, "nested/file.txt")).toBe(join(root, "nested", "file.txt"));
      expect(resolveInside(root, "../outside.txt")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
