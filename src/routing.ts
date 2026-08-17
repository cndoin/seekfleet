// Routing strategies for the cluster layer.
//
// All strategies expose the same shape:
//   pick(ctx: { task, instances, now }) -> InstanceId | null
// They are stateless functions; the cluster layer holds the live counters.

import type { DshInstanceSpec, DshInstanceStatus, DshRoutingStrategy, DshTask } from "./types.js";

export interface RoutingContext {
  task: DshTask;
  instances: ReadonlyArray<DshInstanceStatus & { spec: DshInstanceSpec }>;
  now: number;
}

export type RoutingFn = (ctx: RoutingContext) => string | null;

export const ROUTING_FNS: Record<DshRoutingStrategy, RoutingFn> = {
  "round-robin": (ctx) => {
    // pick the ready instance with the smallest inFlight, deterministic by label.
    const ready = ctx.instances.filter((i) => i.state === "ready" || i.state === "busy");
    if (ready.length === 0) return null;
    let best = ready[0]!;
    for (const i of ready) if (i.inFlight < best.inFlight) best = i;
    return best.label;
  },

  "least-loaded": (ctx) => {
    const eligible = ctx.instances.filter((i) => {
      if (i.state !== "ready" && i.state !== "busy") return false;
      if (i.inFlight >= i.concurrency) return false;
      return true;
    });
    if (eligible.length === 0) return null;
    let best = eligible[0]!;
    for (const i of eligible) {
      const iLoad = i.inFlight / Math.max(i.concurrency, 1);
      const bLoad = best.inFlight / Math.max(best.concurrency, 1);
      if (iLoad < bLoad) best = i;
    }
    return best.label;
  },

  tag: (ctx) => {
    const tags = ctx.task.tags ?? [];
    if (tags.length === 0) {
      // fallback to least-loaded
      return ROUTING_FNS["least-loaded"](ctx);
    }
    const eligible = ctx.instances.filter((i) => {
      if (i.state !== "ready" && i.state !== "busy") return false;
      if (i.inFlight >= i.concurrency) return false;
      const tagsOfInst = i.tags ?? [];
      return tags.some((t) => tagsOfInst.includes(t));
    });
    if (eligible.length === 0) return null;
    let best = eligible[0]!;
    for (const i of eligible) {
      if (i.inFlight < best.inFlight) best = i;
    }
    return best.label;
  },

  random: (ctx) => {
    const eligible = ctx.instances.filter(
      (i) => (i.state === "ready" || i.state === "busy") && i.inFlight < i.concurrency,
    );
    if (eligible.length === 0) return null;
    return eligible[Math.floor(Math.random() * eligible.length)]!.label;
  },

  // "adaptive" is implemented in DshCluster via AdaptiveRouter scoring.
  // Here we just delegate to least-loaded as a fallback.
  adaptive: (ctx) => ROUTING_FNS["least-loaded"](ctx),
};

// "adaptive" delegates to least-loaded; the real adaptive logic lives in DshCluster via AdaptiveRouter.
