// registry.ts - persist cluster specs across CLI invocations.
// Storage: $DSH_HOME/clusters.json  (atomic write via temp + rename).

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DshClusterSpec } from "./types.js";
import { withFileLockSync, writeFileAtomicSync } from "./atomic-file.js";

export interface RegistryEntry {
  clusterId: string;
  spec: DshClusterSpec;
  createdAt: number;
}

interface Registry {
  entries: RegistryEntry[];
}

function registryPath(dshHome: string): string {
  return join(dshHome, "clusters.json");
}

function ensureHome(dshHome: string): void {
  mkdirSync(dshHome, { recursive: true });
}

function readRegistry(dshHome: string): Registry {
  try {
    const raw = readFileSync(registryPath(dshHome), "utf8");
    const obj = JSON.parse(raw) as Registry;
    if (Array.isArray(obj.entries)) return obj;
    return { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function writeRegistry(dshHome: string, reg: Registry): void {
  ensureHome(dshHome);
  writeFileAtomicSync(registryPath(dshHome), JSON.stringify(reg, null, 2));
}

export function addEntry(dshHome: string, entry: RegistryEntry): void {
  ensureHome(dshHome);
  withFileLockSync(registryPath(dshHome) + ".lock", () => {
    const reg = readRegistry(dshHome);
    reg.entries = reg.entries.filter((e) => e.clusterId !== entry.clusterId);
    reg.entries.push(entry);
    writeRegistry(dshHome, reg);
  });
}

export function removeEntry(dshHome: string, clusterId: string): void {
  ensureHome(dshHome);
  withFileLockSync(registryPath(dshHome) + ".lock", () => {
    const reg = readRegistry(dshHome);
    reg.entries = reg.entries.filter((e) => e.clusterId !== clusterId);
    writeRegistry(dshHome, reg);
  });
}

export function getEntry(dshHome: string, clusterId: string): RegistryEntry | null {
  const reg = readRegistry(dshHome);
  return reg.entries.find((e) => e.clusterId === clusterId) ?? null;
}

export function listEntries(dshHome: string): RegistryEntry[] {
  return readRegistry(dshHome).entries;
}
