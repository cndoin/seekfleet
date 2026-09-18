// role-spec.test.ts — 角色契约的编译与事后审计。
//
// 每个用例都挂着一个 MAST 失败编号，方便回查「这条断言到底在防什么」。
// 参考：arXiv:2503.13657（Why Do Multi-Agent LLM Systems Fail?）

import { describe, expect, it } from "vitest";
import {
  DEPARTMENTS,
  auditRoleRun,
  attachRoleContract,
  compileRoleContract,
  getDepartment,
  hasRoleContract,
  validateRoleSpec,
  type RoleSpec,
} from "../src/role-spec.js";
import type { DshResult, DshToolInvocation } from "../src/types.js";

function result(answer: string, toolNames: string[] = [], extra: Partial<DshResult> = {}): DshResult {
  const toolCalls: DshToolInvocation[] = toolNames.map((name) => ({ name, args: { n: 1 } }));
  return {
    answer,
    toolCalls,
    toolResults: [],
    events: 0,
    durationMs: 10,
    exitCode: 0,
    stderrTail: "",
    ...extra,
  };
}

function repeatCalls(name: string, args: unknown, times: number): DshResult {
  return result("x", [], {
    toolCalls: Array.from({ length: times }, () => ({ name, args })),
  });
}

describe("validateRoleSpec", () => {
  it("rejects a role that constrains nothing (MAST FM-1.2 违反角色设定)", () => {
    expect(validateRoleSpec({ name: "", goal: "" })).toContain("role.name must not be empty");
    expect(validateRoleSpec({ name: "worker", goal: "" })).toContain("role.goal must not be empty");
  });

  it("rejects nonsense numeric limits", () => {
    expect(validateRoleSpec({ name: "w", goal: "g", maxToolCalls: 0 })).toContain(
      "role.maxToolCalls must be a positive number",
    );
    expect(validateRoleSpec({ name: "w", goal: "g", maxIdenticalCalls: -1 })).toContain(
      "role.maxIdenticalCalls must be a positive number",
    );
  });

  it("rejects a tool listed as both allowed and forbidden", () => {
    const problems = validateRoleSpec({ name: "w", goal: "g", allowedTools: ["bash"], forbiddenTools: ["bash"] });
    expect(problems.some((p) => p.includes("tools listed in both"))).toBe(true);
  });
});

describe("compileRoleContract", () => {
  const spec: RoleSpec = {
    name: "reviewer",
    goal: "独立验收",
    stopCondition: "给出 verdict 后停止",
    allowedTools: ["fs"],
    forbiddenTools: ["str-replace-editor"],
    maxToolCalls: 5,
    constraints: ["不要修改被审查的文件"],
    deliverables: ["逐条裁定"],
    outputSchema: { type: "object", required: ["verdict"] },
  };

  it("always emits a termination condition (MAST FM-1.5 占 12.4%)", () => {
    expect(compileRoleContract(spec)).toContain("<stop-when>");
    // 连没写 stopCondition 的角色也必须有一个兜底终止条件。
    expect(compileRoleContract({ name: "x", goal: "y" })).toContain("<stop-when>");
  });

  it("carries tool bounds and step limits into the prompt", () => {
    const text = compileRoleContract(spec);
    expect(text).toContain("<allowed-tools>fs</allowed-tools>");
    expect(text).toContain("<forbidden-tools>str-replace-editor</forbidden-tools>");
    expect(text).toContain("<max-tool-calls>5</max-tool-calls>");
    expect(text).toContain("不要修改被审查的文件");
  });

  it("embeds the output schema verbatim so the model has no excuse to invent a shape", () => {
    expect(compileRoleContract(spec)).toContain('"verdict"');
  });
});

describe("attachRoleContract", () => {
  it("prepends the contract once", () => {
    const once = attachRoleContract("做这件事", DEPARTMENTS.worker!);
    expect(hasRoleContract(once)).toBe(true);
    // 幂等：同一段文本再过一遍不会嵌出第二份契约。
    expect(attachRoleContract(once, DEPARTMENTS.planner!).length).toBe(once.length);
  });

  it("keeps the original task text readable after the contract", () => {
    const text = attachRoleContract("重构 parse 函数", DEPARTMENTS.worker!);
    expect(text.endsWith("重构 parse 函数")).toBe(true);
  });
});

describe("auditRoleRun", () => {
  it("passes a clean run", () => {
    // 合规输出必须把 reviewer schema 要求的 checks 也带上 —— 只有 verdict
    // 是不完整的裁定，合约上就该判失败。
    const answer = JSON.stringify({
      verdict: "accept",
      checks: [{ acceptance: "单测通过", passed: true, evidence: "vitest run: 42 passed" }],
    });
    const audit = auditRoleRun(DEPARTMENTS.reviewer!, result(answer, ["fs"]));
    expect(audit.ok).toBe(true);
    expect(audit.violations).toEqual([]);
    expect(audit.parsedOutput).toEqual({
      verdict: "accept",
      checks: [{ acceptance: "单测通过", passed: true, evidence: "vitest run: 42 passed" }],
    });
    expect(audit.toolCalls).toBe(1);
  });

  it("rejects an approve-onlyverdict that carries no evidence (FM-3.2 验证不完整)", () => {
    // 「通过」但一个 check 都没有 = 什么都没验证。这正是 MAST FM-3.2。
    const audit = auditRoleRun(DEPARTMENTS.reviewer!, result('{"verdict":"accept","checks":[]}', ["fs"]));
    expect(audit.ok).toBe(false);
    expect(audit.violations.some((x) => x.code === "ROLE_OUTPUT_SCHEMA")).toBe(true);
  });

  it("flags a tool outside the allowlist (FM-1.2)", () => {
    const audit = auditRoleRun(DEPARTMENTS.planner!, result('{"subtasks":[]}', ["bash"]));
    const v = audit.violations.find((x) => x.code === "ROLE_TOOL_NOT_ALLOWED");
    expect(v).toBeDefined();
    expect(v!.evidence).toContain("bash");
  });

  it("flags an explicitly forbidden tool even when no allowlist exists (FM-1.2)", () => {
    const audit = auditRoleRun(DEPARTMENTS.synthesizer!, result('{"answer":"hi"}', ["bash"]));
    expect(audit.violations.some((x) => x.code === "ROLE_TOOL_FORBIDDEN")).toBe(true);
  });

  it("flags exceeding the step budget (FM-1.5)", () => {
    const audit = auditRoleRun({ name: "w", goal: "g", maxToolCalls: 2 }, result("done", ["a", "b", "c"]));
    expect(audit.violations.some((x) => x.code === "ROLE_MAX_TOOL_CALLS")).toBe(true);
  });

  it("flags repeated identical calls — MAST's single biggest mode, 15.7% (FM-1.3)", () => {
    // 同一个工具 + 同样的参数连续三次：典型的「卡住重试」，不是在做事。
    const audit = auditRoleRun(DEPARTMENTS.worker!, repeatCalls("fs", { path: "a.txt", op: "read" }, 3));
    const v = audit.violations.find((x) => x.code === "ROLE_STEP_REPETITION");
    expect(v).toBeDefined();
    expect(v!.evidence).toContain("3×");
  });

  it("does not flag legitimate iteration when arguments differ", () => {
    const r = result("done", [], {
      toolCalls: [
        { name: "fs", args: { path: "a.txt" } },
        { name: "fs", args: { path: "b.txt" } },
        { name: "fs", args: { path: "c.txt" } },
      ],
    });
    expect(auditRoleRun(DEPARTMENTS.worker!, r).violations.some((x) => x.code === "ROLE_STEP_REPETITION")).toBe(false);
  });

  it("honours a custom maxIdenticalCalls threshold", () => {
    const spec: RoleSpec = { name: "w", goal: "g", maxIdenticalCalls: 5 };
    expect(auditRoleRun(spec, repeatCalls("fs", { p: 1 }, 4)).ok).toBe(true);
    expect(auditRoleRun(spec, repeatCalls("fs", { p: 1 }, 5)).violations).toHaveLength(1);
  });

  it("flags output missing required fields (FM-1.1 违反任务规格)", () => {
    const audit = auditRoleRun(DEPARTMENTS.reviewer!, result('{"verdict":"accept"}', ["fs"]));
    expect(audit.violations.some((x) => x.code === "ROLE_OUTPUT_SCHEMA")).toBe(true);
  });

  it("flags a run that produced no JSON at all (FM-1.1)", () => {
    const audit = auditRoleRun(DEPARTMENTS.planner!, result("我认为这个问题需要更多信息。"));
    expect(audit.violations.some((x) => x.code === "ROLE_MISSING_JSON")).toBe(true);
  });

  it("reads JSON out of a fenced block instead of failing the model on formatting", () => {
    const answer = '```json\n{"status":"done","summary":"改好了"}\n```';
    const audit = auditRoleRun(DEPARTMENTS.worker!, result(answer));
    expect(audit.ok).toBe(true);
    expect(audit.parsedOutput).toEqual({ status: "done", summary: "改好了" });
  });

  it("flags an empty answer even when the process exited 0 (FM-1.4 丢失上下文)", () => {
    // 这条正是「失败被上报为成功」的另一张脸：退出码干净，但答案什么都没有。
    const audit = auditRoleRun(DEPARTMENTS.worker!, result("   "));
    const v = audit.violations.find((x) => x.code === "ROLE_EMPTY_OUTPUT");
    expect(v).toBeDefined();
    expect(v!.evidence).toContain("exit=0");
  });

  it("survives unserializable tool arguments instead of throwing", () => {
    const cyclic: Record<string, unknown> = { name: "bash" };
    cyclic.self = cyclic;
    const r = result("x", [], { toolCalls: [{ name: "bash", args: cyclic }] });
    expect(() => auditRoleRun(DEPARTMENTS.worker!, r)).not.toThrow();
  });

  it("reports schema keys it could not enforce", () => {
    const spec: RoleSpec = {
      name: "w",
      goal: "g",
      outputSchema: { type: "object", anyOf: [{ type: "object" }] },
    };
    const audit = auditRoleRun(spec, result("{}"));
    expect(audit.unsupportedSchemaKeys).toContain("anyOf");
  });
});

describe("DEPARTMENTS", () => {
  it("ships four usable departments and every one is self-consistent", () => {
    expect(Object.keys(DEPARTMENTS).sort()).toEqual(["planner", "reviewer", "synthesizer", "worker"]);
    for (const [name, spec] of Object.entries(DEPARTMENTS)) {
      expect(validateRoleSpec(spec), `preset "${name}" must be valid`).toEqual([]);
      expect(spec.name).toBe(name);
    }
  });

  it("keeps the reviewer read-only so verification stays independent (FM-3.3)", () => {
    expect(DEPARTMENTS.reviewer!.forbiddenTools).toContain("str-replace-editor");
  });

  it("returns undefined for an unknown department instead of falling back silently", () => {
    expect(getDepartment("wizard")).toBeUndefined();
    expect(getDepartment("worker")).toBe(DEPARTMENTS.worker);
  });
});
