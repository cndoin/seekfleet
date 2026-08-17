// capability-registry.ts - instances self-report their capabilities.
//
// Each instance publishes what dsh tools / model / version it exposes. The
// registry is shared via $DSH_HOME/capabilities/<label>.json. The cluster
// can then route tasks based on capability matches ("needs filesystem tools").

import { existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomic-file.js";

export interface InstanceCapability {
  label: string;
  profile: string;
  dshVersion: string;
  dshModuleRoot: string;
  /** builtin dsh tools this instance has */
  tools: string[];
  /** model (if known) */
  model?: string;
  /** semantic tags (e.g., 'research', 'code', 'web-search') */
  tags: string[];
  /** max concurrency */
  concurrency: number;
  reportedAt: number;
  ttlMs: number;
}

export interface CapabilityQuery {
  /** task must need at least one of these tools */
  requireTools?: string[];
  /** task must match one of these tags */
  requireTags?: string[];
  /** task prefers one of these profiles */
  preferProfiles?: string[];
}

export interface MatchResult {
  capability: InstanceCapability;
  score: number;
  matched: { tools: string[]; tags: string[]; profile: boolean };
}

export class CapabilityRegistry {
  constructor(private readonly dshHome: string) {
    mkdirSync(this.dir(), { recursive: true });
  }

  private dir(): string {
    return join(this.dshHome, "capabilities");
  }

  private pathFor(label: string): string {
    const key = createHash("sha256").update(label).digest("hex");
    return join(this.dir(), key + ".json");
  }

  publish(cap: Omit<InstanceCapability, "reportedAt">): void {
    const full: InstanceCapability = { ...cap, reportedAt: Date.now() };
    writeFileAtomicSync(this.pathFor(cap.label), JSON.stringify(full, null, 2));
  }

  unpublish(label: string): void {
    try {
      unlinkSync(this.pathFor(label));
    } catch {
      /* swallow */
    }
  }

  list(): InstanceCapability[] {
    const out: InstanceCapability[] = [];
    if (!existsSync(this.dir())) return out;
    const now = Date.now();
    for (const entry of readdirSync(this.dir())) {
      if (!entry.endsWith(".json")) continue;
      try {
        const cap = JSON.parse(readFileSync(join(this.dir(), entry), "utf8")) as InstanceCapability;
        if (now - cap.reportedAt <= cap.ttlMs) out.push(cap);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  get(label: string): InstanceCapability | null {
    const path = this.pathFor(label);
    if (!existsSync(path)) return null;
    try {
      const cap = JSON.parse(readFileSync(path, "utf8")) as InstanceCapability;
      if (Date.now() - cap.reportedAt > cap.ttlMs) return null;
      return cap;
    } catch {
      return null;
    }
  }

  /** Find instances matching a query, sorted by score (best first). */
  match(query: CapabilityQuery): MatchResult[] {
    const all = this.list();
    const results: MatchResult[] = [];
    for (const cap of all) {
      const matchedTools = (query.requireTools ?? []).filter((t) => cap.tools.includes(t));
      const requiredToolsMet = (query.requireTools ?? []).every((t) => cap.tools.includes(t));
      if ((query.requireTools?.length ?? 0) > 0 && !requiredToolsMet) continue;
      const matchedTags = (query.requireTags ?? []).filter((t) => cap.tags.includes(t));
      const requiredTagsMet =
        (query.requireTags?.length ?? 0) === 0 || (query.requireTags ?? []).some((t) => cap.tags.includes(t));
      if ((query.requireTags?.length ?? 0) > 0 && !requiredTagsMet) continue;
      const profileMatched =
        (query.preferProfiles?.length ?? 0) === 0 || (query.preferProfiles ?? []).includes(cap.profile);
      let score = 0;
      if ((query.requireTools?.length ?? 0) > 0) score += matchedTools.length / (query.requireTools?.length ?? 1);
      if ((query.requireTags?.length ?? 0) > 0) score += matchedTags.length / (query.requireTags?.length ?? 1);
      if (profileMatched) score += 0.3;
      const ageMs = Date.now() - cap.reportedAt;
      score += Math.max(0, 0.2 - (ageMs / cap.ttlMs) * 0.2);
      results.push({
        capability: cap,
        score,
        matched: { tools: matchedTools, tags: matchedTags, profile: profileMatched },
      });
    }
    return results.sort((a, b) => b.score - a.score);
  }
}
