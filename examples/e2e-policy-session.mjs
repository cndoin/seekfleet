// E2E: write a strict policy, run a task, see it fail; then run a session, see it gate.
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savePolicy, PolicyEnforcer } from "../dist/src/policy-enforcer.js";
import { SessionManager } from "../dist/src/session-manager.js";
import { resolveDsh } from "../dist/src/install.js";

const dir = mkdtempSync(join(tmpdir(), "dsh-e2e-"));
const home = join(dir, "home");
writeFileSync(join(dir, "home"), "");
rmSync(join(dir, "home"));

const { dshHome } = resolveDsh({ dshHome: home });

console.log("[1] Saving a strict policy");
savePolicy(dshHome, {
  name: "strict",
  allowedPaths: ["C:\\\\allowed"],
  allowedProfiles: ["headless"],
  allowedTools: ["fs_read"],
  requireApprovalFor: ["bash"],
  maxCostUsd: 0.5,
});

const { loadPolicy } = await import("../dist/src/policy-enforcer.js");
const loaded = loadPolicy(dshHome);
console.log("    loaded:", loaded?.name, "allowedProfiles:", loaded?.allowedProfiles);

console.log("\n[2] SessionManager enforces policy at start()");
const sm = new SessionManager({
  dshHome,
  policy: new PolicyEnforcer(loadPolicy(dshHome)),
  runner: async (task) => ({ answer: "OK: " + task.task, toolCalls: [], toolResults: [], events: 0, durationMs: 0, exitCode: 0, stderrTail: "" }),
});

const r = sm.create({ task: "hi" });
console.log("    created session:", r.runId.slice(0, 8), "status:", r.status);

console.log("\n[3] Trying to start a session with a forbidden tool (bash)");
try {
  await sm.start(r.runId, { ctx: { tools: ["bash"] } });
  console.log("    UNEXPECTED: should have thrown");
} catch (e) {
  console.log("    blocked:", e.name, "- pendingApprovals:", e.pendingApprovals ?? []);
}

console.log("\n[4] Starting a clean session (no forbidden tools)");
await sm.start(r.runId);
await new Promise((r) => setTimeout(r, 200));
const status = sm.status(r.runId);
console.log("    status after start:", status?.status);
console.log("    result:", status?.result?.answer);

console.log("\n[5] Event log");
const evs = sm.events(r.runId);
console.log("    events:", evs.events.length, "lastSeq:", evs.lastSeq);

console.log("\n[6] Rehydrate semantics: mark running, construct new manager, expect paused");
const { SessionStore } = await import("../dist/src/session.js");
const fake = new SessionStore(dshHome);
const fr = fake.create({ task: "fake-running" });
fake.setStatus(fr.runId, "running");

const fresh = new SessionManager({ dshHome });
const after = fresh.status(fr.runId);
console.log("    after rehydrate, status:", after?.status, "(expected: paused)");

console.log("\n[7] Stats");
console.log("    ", JSON.stringify(sm.stats()));

rmSync(dir, { recursive: true, force: true });
console.log("\n[OK] e2e complete");
