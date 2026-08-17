// policy.ts - Security policy engine for DSH tasks and instances.
//
// This module turns the threat-model promises in SECURITY.md into actual code
// checks. A Policy is a list of allow/deny rules; a request is a (task,
// instance) snapshot we validate against it.
//
// Policies are JSON-serializable so they can be loaded from a config file.

import { hasParentTraversal, matchesPortablePath, resolvePortablePath } from "./platform-path.js";

export interface Policy {
  name: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  allowedProfiles?: string[];
  allowedTools?: string[];
  allowedEnvVars?: string[];
  allowedPatchPatterns?: string[];
  maxCostUsd?: number;
  maxRuntimeMs?: number;
  requireApprovalFor?: string[];
  disableNetwork?: boolean;
}

export interface ValidationContext {
  cwd?: string;
  patches?: string[];
  profile?: string;
  env?: Record<string, string>;
  tools?: string[];
  estimatedCostUsd?: number;
  estimatedRuntimeMs?: number;
  hasNetworkAccess?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  pendingApprovals: string[];
  sanitizedEnv: Record<string, string>;
  resolvedCwd: string;
  resolvedPatches: string[];
  resolvedProfile: string | undefined;
}

export function validate(policy: Policy, ctx: ValidationContext): ValidationResult {
  const errors: string[] = [];
  const pendingApprovals: string[] = [];
  const resolvedCwd = ctx.cwd ? resolvePortablePath(ctx.cwd) : "";
  const resolvedPatches: string[] = [];
  let resolvedProfile: string | undefined = ctx.profile;
  const sanitizedEnv: Record<string, string> = {};

  if (ctx.cwd) {
    if (hasParentTraversal(ctx.cwd)) {
      errors.push("cwd contains parent-directory traversal: " + ctx.cwd);
    } else if (policy.deniedPaths?.some((p) => matchesPortablePath(resolvedCwd, p))) {
      errors.push("cwd is in deniedPaths: " + ctx.cwd);
    } else if (policy.allowedPaths && policy.allowedPaths.length > 0) {
      if (!policy.allowedPaths.some((p) => matchesPortablePath(resolvedCwd, p))) {
        errors.push("cwd not in allowedPaths: " + ctx.cwd);
      }
    }
  }

  if (ctx.patches) {
    for (const p of ctx.patches) {
      if (hasParentTraversal(p)) {
        errors.push("patch contains parent-directory traversal: " + p);
        continue;
      }
      if (policy.allowedPatchPatterns && policy.allowedPatchPatterns.length > 0) {
        if (!policy.allowedPatchPatterns.some((pat) => matchesPortablePath(p, pat))) {
          errors.push("patch not in allowedPatchPatterns: " + p);
          continue;
        }
      }
      resolvedPatches.push(p);
    }
  }

  if (ctx.profile && policy.allowedProfiles && policy.allowedProfiles.length > 0) {
    if (!policy.allowedProfiles.includes(ctx.profile)) {
      errors.push("profile not allowed: " + ctx.profile);
      resolvedProfile = undefined;
    }
  }

  if (ctx.env) {
    const env = ctx.env;
    if (policy.allowedEnvVars && policy.allowedEnvVars.length > 0) {
      for (const k of Object.keys(env)) {
        if (policy.allowedEnvVars.includes(k)) {
          sanitizedEnv[k] = env[k]!;
        } else if (isSecretEnvVar(k)) {
          continue;
        }
      }
    } else {
      for (const k of Object.keys(env)) {
        if (!isSecretEnvVar(k)) sanitizedEnv[k] = env[k]!;
      }
    }
  }

  if (ctx.tools && policy.allowedTools && policy.allowedTools.length > 0) {
    for (const t of ctx.tools) {
      if (!policy.allowedTools.includes(t)) {
        errors.push("tool not in allowedTools: " + t);
      }
    }
  }
  if (ctx.tools && policy.requireApprovalFor && policy.requireApprovalFor.length > 0) {
    for (const t of ctx.tools) {
      if (policy.requireApprovalFor.includes(t)) pendingApprovals.push(t);
    }
  }

  if (policy.maxCostUsd !== undefined && ctx.estimatedCostUsd !== undefined) {
    if (ctx.estimatedCostUsd > policy.maxCostUsd) {
      errors.push("estimated cost exceeds maxCostUsd");
    }
  }

  if (policy.maxRuntimeMs !== undefined && ctx.estimatedRuntimeMs !== undefined) {
    if (ctx.estimatedRuntimeMs > policy.maxRuntimeMs) {
      errors.push("estimated runtime exceeds maxRuntimeMs");
    }
  }

  if (policy.disableNetwork && ctx.hasNetworkAccess) {
    errors.push("network access disabled by policy");
  }

  return {
    ok: errors.length === 0 && pendingApprovals.length === 0,
    errors,
    pendingApprovals,
    sanitizedEnv,
    resolvedCwd,
    resolvedPatches,
    resolvedProfile,
  };
}

const SECRET_ENV_HINTS = ["KEY", "SECRET", "TOKEN", "PASSWORD", "PASS", "CREDENTIAL", "AUTH"];

function isSecretEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_ENV_HINTS.some((s) => upper.includes(s));
}
