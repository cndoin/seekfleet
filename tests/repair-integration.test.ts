// repair-integration.test.ts — 自纠错在真实 route() 里的闭环行为。
//
// 和 repair.test.ts 的分工：那边测策略模块的判定逻辑，这边用假 dsh 跑真实的
// route()，验证的是这些命题：
//   · 修复轮真的会带着失败证据再跑一次，而不是把失败直接丢出来
//   · 没有客观判据时不会重试 —— 写出记为 no_judgement
//   · 重试只会让它失败得更快（no_progress 止损），不会无限烧钱
//   · 修好了才算成功，且成功的结果才允许进缓存
//   · 自纠错不会把失败率统计污染掉（一个任务一个归因样本）

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshCluster } from "../src/dsh-cluster.js";
import type { VerifyRule } from "../src/verifier.js";

let root: string;
let dshHome: string;
const clusters: DshCluster[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repair-cluster-"));
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

/**
 * 假 dsh：第 N 次运行产出 `answers[N-1]`，并把每次收到的 prompt 追加到 spool。
 * answers 不够长时重复最后一个。
 */
// 注意 dsh 模块根带着 `"type": "module"`，所以假进程里必须用 ESM 的 import，
// 写 require() 会让每次运行都以 EXIT_NONZERO 结束 —— 那看起来像「契约总是违约」，
// 会把自纠错的判定整条带偏。
function scriptedRunner(answers: string[], spoolFile: string): string {
  const counter = JSON.stringify(join(root, "runs.txt"));
  const spool = JSON.stringify(spoolFile);
  const out = JSON.stringify(answers);
  return `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const counter = ${counter};
const spool = ${spool};
const answers = ${out};

const previous = existsSync(counter) ? parseInt(readFileSync(counter, 'utf8'), 10) : 0;
const n = (Number.isFinite(previous) ? previous : 0) + 1;
writeFileSync(counter, String(n));

// 最后一个 argv 才是 prompt；前面的位置参数是 profile 之类的开关值。
const prompt = process.argv[process.argv.length - 1] ?? '';
appendFileSync(spool, '\\n===RUN ' + n + '===\\n' + prompt + '\\n');

const answer = answers[Math.min(n - 1, answers.length - 1)];
process.stdout.write(JSON.stringify({ type: 'answer', answer }) + '\\n');
`;
}

function runCount(file: string = join(root, "runs.txt")): number {
  if (!existsSync(file)) return 0;
  return parseInt(readFileSync(file, "utf8").trim(), 10) || 0;
}

function spool(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** 显式要求输出 JSON 的契约：空答案必然违约。 */
const STRICT_WORKER = { role: "worker" } as const;

/** 一个稳定的、可重复的错误输出（每次都犯同样的错 → 无进展）。 */
const EMPTY_ANSWER = "";

const LENGTH_RULE: VerifyRule[] = [{ kind: "answer-min-length", min: 50 }];

describe("self-repair loop", () => {
  it("retries with the evidence and succeeds when the second attempt complies", async () => {
    const spoolFile = join(root, "spool.txt");
    const value = cluster(scriptedRunner([EMPTY_ANSWER, '{"status":"done","summary":"修好了"}'], spoolFile));
    const result = await value.route({
      task: "实现登录",
      ...STRICT_WORKER,
      selfRepair: 2,
    });

    expect(result.error).toBeUndefined();
    expect(result.audit?.repair).toBeDefined();
    expect(result.audit?.repair?.rescued).toBe(true);
    expect(result.audit?.repair?.attemptsUsed).toBe(1);
    expect(runCount()).toBe(2);

    // 修复 prompt 必须把「系统观测到的失败」说出来，而不是笼统地说「再做一次」。
    const prompts = spool(spoolFile);
    expect(prompts).toContain("===RUN 2===");
    expect(prompts).toContain("上一次尝试没有通过自动验收");
    expect(prompts).toContain("ROLE_EMPTY_OUTPUT");
    // 原始任务必须还在，否则模型会丢失目标（MAST FM-2.3 脱轨）。
    expect(prompts).toContain("实现登录");
  });

  it("refuses to repair even under mode:all when nothing backs the failure", async () => {
    // 这条 DAG 缺口很重要：即使调用方明确要求「什么都重试」，没有可复核的判据时
    // 仍然一次都不该试 —— 否则 group.多行顯自我修復就成了纯粹的烧钱开关。
    const value = cluster("process.exit(3);");
    const result = await value.route({ task: "随手写点东西", selfRepair: { mode: "all", maxAttempts: 3 } });
    expect(runCount()).toBe(0);
    expect(result.audit?.repair?.stopReason).toBe("no_judgement");
    expect(result.audit?.repair?.attemptsUsed).toBe(0);
    expect(result.audit?.repair?.hint).toContain("role");
  });

  it("never retries on success, whatever the policy says", async () => {
    const value = cluster(scriptedRunner(['{"status":"done","summary":"一次就通过了"}'], join(root, "spool2.txt")));
    const result = await value.route({ task: "做一件事", ...STRICT_WORKER, selfRepair: 3 });
    expect(result.audit?.repair?.stopReason).toBe("ok");
    expect(result.audit?.repair?.attemptsUsed).toBe(0);
    expect(runCount()).toBe(1);
  });

  it("stops early when the retry reproduces the identical failure", async () => {
    const value = cluster(scriptedRunner([EMPTY_ANSWER, EMPTY_ANSWER, EMPTY_ANSWER], join(root, "spool3.txt")));
    const result = await value.route({ task: "重构", ...STRICT_WORKER, selfRepair: 4 });

    expect(result.error?.code).toBe("ROLE_CONTRACT_VIOLATION");
    expect(result.audit?.repair?.stopReason).toBe("no_progress");
    // 配了 4 次但只跑 2 次：重复同一个错说明问题在输入而不是运气。
    expect(runCount()).toBe(2);
    expect(result.audit?.repair?.attemptsUsed).toBe(1);
  });

  it("honours the attempt cap when each round actually fails differently", async () => {
    // 三轮各犯不同的错（空答案 -> 缺 JSON -> 空答案），这样不会被 no_progress
    // 提前止损，才能真正走到 max_attempts 这条边上。
    const value = cluster(
      scriptedRunner(
        [
          EMPTY_ANSWER,
          "这是一段长度肯定超过五十个字符的自由文本，里面完全没有 JSON 结构，用来触发缺 JSON 而不是空答案",
          EMPTY_ANSWER,
        ],
        join(root, "spool4.txt"),
      ),
    );
    const result = await value.route({
      task: "重构",
      ...STRICT_WORKER,
      verify: LENGTH_RULE,
      selfRepair: { mode: "governed", maxAttempts: 2 },
    });
    expect(result.error).toBeDefined();
    expect(runCount()).toBe(3); // 首次 + 2 次追加
    expect(result.audit?.repair?.attemptsUsed).toBe(2);
  });

  it("never writes a failed self-repair run into the cache", async () => {
    const value = cluster(scriptedRunner([EMPTY_ANSWER, EMPTY_ANSWER], join(root, "spool5.txt")));
    const task = { task: "永不成功的任务", ...STRICT_WORKER, selfRepair: 2 };
    await value.route(task);
    const before = runCount();
    await value.route(task);
    // 失败结果若进缓存，第二次调用会直接返回坏答案并在后续所有调用里被当真值。
    expect(runCount()).toBeGreaterThan(before);
  });

  it("caches a run that was rescued, so the repair cost is paid once", async () => {
    const value = cluster(scriptedRunner([EMPTY_ANSWER, '{"status":"done","summary":"ok"}'], join(root, "spool6.txt")));
    const task = { task: "可以救回来的任务", ...STRICT_WORKER, selfRepair: 2 };
    const first = await value.route(task);
    expect(first.audit?.repair?.rescued).toBe(true);
    const afterFirst = runCount();
    const second = await value.route(task);
    expect(second.cached).toBe(true);
    expect(runCount()).toBe(afterFirst);
  });

  it("does not retry process-level crashes under the governed mode", async () => {
    const value = cluster("process.exit(3);");
    const result = await value.route({ task: "崩掉的任务", selfRepair: 3 });
    // 崩溃是确定性失败：第二遍大概率还是崩，重试只是一次昂贵的确认。
    expect(result.error).toBeDefined();
    expect(result.audit?.repair?.attemptsUsed).toBe(0);
    expect(result.audit?.repair?.stopReason).not.toBe("max_attempts");
  });

  it("rotates to a different instance for the repair attempt", async () => {
    const value = cluster(scriptedRunner([EMPTY_ANSWER, ""], join(root, "spool7.txt")));
    const result = await value.route({ task: "换实例", ...STRICT_WORKER, selfRepair: 1 });
    expect(result.error).toBeDefined();
    expect(runCount()).toBe(2);
  });

  it("keeps one attribution sample per task, not one per repair attempt", async () => {
    const value = cluster(scriptedRunner([EMPTY_ANSWER, EMPTY_ANSWER], join(root, "spool8.txt")));
    await value.route({ task: "失败的活", ...STRICT_WORKER, selfRepair: 3 });
    const report = value.attributionReport();
    // 跑了两个 round 但只有一个任务 —— failureRate 若被自纠错抬高，
    // 上线后会看起来像系统变坏了，从而做出错误的决策。
    expect(report.totalTraces).toBe(1);
    expect(report.failedTraces).toBe(1);
    expect(report.failureRate).toBe(1);
  });

  it("leaves clean results untouched when self-repair is off", async () => {
    const value = cluster(scriptedRunner(['{"status":"done","summary":"一次过"}'], join(root, "spool9.txt")));
    const result = await value.route({ task: "一次就对", ...STRICT_WORKER });
    expect(result.error).toBeUndefined();
    expect(result.audit?.repair).toBeUndefined();
    expect(runCount()).toBe(1);
  });
});
