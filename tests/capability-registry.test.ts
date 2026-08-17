import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "../src/capability-registry.js";

describe("CapabilityRegistry", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dsh-cap-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("stores arbitrary labels in a contained hashed filename", () => {
    const registry = new CapabilityRegistry(home);
    const label = "../../outside:agent";
    registry.publish({
      label,
      profile: "headless",
      dshVersion: "test",
      dshModuleRoot: home,
      tools: [],
      tags: [],
      concurrency: 1,
      ttlMs: 60_000,
    });
    expect(registry.get(label)?.label).toBe(label);
    const files = readdirSync(join(home, "capabilities"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });
});
