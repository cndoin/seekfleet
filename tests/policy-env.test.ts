// Regression coverage for the environment-variable policy gate.
//
// PolicyEnforcer.assert() used to treat an empty sanitizedEnv as "the policy
// did not apply" and fall back to the caller's original env. When a policy
// stripped every variable (or the caller simply sent no allowed ones), the
// unsanitized map was resurrected — a silent policy bypass that could leak
// credentials into the spawned agent.

import { describe, expect, it } from "vitest";
import { PolicyEnforcer } from "../src/policy-enforcer.js";
import { validate, type Policy } from "../src/policy.js";

describe("policy env sanitization", () => {
  it("keeps allowed variables and drops the rest", () => {
    const policy: Policy = { name: "t", allowedEnvVars: ["MY_VAR"] };
    const r = validate(policy, { env: { MY_VAR: "ok", OTHER: "no" } });
    expect(r.sanitizedEnv.MY_VAR).toBe("ok");
    expect(r.sanitizedEnv.OTHER).toBeUndefined();
    expect(r.envSanitized).toBe(true);
  });

  it("strips secrets even with no allow list configured", () => {
    const r = validate({ name: "t" }, { env: { API_KEY: "sk-secret", NORMAL: "ok" } });
    expect(r.sanitizedEnv.API_KEY).toBeUndefined();
    expect(r.sanitizedEnv.NORMAL).toBe("ok");
  });

  it("does not resurrect a fully stripped env", () => {
    const enforcer = new PolicyEnforcer({ name: "t", allowedEnvVars: ["ALLOWED"] });
    const task = enforcer.assert({ task: "x", env: { DISALLOWED: "leak" } });
    expect(task.env).toEqual({});
  });

  it("does not resurrect secrets when only secret vars were supplied", () => {
    const enforcer = new PolicyEnforcer({ name: "t" });
    const task = enforcer.assert({ task: "x", env: { API_KEY: "sk-secret" } });
    expect(task.env).toEqual({});
  });

  it("leaves the task env untouched when the caller supplied none", () => {
    const enforcer = new PolicyEnforcer({ name: "t", allowedEnvVars: ["ALLOWED"] });
    const task = enforcer.assert({ task: "x" });
    expect(task.env).toBeUndefined();
  });

  it("marks envSanitized only when env was supplied", () => {
    expect(validate({ name: "t" }, {}).envSanitized).toBe(false);
    expect(validate({ name: "t" }, { env: {} }).envSanitized).toBe(true);
  });
});
