import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshCluster } from "../src/dsh-cluster.js";

let root: string;
let dshHome: string;
const clusters: DshCluster[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fake-cluster-dsh-"));
  dshHome = join(root, "home");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "test", type: "module" }),
  );
});
afterEach(async () => {
  for (const cluster of clusters.splice(0)) await cluster.shutdown();
  rmSync(root, { recursive: true, force: true });
});

function cluster(script: string, options: Partial<ConstructorParameters<typeof DshCluster>[0]> = {}): DshCluster {
  writeFileSync(join(root, "lib", "bin.js"), script);
  const value = new DshCluster({
    instances: [
      { label: "a", env: { INSTANCE_LABEL: "a" } },
      { label: "b", env: { INSTANCE_LABEL: "b" } },
    ],
    routing: "round-robin",
    client: { dshModuleRoot: root, dshHome },
    ...options,
  });
  clusters.push(value);
  return value;
}

describe("DshCluster integration", () => {
  it("uses configured round-robin routing and instance environment", async () => {
    const value = cluster("console.log(JSON.stringify({type:'answer',answer:process.env.INSTANCE_LABEL}));");
    const first = await value.route("one");
    const second = await value.route("two");
    expect([first.instance, second.instance]).toEqual(["a", "b"]);
    expect([first.answer, second.answer]).toEqual(["a", "b"]);
  });

  it("does not leak capacity when a budget reservation is rejected", async () => {
    const value = cluster("console.log('unused');", { costBudgetUsd: 0 });
    await expect(value.route("too expensive")).rejects.toThrow(/budget/);
    expect(value.status().instances.every((instance) => instance.inFlight === 0)).toBe(true);
  });

  it("records a soft process failure exactly once in the breaker", async () => {
    const value = cluster("process.exitCode=2;", {
      instances: [{ label: "a" }],
      routing: "adaptive",
    });
    const result = await value.route("fail");
    expect(result.exitCode).toBe(2);
    const breaker = value.router.get("a")?.breaker;
    expect(breaker?.fires).toBe(1);
    expect(breaker?.failures).toBe(1);
    expect(breaker?.successes).toBe(0);
  });
});
