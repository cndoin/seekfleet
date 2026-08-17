import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEntry, getEntry, listEntries, removeEntry } from "../src/registry.js";

describe("cluster registry", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dsh-reg-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("adds, replaces, and removes entries without leaving a lock", () => {
    const base = { clusterId: "one", createdAt: 1, spec: { instances: [{ label: "a" }] } };
    addEntry(home, base);
    addEntry(home, { ...base, createdAt: 2 });
    expect(listEntries(home)).toHaveLength(1);
    expect(getEntry(home, "one")?.createdAt).toBe(2);
    expect(existsSync(join(home, "clusters.json.lock"))).toBe(false);
    removeEntry(home, "one");
    expect(getEntry(home, "one")).toBeNull();
  });
});
