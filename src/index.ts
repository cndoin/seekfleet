// index.ts - the single public entry point.
// hermes / openclaw / any AI agent framework:
//   import { SeekFleet } from 'seekfleet';
//
// Submodules are also re-exported so power users can import what they need.

export { DshClient, DshServerHandle, type DshClientOptions } from "./dsh-client.js";
export { DshCluster, type DshClusterOptions } from "./dsh-cluster.js";
export { SeekFleet, DshPlugin, type SeekFleetOptions, type DshPluginOptions } from "./harness-sdk.js";
export { inspect, readDshManifest, SDK_CAPABILITIES } from "./discovery.js";
export { dumpProfileConfig, profilePluginAction } from "./profiles.js";
export { resolveDsh, resolveDshModuleRoot, resolveDshVersion, ensureDshHome, type ResolvedDsh } from "./install.js";
export { packageVersion } from "./version.js";
export { serveMcp, main as serveMcpMain, MCP_TOOL_NAMES, CHARACTER_LIMIT, type ServeMcpOptions } from "./mcp-server.js";
export {
  startDashboardServer,
  type DashboardServerOptions,
  type DashboardServerHandle,
  type DashboardSnapshot,
} from "./dashboard-server.js";
export { ROUTING_FNS } from "./routing.js";
export { EventParser, createEventTransform, classifyLine } from "./event-parser.js";
export {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError,
  type BreakerOptions,
  type BreakerStats,
} from "./circuit-breaker.js";
export { ResultCache, type CacheOptions, type CacheStats, type CacheEntry } from "./result-cache.js";
export { CostTracker, DEFAULT_PRICING, type ModelPricing, type UsageRecord, type CostSummary } from "./cost-tracker.js";
export { AdaptiveRouter, DEFAULT_WEIGHTS, type AdaptiveWeights, type InstanceMetrics } from "./adaptive-router.js";
export { AutoScaler, type AutoScalerSpec, type ScalingEvent } from "./auto-scaler.js";
export {
  WorkspaceSync,
  type SyncOptions,
  type SyncStats,
  type ChangeRecord,
  type ChangeKind,
} from "./workspace-sync.js";
export {
  CapabilityRegistry,
  type InstanceCapability,
  type CapabilityQuery,
  type MatchResult,
} from "./capability-registry.js";
export { MetricsRegistry, type MetricKind, type MetricSeries } from "./metrics.js";
export {
  DagExecutor,
  type DagNode,
  type DagSpec,
  type DagNodeResult,
  type DagResult,
  type NodeRunner,
} from "./task-dag.js";
// —— 组织层（多 agent 质量的三个环节：契约 / 验证 / 归因）——
export {
  DEPARTMENTS,
  getDepartment,
  compileRoleContract,
  attachRoleContract,
  hasRoleContract,
  validateRoleSpec,
  auditRoleRun,
  type RoleSpec,
  type RoleAudit,
  type RoleViolation,
} from "./role-spec.js";
export {
  verifyResult,
  defaultVerifyRules,
  type VerifyRule,
  type VerifyRuleKind,
  type VerifyCheck,
  type VerifyReport,
  type VerifyContext,
} from "./verifier.js";
export { checkSchema, extractJson, type JsonSchema, type JsonValue, type SchemaCheckResult } from "./json-schema.js";
export {
  MAST_MODES,
  MAST_BASELINE,
  getMode,
  classifyTrace,
  aggregateFailures,
  formatAttribution,
  type MastCategory,
  type MastCode,
  type MastMode,
  type MastReport,
  type MastReportRow,
  type TraceView,
  type FailureSignal,
  type FailureAttribution,
} from "./mast.js";
export {
  MAX_REPAIR_ATTEMPTS_HARD_CAP,
  DEFAULT_REPAIR_POLICY,
  RepairLoop,
  buildRepairTask,
  clipAnswer,
  failureFingerprint,
  isRepairableFailure,
  normalizeRepairPolicy,
  observeResult,
  summarizeRepair,
  type RepairAttemptRecord,
  type RepairMode,
  type RepairObservation,
  type RepairOutcome,
  type RepairPolicy,
  type RepairPolicyInput,
  type RepairStopReason,
  type RepairVerdict,
} from "./repair.js";
export { ReplayRecorder, type ReplayFile, type ReplayHeader } from "./replay-recorder.js";
export {
  codexInstall,
  codexUninstall,
  codexStatus,
  type CodexInstallOptions,
  type CodexInstallResult,
} from "./codex-config.js";
export { validate as validatePolicy, type Policy, type ValidationContext, type ValidationResult } from "./policy.js";
export {
  PolicyEnforcer,
  PolicyError,
  savePolicy,
  loadPolicy,
  type PolicyEnforcerOptions,
  type ExecutionContext,
} from "./policy-enforcer.js";
export {
  SessionStore,
  MAX_EVENTS_PER_SESSION,
  type SessionRecord,
  type SessionStatus,
  type SessionCheckpoint,
  type SessionStoreOptions,
} from "./session.js";
export { SessionManager, type SessionManagerOptions, type StartOptions } from "./session-manager.js";
export {
  installSeekFleetSkill,
  type SkillInstallOptions,
  type SkillInstallResult,
  type SkillInstallScope,
  type SkillInstallTarget,
} from "./skill-installer.js";

export type {
  DshEvent,
  DshEventKind,
  DshToolInvocation,
  DshToolResult,
  DshUsage,
  DshResult,
  DshTask,
  DshTaskAudit,
  DshInstanceSpec,
  DshInstanceStatus,
  DshInstanceState,
  DshRoutingStrategy,
  DshClusterSpec,
  DshClusterStatus,
  DshCapability,
  DshInspection,
  DshEnvelope,
  DagNodeSpec,
} from "./types.js";
