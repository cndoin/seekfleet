import { describe, it, expect } from "vitest";
import { validate, type Policy } from "../src/policy.js";

const basePolicy: Policy = {
  name: "test",
  allowedPaths: ["H:\\\\workspace\\\\"],
  allowedProfiles: ["headless"],
  allowedTools: ["fs_read", "web_search"],
  allowedEnvVars: ["MY_VAR"],
  maxCostUsd: 1.0,
  maxRuntimeMs: 60000,
};

describe("Policy.validate", () => {
  it("passes a valid request", () => {
    const r = validate(basePolicy, {
      cwd: "H:\\\\workspace\\\\project",
      profile: "headless",
      tools: ["fs_read"],
      env: { MY_VAR: "ok", OTHER: "x" },
      estimatedCostUsd: 0.01,
      estimatedRuntimeMs: 1000,
    });
    expect(r.ok).toBe(true);
    expect(r.sanitizedEnv.MY_VAR).toBe("ok");
    expect(r.sanitizedEnv.OTHER).toBeUndefined();
  });

  it("rejects cwd outside allowedPaths", () => {
    const r = validate(basePolicy, { cwd: "C:\\\\Windows" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("allowedPaths");
  });

  it("rejects parent-directory traversal", () => {
    const r = validate(basePolicy, { cwd: "H:\\\\workspace\\\\../etc" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("parent-directory");
  });

  it("strips secret env vars when not in allowedEnvVars", () => {
    // basePolicy.allowedEnvVars = ["MY_VAR"]; API_KEY is secret + not allowed
    const r = validate(basePolicy, { env: { API_KEY: "secret", MY_VAR: "ok" } });
    expect(r.sanitizedEnv.API_KEY).toBeUndefined();
    expect(r.sanitizedEnv.MY_VAR).toBe("ok");
  });

  it("strips secret env vars even with empty allowlist", () => {
    const policy: Policy = { name: "open" };
    const r = validate(policy, { env: { API_KEY: "secret", NORMAL: "ok" } });
    expect(r.sanitizedEnv.API_KEY).toBeUndefined();
    expect(r.sanitizedEnv.NORMAL).toBe("ok");
  });

  it("flags tools requiring approval", () => {
    const policy: Policy = { ...basePolicy, requireApprovalFor: ["bash"] };
    const r = validate(policy, { tools: ["bash"] });
    expect(r.ok).toBe(false);
    expect(r.pendingApprovals).toContain("bash");
  });

  it("rejects over-budget requests", () => {
    const r = validate(basePolicy, { estimatedCostUsd: 5 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("maxCostUsd");
  });
});
