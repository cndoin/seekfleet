import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEnforcer, savePolicy, loadPolicy, PolicyError } from "../src/policy-enforcer.js";
import type { Policy } from "../src/policy.js";

const policy: Policy = {
  name: "test",
  allowedPaths: ["/workspace"],
  allowedProfiles: ["headless"],
  allowedTools: ["fs_read"],
  maxCostUsd: 1.0,
  requireApprovalFor: ["bash"],
};

describe("PolicyEnforcer", () => {
  it("throws on policy violation", () => {
    const e = new PolicyEnforcer(policy);
    expect(() => e.assert({ task: "x", cwd: "/etc" })).toThrow(PolicyError);
  });

  it("returns sanitized task on success", () => {
    const e = new PolicyEnforcer(policy);
    const t = e.assert({
      task: "x",
      cwd: "/workspace/proj",
      profile: "headless",
      env: { OK_VAR: "ok" },
    });
    expect(t.cwd).toBe("/workspace/proj");
    expect(t.profile).toBe("headless");
  });

  it("pendingApprovals surfaces on requireApprovalFor", () => {
    const localPolicy: Policy = { ...policy, allowedTools: ["bash", "fs_read"], requireApprovalFor: ["bash"] };
    const e = new PolicyEnforcer(localPolicy);
    try {
      e.assert({ task: "x" }, { tools: ["bash"] });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const pe = err as PolicyError;
      expect(pe).toBeInstanceOf(PolicyError);
      expect(pe.pendingApprovals).toContain("bash");
    }
  });

  it("check() returns result without throwing", () => {
    const e = new PolicyEnforcer(policy);
    const v = e.check({ task: "x", cwd: "/etc" });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it("estimateCostUsd is enforced", () => {
    const e = new PolicyEnforcer(policy);
    expect(() => e.assert({ task: "x" }, { estimatedCostUsd: 5 })).toThrow(PolicyError);
  });
});

describe("savePolicy / loadPolicy", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-pol-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips a policy", () => {
    savePolicy(dir, policy);
    expect(existsSync(join(dir, "policy.json"))).toBe(true);
    const loaded = loadPolicy(dir);
    expect(loaded?.name).toBe("test");
    expect(loaded?.allowedPaths).toEqual(["/workspace"]);
  });

  it("loadPolicy returns null when absent", () => {
    expect(loadPolicy(dir)).toBeNull();
  });

  it("atomic write (no tmp files left behind)", () => {
    savePolicy(dir, policy);
    expect(existsSync(join(dir, "policy.json.tmp"))).toBe(false);
  });
});
