import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSync } from "../src/workspace-sync.js";

describe("WorkspaceSync path containment", () => {
  let root: string;
  let home: string;
  let workspace: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dsh-sync-"));
    home = join(root, "home");
    workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("does not record files outside the workspace", () => {
    const sync = new WorkspaceSync({ dshHome: home, workspace, instanceLabel: "local" });
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "keep");
    expect(sync.recordChange("change", outside)).toBeNull();
  });

  it("does not apply traversal records from the shared log", () => {
    const sync = new WorkspaceSync({ dshHome: home, workspace, instanceLabel: "local" });
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "keep");
    const log = join(home, "workspace-logs", "changes.jsonl");
    writeFileSync(
      log,
      JSON.stringify({
        ts: Date.now(),
        instanceLabel: "remote",
        kind: "unlink",
        relPath: "../outside.txt",
      }) + "\n",
    );
    sync.syncOnce();
    expect(existsSync(outside)).toBe(true);
    expect(sync.stats().ignored).toBe(1);
  });
});
