// cluster-governance.test.ts — 集群组织层的端到端行为。
//
// 用假的 bin.js 顶替真实 dsh，跑的是真实的 DshCluster.route()：
// 缓存、断路器、预算、路由全都在线。这里验证的是一条因果关系链 ——
//   契约违约 => result.error => 不算成功 => 不进缓存 => 进归因报告
// 只要中间任何一环断开（比如违规被降级成警告），第一个用例就会红。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshCluster } from "../src/dsh-cluster.js";
import type { RoleSpec } from "../src/role-spec.js";
import type { VerifyRule } from "../src/verifier.js";

let root: string;
let dshHome: string;
const clusters: DshCluster[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "governed-cluster-"));
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
    instances: [{ label: "a" }, { label: "b" }, { label: "c" }],
    routing: "round-robin",
    client: { dshModuleRoot: root, dshHome },
    cacheDir: join(root, "cache"),
    ...options,
  });
  clusters.push(value);
  return value;
}

/** 把收到的 argv 原样当成答案返回 —— 用来检查 prompt 到底长什么样。 */
const ECHO_ARGV = "console.log(JSON.stringify({type:'answer',answer:process.argv.slice(2).join(' ')}));";

/** 一个符合 worker 契约（status + summary）的合规输出。 */
const COMPLIANT_WORKER = `console.log(JSON.stringify({type:'answer',answer:JSON.stringify({status:'done',summary:'完成了'})}));`;

describe("role contract injection", () => {
  it("compiles the contract into the prompt before dispatch", async () => {
    const value = cluster(ECHO_ARGV);
    const result = await value.route({ task: "重构 parser", role: "worker" });
    expect(result.answer).toContain("<role-contract>");
    expect(result.answer).toContain("<name>worker</name>");
    expect(result.answer).toContain("<stop-when>");
  });

  it("does not inject the contract twice when the same task is re-dispatched", async () => {
    const value = cluster(ECHO_ARGV);
    const once = await value.route({ task: "做一件事", role: "worker" });
    // 契约注入发生在 cluster 内部，但 attachRoleContract 是幂等的；
    // 这里对齐外的入口也是幂等的，防止上层拼一次、下层再拼一次。
    const twice = value.prepareRole(value.prepareRole({ task: "做一件事", role: "worker" }).task).task;
    expect(once.answer.match(/<role-contract>/g)).toHaveLength(1);
    expect(twice.task.match(/<role-contract>/g)).toHaveLength(1);
  });

  it("refuses an unknown department instead of silently downgrading to a generic worker", async () => {
    const value = cluster(ECHO_ARGV);
    await expect(value.route({ task: "x", role: "wizard" })).rejects.toThrow(/unknown department/);
  });

  it("refuses a role that constrains nothing", async () => {
    const value = cluster(ECHO_ARGV);
    await expect(value.route({ task: "x", role: { name: "x", goal: "" } as RoleSpec })).rejects.toThrow(
      /invalid role spec/,
    );
  });

  it("accepts a fully specified custom role", async () => {
    const value = cluster(ECHO_ARGV);
    const result = await value.route({
      task: "x",
      role: { name: "auditor", goal: "查账", stopCondition: "查完就停", maxToolCalls: 3 },
    });
    expect(result.answer).toContain("<name>auditor</name>");
    expect(result.answer).toContain("<max-tool-calls>3</max-tool-calls>");
  });
});

describe("governance turns violations into failures", () => {
  it("marks a contract violation as an error rather than a soft warning", async () => {
    // 回答不符合 worker 的 output schema —— 即使进程退出码是 0。
    const value = cluster(ECHO_ARGV);
    const result = await value.route({ task: "做某事", role: "worker" });
    expect(result.exitCode).toBe(0);
    expect(result.error?.code).toBe("ROLE_CONTRACT_VIOLATION");
    expect(result.audit?.role?.ok).toBe(false);
    expect(result.audit?.role?.violations.length).toBeGreaterThan(0);
  });

  it("never caches a run that broke its contract", async () => {
    // 缓存投毒是最难查的一类 bug：第一次出错的答案会被后面每一次调用当成真值。
    const value = cluster(ECHO_ARGV);
    const first = await value.route({ task: "同一个任务", role: "worker" });
    expect(first.error?.code).toBe("ROLE_CONTRACT_VIOLATION");
    expect(first.cached).toBeFalsy();

    const second = await value.route({ task: "同一个任务", role: "worker" });
    expect(second.cached).toBeFalsy();
    expect(value.status().cache?.hits).toBe(0);
  });

  it("caches a run that honoured its contract", async () => {
    const value = cluster(COMPLIANT_WORKER);
    const first = await value.route({ task: "同一件事", role: "worker" });
    expect(first.error).toBeUndefined();
    expect(first.audit?.role?.ok).toBe(true);
    const second = await value.route({ task: "同一件事", role: "worker" });
    expect(second.cached).toBe(true);
  });

  it("fails the task when independent verification fails, even though the agent says it is done", async () => {
    // 输出完全合规，但我们要求 <*you>真的跑一条命令，那条命令会失败。
    const value = cluster(COMPLIANT_WORKER);
    const failing: VerifyRule[] = [
      { kind: "answer-match", pattern: "^这个答案里肯定没有的话$", name: "结论必须包含收尾句" },
    ];
    const result = await value.route({ task: "做事", role: "worker", verify: failing });
    expect(result.error?.code).toBe("VERIFY_FAILED");
    expect(result.audit?.verification?.ok).toBe(false);
    expect(result.audit?.verification?.checks[0]!.ok).toBe(false);
  });

  it("passes when verification passes", async () => {
    const value = cluster(COMPLIANT_WORKER);
    const rules: VerifyRule[] = [
      { kind: "answer-match", pattern: "status" },
      { kind: "answer-min-length", min: 5 },
    ];
    const result = await value.route({ task: "做事", role: "worker", verify: rules });
    expect(result.error).toBeUndefined();
    expect(result.audit?.verification?.ok).toBe(true);
  });

  it("treats an unknown verify rule as a failure, not as a skipped step", async () => {
    const value = cluster(COMPLIANT_WORKER);
    const bogus = [{ kind: "screenshot-match" }] as unknown as VerifyRule[];
    const result = await value.route({ task: "做事", role: "worker", verify: bogus });
    expect(result.error?.code).toBe("VERIFY_FAILED");
    expect(result.audit?.verification?.unknownKinds).toContain("screenshot-match");
  });

  it("reports both contract and verification failures together", async () => {
    const value = cluster(ECHO_ARGV);
    const result = await value.route({
      task: "做事",
      role: "worker",
      verify: [{ kind: "answer-match", pattern: "^zzz$" }],
    });
    // 契约违约 + 验证失败同时发生：错误码取验证失败，但两个线索都留在 audit 里。
    expect(result.error?.code).toBe("VERIFY_FAILED");
    expect(result.audit?.role?.ok).toBe(false);
    expect(result.audit?.verification?.ok).toBe(false);
  });
});

describe("thinking budget accounting", () => {
  it("records usage and flags an exceeded budget instead of silently blocking the run", async () => {
    const withUsage = `${COMPLIANT_WORKER}
console.log(JSON.stringify({type:'usage',usage:{inputTokens:10,outputTokens:20,totalTokens:30}}));`;
    const value = cluster(withUsage);
    const result = await value.route({ task: "做事", thinkingTokenBudget: 10 });
    expect(result.audit?.budget).toEqual({ thinkingTokens: 30, budget: 10, exceeded: true });
    // 超预算只记录不禁行：多花的钱有时是值得的，但你必须看得见它。
    expect(result.error).toBeUndefined();
  });

  it("does not flag a budget that was respected", async () => {
    const withUsage = `${COMPLIANT_WORKER}
console.log(JSON.stringify({type:'usage',usage:{inputTokens:10,outputTokens:20,totalTokens:30}}));`;
    const value = cluster(withUsage);
    const result = await value.route({ task: "做事", thinkingTokenBudget: 100 });
    expect(result.audit?.budget?.exceeded).toBe(false);
  });
});

describe("failure attribution roll-up", () => {
  it("attributes a schema violation to FM-1.1 in the cluster report", async () => {
    const value = cluster(ECHO_ARGV);
    await value.route({ task: "做事", role: "worker" });
    const report = value.attributionReport();
    expect(report.rows.some((r) => r.code === "FM-1.1")).toBe(true);
    expect(report.failedTraces).toBeGreaterThan(0);
  });

  it("exposes the roll-up through status() and omits it when there is no data", () => {
    const value = cluster(COMPLIANT_WORKER);
    // 没有样本时不能编一个 0% 出来 —— 0 和「没数据」不是一回事。
    expect(value.status().attribution).toBeUndefined();
  });

  it("shows up in status() once tasks have run", async () => {
    const value = cluster(ECHO_ARGV);
    await value.route({ task: "做事", role: "worker" });
    const attribution = value.status().attribution;
    expect(attribution).toBeDefined();
    expect(attribution!.totalTraces).toBe(1);
    expect(attribution!.failureRate).toBeGreaterThan(0);
    expect(attribution!.top.length).toBeGreaterThan(0);
    expect(attribution!.top[0]!.fix.length).toBeGreaterThan(0);
  });

  it("mixes failing and passing traces so the failure rate stays meaningful", async () => {
    const good = cluster(COMPLIANT_WORKER);
    await good.route({ task: "ok", role: "worker", verify: [{ kind: "answer-min-length", min: 2 }] });
    await good.route({ task: "ok2", role: "worker", verify: [{ kind: "answer-min-length", min: 2 }] });
    await good.route({ task: "bad", role: "worker", verify: [{ kind: "answer-min-length", min: 99999 }] });
    expect(good.attributionReport().totalTraces).toBe(3);
    expect(good.attributionReport().failedTraces).toBe(1);
  });
});

describe("effort scaling", () => {
  it("caps fan-out per effort level and never recommends more instances than exist", () => {
    const value = cluster(COMPLIANT_WORKER, { maxParallelSubtasks: 2, effortPolicy: { high: 8 } });
    expect(value.recommendFanout("low")).toBe(1);
    // 集群闸门是 2，即使 effort=high 想要 8 也只能给 2。
    expect(value.recommendFanout("high")).toBe(2);
  });

  it("clamps DAG parallelism to maxParallelSubtasks", async () => {
    const value = cluster(COMPLIANT_WORKER, { maxParallelSubtasks: 2 });
    const nodes = ["n1", "n2", "n3", "n4"].map((id) => ({ id, task: "干活" }));
    const result = await value.runDag({ nodes, concurrency: 10 });
    // 每一波都不得超过 2。
    for (const wave of result.order) expect(wave.length).toBeLessThanOrEqual(2);
    expect(result.nodes).toHaveLength(4);
  });

  it("rejects an over-decomposed DAG instead of running it anyway", async () => {
    const value = cluster(COMPLIANT_WORKER, { maxParallelSubtasks: 8 });
    const nodes = ["a", "b", "c"].map((id) => ({ id, task: "干" }));
    await expect(value.runDag({ nodes, maxNodes: 2 })).rejects.toThrow(/maxNodes/);
  });
});
