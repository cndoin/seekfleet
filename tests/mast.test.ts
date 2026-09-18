// mast.test.ts — 失败归因分类器。
//
// 这个模块输出的是「先查哪一条」的排序，而不是判决。所以测试的重点是：
//   1. 硬证据（角色违规、校验失败、被中断）必须被稳定捕获；
//   2. 没有痕迹时必须说「没检测到」，而不是编一个出来；
//   3. 弱信号必须真的弱（confidence < 0.7），不能被当成结论用。

import { describe, expect, it } from "vitest";
import {
  MAST_BASELINE,
  MAST_MODES,
  aggregateFailures,
  classifyTrace,
  formatAttribution,
  getMode,
  type TraceView,
} from "../src/mast.js";

const cleanRun: TraceView = {
  task: "把 README 里的版本号改成 0.1.1",
  answer: "改好了",
  exitCode: 0,
  toolCalls: [{ name: "str-replace-editor", args: { path: "README.md" } }],
  verification: { ok: true, checks: [{ kind: "command", ok: true, detail: "exit 0" }] },
};

describe("MAST_MODES", () => {
  it("covers exactly the 14 modes from the paper", () => {
    expect(MAST_MODES).toHaveLength(14);
    expect(MAST_MODES.map((m) => m.code)).toEqual([
      "FM-1.1",
      "FM-1.2",
      "FM-1.3",
      "FM-1.4",
      "FM-1.5",
      "FM-2.1",
      "FM-2.2",
      "FM-2.3",
      "FM-2.4",
      "FM-2.5",
      "FM-2.6",
      "FM-3.1",
      "FM-3.2",
      "FM-3.3",
    ]);
  });

  it("keeps the five / six / three split used by the MAST paper", () => {
    const count = (c: string) => MAST_MODES.filter((m) => m.category === c).length;
    expect(count("system-design")).toBe(5);
    expect(count("inter-agent")).toBe(6);
    expect(count("verification")).toBe(3);
  });

  it("gives every mode an actionable structural fix, not just a label", () => {
    for (const m of MAST_MODES) {
      expect(m.fix.length, `${m.code} needs a fix suggestion`).toBeGreaterThan(6);
      expect(m.labelZh.length).toBeGreaterThan(1);
      expect(m.cause.length).toBeGreaterThan(6);
    }
  });

  it("throws on an unknown code instead of returning an empty mode", () => {
    // @ts-expect-error 故意用非法 code
    expect(() => getMode("FM-9.9")).toThrow();
  });
});

describe("classifyTrace / hard evidence", () => {
  it("reports no signal for a clean run", () => {
    const a = classifyTrace(cleanRun);
    expect(a.ok).toBe(true);
    expect(a.signals).toEqual([]);
    expect(a.primary).toBeUndefined();
  });

  it("maps a failed verification to FM-3.2 with high confidence", () => {
    const a = classifyTrace({
      ...cleanRun,
      verification: {
        ok: false,
        checks: [{ kind: "command", ok: false, detail: "exit 1 | AssertionError: expected 2 to be 3" }],
      },
    });
    expect(a.primary?.code).toBe("FM-3.2");
    expect(a.primary!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(a.primary!.evidence).toContain("AssertionError");
  });

  it("maps an aborted run to FM-3.1 (interrupted, not wrong)", () => {
    const a = classifyTrace({ ...cleanRun, aborted: true, errorCode: "ABORTED", answer: "" });
    expect(a.primary?.code).toBe("FM-3.1");
  });

  it("maps an out-of-contract tool call to FM-1.2", () => {
    const a = classifyTrace({
      ...cleanRun,
      roleAudit: { ok: false, violations: [{ code: "ROLE_TOOL_FORBIDDEN", message: "x", evidence: "bash" }] },
    });
    expect(a.signals.some((s) => s.code === "FM-1.2" && s.confidence >= 0.8)).toBe(true);
  });

  it("maps a schema violation to FM-1.1", () => {
    const a = classifyTrace({
      ...cleanRun,
      roleAudit: {
        ok: false,
        violations: [{ code: "ROLE_OUTPUT_SCHEMA", message: "x", evidence: 'missing "verdict"' }],
      },
    });
    expect(a.signals.some((s) => s.code === "FM-1.1")).toBe(true);
  });

  it("maps repeated identical calls to FM-1.3 even without a role contract", () => {
    const a = classifyTrace({
      ...cleanRun,
      answer: "",
      toolCalls: [
        { name: "fs", args: { path: "a" } },
        { name: "fs", args: { path: "a" } },
        { name: "fs", args: { path: "a" } },
      ],
    });
    const fm13 = a.signals.find((s) => s.code === "FM-1.3");
    expect(fm13).toBeDefined();
    expect(fm13!.evidence).toContain("3×");
  });

  it("detects lost context: work was done but nothing came back", () => {
    // 这里是 FM-1.4 而非 FM-3.1：进程是正常退出的，只是结论丢了。
    const a = classifyTrace({ ...cleanRun, answer: "", exitCode: 0 });
    expect(a.signals.some((s) => s.code === "FM-1.4")).toBe(true);
  });

  it("treats verification rules that never ran as FM-3.3, not as a pass", () => {
    const a = classifyTrace({
      ...cleanRun,
      verification: { ok: false, unknownKinds: ["screenshot-match"], checks: [{ ok: false, detail: "did NOT run" }] },
    });
    expect(a.signals.some((s) => s.code === "FM-3.3")).toBe(true);
  });

  it("flags a hollow pass: the check says ok but admits some constraints were not enforced", () => {
    const a = classifyTrace({
      ...cleanRun,
      verification: {
        ok: true,
        checks: [{ kind: "answer-schema", ok: true, detail: "passed, but these constraints were NOT enforced: anyOf" }],
      },
    });
    expect(a.signals.some((s) => s.code === "FM-3.3" && s.confidence < 0.6)).toBe(true);
  });

  it("flags side-effect work with no verification at all", () => {
    const a = classifyTrace({ task: "重构", answer: "done", exitCode: 0, toolCalls: [{ name: "bash" }] });
    const fm32 = a.signals.find((s) => s.code === "FM-3.2");
    expect(fm32).toBeDefined();
    // 这是间接推断，置信度必须低于硬证据。
    expect(fm32!.confidence).toBeLessThan(0.7);
  });
});

describe("classifyTrace / coordination signals", () => {
  it("flags ignored upstream input (FM-2.5)", () => {
    const a = classifyTrace({
      ...cleanRun,
      dependencyResultsInjected: true,
      upstream: [{ id: "research", answer: "结论：用 sqlite" }],
      answer: "我决定用 mysql",
    });
    expect(a.signals.some((s) => s.code === "FM-2.5" && s.confidence < 0.6)).toBe(true);
  });

  it("does not cry FM-2.5 when the downstream actually referenced upstream", () => {
    const a = classifyTrace({
      ...cleanRun,
      dependencyResultsInjected: true,
      upstream: [{ id: "research", answer: "结论：用 sqlite" }],
      answer: "按 research 的结论，采用 sqlite",
    });
    expect(a.signals.some((s) => s.code === "FM-2.5")).toBe(false);
  });

  it("flags claimed-but-never-performed writes (FM-2.6)", () => {
    const a = classifyTrace({ ...cleanRun, answer: "已修改 src/a.ts", toolCalls: [], verification: { ok: true } });
    expect(a.signals.some((s) => s.code === "FM-2.6")).toBe(true);
  });

  it("flags an ambiguous task answered without doing anything (FM-2.2)", () => {
    const a = classifyTrace({
      task: "这个应该用 sqlite 还是 mysql？",
      answer: "都可以试试",
      toolCalls: [],
      verification: { ok: true },
    });
    expect(a.signals.some((s) => s.code === "FM-2.2" && s.confidence < 0.5)).toBe(true);
  });

  it("flags blowing way past the declared budget as derailment (FM-2.3)", () => {
    const calls = Array.from({ length: 40 }, (_, i) => ({ name: "fs", args: { i } }));
    const a = classifyTrace({ ...cleanRun, declaredMaxToolCalls: 10, toolCalls: calls });
    expect(a.signals.some((s) => s.code === "FM-2.3")).toBe(true);
    expect(a.signals.some((s) => s.code === "FM-1.5")).toBe(true);
  });
});

describe("classifyTrace / discipline", () => {
  it("sorts signals by descending confidence", () => {
    const calls = Array.from({ length: 9 }, (_, i) => ({ name: "fs", args: { i } }));
    const a = classifyTrace({
      ...cleanRun,
      answer: "",
      declaredMaxToolCalls: 3,
      toolCalls: calls,
      verification: { ok: false, checks: [{ ok: false, detail: "exit 1" }] },
    });
    const confidences = a.signals.map((s) => s.confidence);
    expect(confidences).toEqual([...confidences].sort((x, y) => y - x));
    expect(a.primary?.code).toBe("FM-3.2");
  });

  it("never emits a signal without evidence", () => {
    const a = classifyTrace({ answer: "", exitCode: 1 });
    for (const s of a.signals) expect(s.evidence.length).toBeGreaterThan(0);
  });

  it("does not fabricate anything for a trace it knows nothing about", () => {
    // 空 trace 必须诚实说「没检测到」，而不是瞎猜一个模式出来。
    const a = classifyTrace({});
    expect(a.ok).toBe(true);
    expect(a.signals).toEqual([]);
  });

  it("survives unserializable call args", () => {
    const cyclic: Record<string, unknown> = { name: "bash" };
    cyclic.self = cyclic;
    expect(() => classifyTrace({ ...cleanRun, toolCalls: [cyclic as never] })).not.toThrow();
  });
});

describe("aggregateFailures", () => {
  const clean = classifyTrace(cleanRun);
  const schemaFail = classifyTrace({
    ...cleanRun,
    roleAudit: { ok: false, violations: [{ code: "ROLE_OUTPUT_SCHEMA", message: "x", evidence: "missing field" }] },
  });
  const verifyFail = classifyTrace({
    ...cleanRun,
    verification: { ok: false, checks: [{ ok: false, detail: "exit 1" }] },
  });

  it("computes the failure rate over all traces", () => {
    const report = aggregateFailures([clean, schemaFail, verifyFail, clean]);
    expect(report.totalTraces).toBe(4);
    expect(report.failedTraces).toBe(2);
    expect(report.failureRate).toBeCloseTo(0.5);
  });

  it("ranks the most-hit mode first so there is a clear place to start", () => {
    const report = aggregateFailures([schemaFail, schemaFail, verifyFail]);
    expect(report.rows[0]?.code).toBe("FM-1.1");
    expect(report.rows[0]!.count).toBe(2);
    expect(report.priorities[0]!.code).toBe("FM-1.1");
  });

  it("splits failures into the three MAST categories", () => {
    const report = aggregateFailures([schemaFail, verifyFail]);
    const system = report.byCategory.find((c) => c.category === "system-design");
    const verification = report.byCategory.find((c) => c.category === "verification");
    expect(system!.count).toBe(1);
    expect(verification!.count).toBe(1);
    const total = report.byCategory.reduce((n, c) => n + c.share, 0);
    expect(total).toBeCloseTo(1);
  });

  it("handles an empty batch without dividing by zero", () => {
    const report = aggregateFailures([]);
    expect(report.totalTraces).toBe(0);
    expect(report.failureRate).toBe(0);
    expect(report.rows).toEqual([]);
    for (const c of report.byCategory) expect(c.share).toBe(0);
  });

  it("ships the paper's baseline distribution for comparison", () => {
    const sum = MAST_BASELINE["system-design"] + MAST_BASELINE["inter-agent"] + MAST_BASELINE.verification;
    expect(sum).toBeCloseTo(1, 2);
  });
});

describe("formatAttribution", () => {
  it("says 'no signal' plainly for a clean attribution", () => {
    expect(formatAttribution(classifyTrace(cleanRun))).toContain("no failure signal detected");
  });

  it("renders code, confidence, evidence and fix in one readable block", () => {
    const text = formatAttribution(classifyTrace({ ...cleanRun, aborted: true, answer: "", toolCalls: [] }));
    expect(text).toContain("FM-3.1");
    expect(text).toContain("confidence");
    expect(text).toContain("evidence");
    expect(text).toContain("fix");
  });
});
