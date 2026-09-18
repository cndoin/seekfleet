import { describe, expect, it } from "vitest";
import {
  MAX_REPAIR_ATTEMPTS_HARD_CAP,
  RepairLoop,
  buildRepairTask,
  clipAnswer,
  failureFingerprint,
  isRepairableFailure,
  normalizeRepairPolicy,
  observeResult,
  type RepairObservation,
} from "../src/repair.js";
import type { DshResult, DshTask } from "../src/types.js";

function result(over: Partial<DshResult> = {}): DshResult {
  return {
    answer: "hi",
    toolCalls: [],
    toolResults: [],
    events: 1,
    durationMs: 10,
    exitCode: 0,
    stderrTail: "",
    ...over,
  };
}

function baseTask(): DshTask {
  return { task: "写一个函数", role: "worker", verify: [{ kind: "answer-min-length", min: 10 }] };
}

/** 带上违约与验收失败的一次观测。 */
function obsWithJudgement(attempt = 0, tokens = 1000): RepairObservation {
  const r = result({
    answer: "",
    error: { code: "ROLE_CONTRACT_VIOLATION", message: "违反契约" },
    audit: {
      role: { name: "worker", ok: false, violations: [{ code: "ROLE_EMPTY_OUTPUT", message: "空答案" }], toolCalls: 0 },
      verification: {
        ok: false,
        durationMs: 1,
        unknownKinds: [],
        configErrors: [],
        checks: [{ name: "len", kind: "answer-min-length", ok: false, detail: "太短", durationMs: 1 }],
      },
    },
    usage: { inputTokens: 500, outputTokens: 500, totalTokens: tokens, model: "m" },
  });
  return observeResult(r, attempt);
}

describe("normalizeRepairPolicy", () => {
  it("treats missing input as disabled", () => {
    for (const input of [undefined, null, false]) {
      expect(normalizeRepairPolicy(input as never).enabled).toBe(false);
    }
  });

  it("maps true to the governed default", () => {
    const p = normalizeRepairPolicy(true);
    expect(p.enabled).toBe(true);
    expect(p.mode).toBe("governed");
    expect(p.maxAttempts).toBe(2);
  });

  it("reads a number as the attempt budget", () => {
    expect(normalizeRepairPolicy(3).maxAttempts).toBe(3);
  });

  it("clamps absurd attempt counts to the hard cap", () => {
    // 上限存在的理由：自纠错每多一轮就是双倍成本，不能让调用方写个 999 就把账户跑穿。
    expect(normalizeRepairPolicy(999).maxAttempts).toBe(MAX_REPAIR_ATTEMPTS_HARD_CAP);
  });

  it("turns non-positive counts into disabled rather than 'always retry'", () => {
    expect(normalizeRepairPolicy(0).enabled).toBe(false);
    expect(normalizeRepairPolicy(-5).enabled).toBe(false);
    expect(normalizeRepairPolicy(NaN).enabled).toBe(false);
  });

  it("does not guess when given an unrecognisable object", () => {
    // 静默启用自纠错是最坏的默认值：成本翻倍而调用方完全不知情。
    const p = normalizeRepairPolicy({ maxAttempts: Number.POSITIVE_INFINITY } as never);
    expect(p.maxAttempts).toBe(0);
  });

  it("keeps explicit overrides", () => {
    const p = normalizeRepairPolicy({ mode: "all", maxAttempts: 1, rotateInstance: false, maxTokenGrowth: 3 });
    expect(p).toEqual({ enabled: true, mode: "all", maxAttempts: 1, maxTokenGrowth: 3, rotateInstance: false });
  });
});

describe("isRepairableFailure", () => {
  it("repairs contract and verification failures under governed mode", () => {
    expect(isRepairableFailure("ROLE_CONTRACT_VIOLATION", "governed")).toBe(true);
    expect(isRepairableFailure("VERIFY_FAILED", "governed")).toBe(true);
  });

  it("refuses crashes under governed mode", () => {
    // 进程崩溃是确定性的：第二次大概率还是崩，重试只是一次昂贵的确认。
    expect(isRepairableFailure("EXIT_NONZERO", "governed")).toBe(false);
    expect(isRepairableFailure("ABORTED", "governed")).toBe(false);
  });

  it("allows everything under all mode", () => {
    expect(isRepairableFailure("EXIT_NONZERO", "all")).toBe(true);
  });

  it("needs a code to decide", () => {
    expect(isRepairableFailure(undefined, "all")).toBe(false);
  });
});

describe("failureFingerprint", () => {
  it("is order independent", () => {
    const a: RepairObservation = {
      attempt: 0,
      result: result(),
      violations: [
        { code: "A", message: "" },
        { code: "B", message: "" },
      ],
      failedChecks: [],
    };
    const b: RepairObservation = {
      attempt: 0,
      result: result(),
      violations: [
        { code: "B", message: "" },
        { code: "A", message: "" },
      ],
      failedChecks: [],
    };
    // 列表顺序会随调度抖动变化；不排序会把「同一个错」误判成有进展。
    expect(failureFingerprint(a)).toBe(failureFingerprint(b));
  });

  it("distinguishes different failure sets", () => {
    const a: RepairObservation = {
      attempt: 0,
      result: result(),
      violations: [{ code: "A", message: "" }],
      failedChecks: [],
    };
    const b: RepairObservation = {
      attempt: 0,
      result: result(),
      violations: [{ code: "A", message: "" }],
      failedChecks: [{ name: "tsc", kind: "command", detail: "" }],
    };
    expect(failureFingerprint(a)).not.toBe(failureFingerprint(b));
  });
});

describe("RepairLoop", () => {
  it("stops immediately on success", () => {
    const loop = new RepairLoop(normalizeRepairPolicy(true));
    const v = loop.observe({ attempt: 0, result: result(), violations: [], failedChecks: [] });
    expect(v.reason).toBe("ok");
    expect(v.action).toBe("stop");
  });

  it("refuses to retry without any judgement evidence", () => {
    const loop = new RepairLoop(normalizeRepairPolicy(true));
    const v = loop.observe({
      attempt: 0,
      result: result({ error: { code: "SOMETHING", message: "x" } }),
      errorCode: "SOMETHING",
      violations: [],
      failedChecks: [],
    });
    expect(v.reason).toBe("no_judgement");
    expect(v.hint).toBeTruthy();
  });

  it("does not retry when the policy is off", () => {
    const loop = new RepairLoop(normalizeRepairPolicy(false));
    const v = loop.observe(obsWithJudgement());
    expect(v.reason).toBe("policy_disabled");
  });

  it("proceeds once then stops at the attempt cap", () => {
    const loop = new RepairLoop(normalizeRepairPolicy(1));
    expect(loop.observe(obsWithJudgement(0)).action).toBe("proceed");
    const second = {
      ...obsWithJudgement(1),
      violations: [{ code: "ROLE_MAX_TOOL_CALLS" as const, message: "太多调用" }],
    };
    const v = loop.observe(second);
    expect(v.reason).toBe("max_attempts");
  });

  it("stops when the retry reproduces the identical failure set", () => {
    const loop = new RepairLoop(normalizeRepairPolicy(3));
    expect(loop.observe(obsWithJudgement(0)).action).toBe("proceed");
    const v = loop.observe(obsWithJudgement(1));
    expect(v.reason).toBe("no_progress");
    // 停止必须附带结构性建议 —— 否则调用方只会去调大 maxAttempts。
    expect(v.hint).toContain("重复同一个错");
  });

  it("keeps going when the failure set actually changed", () => {
    const loop = new RepairLoop(normalizeRepairPolicy(3));
    expect(loop.observe(obsWithJudgement(0)).action).toBe("proceed");
    const improved: RepairObservation = {
      ...obsWithJudgement(1),
      violations: [{ code: "ROLE_OUTPUT_SCHEMA", message: "字段缺失" }],
    };
    expect(loop.observe(improved).action).toBe("proceed");
  });

  it("stops when retries blow past the token ceiling", () => {
    const loop = new RepairLoop(normalizeRepairPolicy({ maxAttempts: 3, maxTokenGrowth: 1.2 }));
    expect(loop.observe(obsWithJudgement(0, 1000)).action).toBe("proceed");
    const fat: RepairObservation = {
      ...obsWithJudgement(1, 5000),
      violations: [{ code: "ROLE_OUTPUT_SCHEMA", message: "字段缺失" }],
    };
    const v = loop.observe(fat);
    expect(v.reason).toBe("budget_exceeded");
  });

  it("does not retry crashes under the default governed mode", () => {
    const loop = new RepairLoop(normalizeRepairPolicy(true));
    const crash: RepairObservation = {
      attempt: 0,
      result: result({ error: { code: "EXIT_NONZERO", message: "exit 1" } }),
      errorCode: "EXIT_NONZERO",
      violations: [{ code: "ROLE_MAX_TOOL_CALLS", message: "太多调用" }],
      failedChecks: [],
    };
    const v = loop.observe(crash);
    expect(v.reason).toBe("not_repairable");
  });

  it("records every attempt for later inspection", () => {
    const loop = new RepairLoop(normalizeRepairPolicy(3));
    loop.observe(obsWithJudgement(0));
    expect(loop.history).toHaveLength(1);
    expect(loop.history[0]!.violations).toContain("ROLE_EMPTY_OUTPUT");
    expect(loop.history[0]!.failedChecks).toContain("answer-min-length:len");
  });
});

describe("buildRepairTask", () => {
  it("keeps the original goal in front of the correction", () => {
    const task = buildRepairTask(baseTask(), obsWithJudgement(), 1);
    // 只给「你错了」而不重申任务，模型会丢失目标 —— 那是另一种形式的失败。
    expect(task.task.indexOf("【原始任务】")).toBeLessThan(task.task.indexOf("【第 1 次修正】"));
    expect(task.task).toContain("写一个函数");
  });

  it("lists every failed item explicitly", () => {
    const task = buildRepairTask(baseTask(), obsWithJudgement(), 1);
    expect(task.task).toContain("ROLE_EMPTY_OUTPUT");
    expect(task.task).toContain("answer-min-length/len");
  });

  it("inherits governance instead of bypassing it", () => {
    const task = buildRepairTask(baseTask(), obsWithJudgement(), 2);
    expect(task.role).toBe("worker");
    expect(task.verify).toEqual(baseTask().verify);
  });

  it("labels repair rounds so they are distinguishable in logs and caches", () => {
    const task = buildRepairTask({ ...baseTask(), label: "t1" }, obsWithJudgement(), 3);
    expect(task.label).toBe("t1#repair3");
  });

  it("clips a long previous answer instead of echoing it whole", () => {
    const long = "x".repeat(5000);
    const o = { ...obsWithJudgement(), result: result({ answer: long }) };
    const task = buildRepairTask(baseTask(), o, 1);
    expect(task.task.length).toBeLessThan(long.length);
    expect(task.task).toContain("已省略");
  });
});

describe("clipAnswer", () => {
  it("returns short answers untouched", () => {
    expect(clipAnswer("short")).toBe("short");
  });

  it("keeps head and tail, drops the middle", () => {
    const s = "H".repeat(2000) + "M".repeat(2000) + "T".repeat(2000);
    const c = clipAnswer(s);
    expect(c.startsWith("HHH")).toBe(true);
    expect(c.endsWith("TTT")).toBe(true);
    expect(c).not.toContain("MMMMMMMM");
  });
});

describe("observeResult", () => {
  it("pulls violations, failed checks, code and tokens out of a result", () => {
    const o = obsWithJudgement();
    expect(o.errorCode).toBe("ROLE_CONTRACT_VIOLATION");
    expect(o.violations).toHaveLength(1);
    expect(o.failedChecks).toHaveLength(1);
    expect(o.tokens).toBe(1000);
  });

  it("stays empty rather than inventing failures on a clean result", () => {
    const o = observeResult(result(), 0);
    expect(o.violations).toEqual([]);
    expect(o.failedChecks).toEqual([]);
    expect(o.errorCode).toBeUndefined();
  });
});
