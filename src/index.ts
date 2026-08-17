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
export { resolveDsh, resolveDshModuleRoot, ensureDshHome, type ResolvedDsh } from "./install.js";
export { serveMcp, main as serveMcpMain, type ServeMcpOptions } from "./mcp-server.js";
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
  DshInstanceSpec,
  DshInstanceStatus,
  DshInstanceState,
  DshRoutingStrategy,
  DshClusterSpec,
  DshClusterStatus,
  DshCapability,
  DshInspection,
  DshEnvelope,
} from "./types.js";
