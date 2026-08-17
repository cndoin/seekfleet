// policy-enforcer.ts - turns a Policy into an actual gate that runs before
// every DSH execution.
//
// Wire it into DshClient (run/stream), DshCluster (route/stream), SeekFleet
// (run/clusterRoute), MCP (every tool), CLI (run/cluster route).
//
// At execution time, enforcer.assert(task, context) either throws a
// PolicyError or returns the validated (sanitized) task ready to run.
//
// Policies can be persisted to $DSH_HOME/policy.json and loaded at startup.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validate, type Policy, type ValidationResult, type ValidationContext } from "./policy.js";
import type { DshTask } from "./types.js";
import { writeFileAtomicSync } from "./atomic-file.js";

export class PolicyError extends Error {
  override readonly name = "PolicyError";
  /** Required-approval tool names, if any. Empty when validation failed for other reasons. */
  readonly pendingApprovals: string[];
  /** All validation errors (empty if pendingApprovals is non-empty). */
  readonly errors: string[];
  constructor(result: ValidationResult) {
    super(result.errors[0] ?? "policy requires approval for " + result.pendingApprovals.join(","));
    this.errors = [...result.errors];
    this.pendingApprovals = [...result.pendingApprovals];
  }
}

/** Context for one execution - what tools are expected, what env the task uses, etc. */
export interface ExecutionContext {
  /** Estimated cost in USD (used to enforce maxCostUsd). */
  estimatedCostUsd?: number;
  /** Estimated runtime in ms (used to enforce maxRuntimeMs). */
  estimatedRuntimeMs?: number;
  /** Tool names the task is expected to use (enforced against allowedTools / requireApprovalFor). */
  tools?: string[];
  /** True if the task may need network access (enforced against disableNetwork). */
  hasNetworkAccess?: boolean;
}

export interface PolicyEnforcerOptions {
  /** The policy to enforce. */
  policy: Policy;
}

/**
 * Wraps a Policy and exposes assert(task, ctx) which throws PolicyError on
 * violation. On success returns a sanitized DshTask (with patches filtered,
 * env vars stripped, profile adjusted) ready to pass to a DshClient.
 */
export class PolicyEnforcer {
  readonly policy: Policy;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  /**
   * Validate the task + execution context. On success returns the sanitized
   * task; on failure throws PolicyError.
   */
  assert(task: DshTask, ctx: ExecutionContext = {}): DshTask {
    const vctx: ValidationContext = {
      cwd: task.cwd,
      patches: task.patches,
      profile: task.profile,
      env: task.env,
      tools: ctx.tools,
      estimatedCostUsd: ctx.estimatedCostUsd,
      estimatedRuntimeMs: ctx.estimatedRuntimeMs,
      hasNetworkAccess: ctx.hasNetworkAccess,
    };
    const r = validate(this.policy, vctx);
    if (!r.ok) throw new PolicyError(r);
    return {
      ...task,
      cwd: r.resolvedCwd || task.cwd,
      patches: r.resolvedPatches.length > 0 ? r.resolvedPatches : task.patches,
      profile: r.resolvedProfile ?? task.profile,
      env: Object.keys(r.sanitizedEnv).length > 0 ? r.sanitizedEnv : task.env,
    };
  }

  /** Return the validation result without throwing. */
  check(task: DshTask, ctx: ExecutionContext = {}): ValidationResult {
    return validate(this.policy, {
      cwd: task.cwd,
      patches: task.patches,
      profile: task.profile,
      env: task.env,
      tools: ctx.tools,
      estimatedCostUsd: ctx.estimatedCostUsd,
      estimatedRuntimeMs: ctx.estimatedRuntimeMs,
      hasNetworkAccess: ctx.hasNetworkAccess,
    });
  }
}

/**
 * Persist a policy to $DSH_HOME/policy.json. Atomic write.
 */
export function savePolicy(dshHome: string, policy: Policy): void {
  const path = join(dshHome, "policy.json");
  writeFileAtomicSync(path, JSON.stringify(policy, null, 2));
}

/**
 * Load a policy from $DSH_HOME/policy.json. Returns null if no policy is set.
 * Throws on parse error.
 */
export function loadPolicy(dshHome: string): Policy | null {
  const path = join(dshHome, "policy.json");
  if (!existsSync(path)) return null;
  const txt = readFileSync(path, "utf8");
  const parsed = JSON.parse(txt) as Policy;
  return parsed;
}
