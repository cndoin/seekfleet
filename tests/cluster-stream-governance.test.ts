// cluster-stream-governance.test.ts — 流式路径的组织层闸门。
//
// 背景：route() 走完整治理层（契约 / 独立验证 / 归因），但 stream() 曾经只看
// 退出码和 error 事件。于是同样的失败在两条路径上得到相反的判定：
// 一条「退出码 0、输出违反契约」的流式运行会被记成成功 —— 预算确认、路由记成功、
// 不进归因报告。这就是本项目最初要根除的静默成功，只是换了一条路径。
//
// 这里用假 dsh 跑真实的 DshCluster.stream()，验证三件事：
//   1) 契约违约 / 验证失败会被补发成终态 error 事件（消费方一定能看见）
//   2) 干净的流不会被误报
//   3) 失败流照样进归因报告，且一个任务只算一个样本

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshCluster } from "../src/dsh-cluster.js";
import type { DshEvent } from "../src/types.js";
import type { VerifyRule } from "../src/verifier.js";

let root: string;
let dshHome: string;
const clusters: DshCluster[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stream-governed-"));
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

async function drain(
  gen: AsyncGenerator<DshEvent & { instance: string }>,
): Promise<Array<DshEvent & { instance: string }>> {
  const out: Array<DshEvent & { instance: string }> = [];
  for await (const evt of gen) out.push(evt);
  return out;
}

/** 终态事件里带 stage:"governance" 的那一条（治理层补发的失败通知）。 */
function governanceFailure(events: Array<DshEvent & { instance: string }>) {
  return events.find((e) => e.kind === "error" && (e.data as { stage?: string } | undefined)?.stage === "governance");
}

describe("stream() runs the same governance gate as route()", () => {
  it("injects the role contract before the stream starts", async () => {
    const value = cluster(ECHO_ARGV);
    const events = await drain(value.stream({ task: "重构 parser", role: "worker" }));
    const answer = events.find((e) => e.kind === "answer")?.data as { answer?: string } | undefined;
    // 契约没注入的话，模型根本收不到约束，事后审计只会一轮轮报违约。
    expect(answer?.answer).toContain("<role-contract>");
    expect(answer?.answer).toContain("<name>worker</name>");
  });

  it("reports a contract violation as a terminal error event, not a quiet exit", async () => {
    const value = cluster(ECHO_ARGV);
    const events = await drain(value.stream({ task: "做某事", role: "worker" }));
    // 进程退出码是干净的 —— 单看退出码会判定成功。
    expect(events.some((e) => e.kind === "exit")).toBe(true);
    const failure = governanceFailure(events);
    expect(failure).toBeDefined();
    expect((failure!.data as { code?: string }).code).toBe("ROLE_CONTRACT_VIOLATION");
    expect(events.at(-1)!.kind).toBe("error");
  });

  it("reports a verification failure even though the agent said it was done", async () => {
    const value = cluster(COMPLIANT_WORKER);
    const rules: VerifyRule[] = [{ kind: "answer-match", pattern: "^这句话答案里肯定没有$", name: "收尾句" }];
    const events = await drain(value.stream({ task: "做事", role: "worker", verify: rules }));
    const failure = governanceFailure(events);
    expect(failure).toBeDefined();
    expect((failure!.data as { code?: string }).code).toBe("VERIFY_FAILED");
    // 审计明细一并带上，消费方才知道是哪一条检查没通过。
    expect((failure!.data as { audit?: { verification?: { ok?: boolean } } }).audit?.verification?.ok).toBe(false);
  });

  it("does not invent a failure for a clean, governed stream", async () => {
    const value = cluster(COMPLIANT_WORKER);
    const events = await drain(
      value.stream({ task: "做事", role: "worker", verify: [{ kind: "answer-min-length", min: 2 }] }),
    );
    expect(governanceFailure(events)).toBeUndefined();
    expect(events.some((e) => e.kind === "error")).toBe(false);
    expect(events.at(-1)!.kind).toBe("exit");
  });

  it("does not append a second error when the stream itself already failed", async () => {
    const value = cluster("console.log(JSON.stringify({type:'error',message:'boom'})); process.exit(3);");
    const events = await drain(value.stream({ task: "会崩的任务" }));
    expect(events.some((e) => e.kind === "error")).toBe(true);
    // 流已经报错了，再补一条只会让消费方以为是两个问题。
    expect(governanceFailure(events)).toBeUndefined();
  });

  it("refuses an unknown department before opening the stream", async () => {
    const value = cluster(COMPLIANT_WORKER);
    // 异步生成器的抛出发生在第一次 next()，所以这里必须真的把流消费掉。
    await expect(drain(value.stream({ task: "x", role: "wizard" }))).rejects.toThrow(/unknown department/);
  });

  it("counts the streamed run in the instance error accounting", async () => {
    const value = cluster(ECHO_ARGV);
    await drain(value.stream({ task: "做某事", role: "worker" }));
    const errors = value.status().instances.reduce((sum, i) => sum + i.totalErrors, 0);
    expect(errors).toBe(1);
    // 验收层的违约码是 ROLE_*（FM-1.1 的映射发生在归因层），这里只确认它传到了实例状态。
    expect(value.status().instances.some((i) => /^ROLE_/.test(i.lastError ?? ""))).toBe(true);
  });

  it("records exactly one attribution sample per streamed task", async () => {
    const value = cluster(ECHO_ARGV);
    await drain(value.stream({ task: "做事", role: "worker" }));
    const report = value.attributionReport();
    // 一个任务一个样本 —— 否则 failureRate 会被路径本身抬高。
    expect(report.totalTraces).toBe(1);
    expect(report.failedTraces).toBe(1);
    expect(report.rows.some((r) => r.code === "FM-1.1")).toBe(true);
  });
});
