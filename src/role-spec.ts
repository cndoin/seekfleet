// role-spec.ts — 角色契约（Role Contract）。
//
// 为什么要有这块：Berkeley 的 MAST 研究（arXiv:2503.13657）对 200+ 条多
// agent 执行轨迹做了人工标注，失败率在 40%–90% 之间，其中**系统设计类占
// 44.2%**——违反任务规格 11.8%、步骤重复 15.7%、不清楚终止条件 12.4%。
// 注意：这些跟模型聪不聪明没关系，跟「这个 agent 到底被告知了什么」有关系。
// 换更强的模型救不了它们。
//
// 本模块把「部门 / 角色」从一句 `--profile xxx` 变成一个**可执行、可校验的
// 契约对象**：
//   - 目标与边界写进 prompt（不是靠 prompt 自觉，而是由代码生成固定格式）
//   - 允许/禁止的工具、步数上限 —— 事后用 DshResult 的审计数据核对
//   - 输出 JSON Schema —— 事后用 json-schema.ts 校验，不合规就是失败
//
// 如果一个角色什么都不约束（没有 schema、没有工具白名单、没有终止条件），
// 建立它就没有意义。`validateRoleSpec` 会直接拒绝这种空壳角色。

import { checkSchema, extractJson, type JsonSchema } from "./json-schema.js";
import type { DshResult, DshToolInvocation } from "./types.js";

export interface RoleSpec {
  /** 角色名，例如 "reviewer"。会写进 prompt，也用于日志归因。 */
  name: string;
  /** 一句话目标。写进 prompt 的第一行。 */
  goal: string;
  /** 允许的工具白名单。空/未定义 = 不限制。 */
  allowedTools?: string[];
  /** 禁止的工具。命中即违规，优先级高于 allowedTools。 */
  forbiddenTools?: string[];
  /** 输出必须满足的 JSON Schema。校验失败 = 任务失败（而不是警告）。 */
  outputSchema?: JsonSchema;
  /** 何时停下。MAST 里「不清楚终止条件」占 12.4%，这一行是专门针对它的。 */
  stopCondition?: string;
  /** 工具调用次数上限。专门针对 MAST 里 15.7% 的「步骤重复」。 */
  maxToolCalls?: number;
  /** 同一 工具+参数 组合允许的最大重复次数（默认 3，超过判为步骤重复）。 */
  maxIdenticalCalls?: number;
  /** 必须出现在最终回答里的产物描述（文件路径、结论项……）。 */
  deliverables?: string[];
  /** 该角色被禁止做的事，写进 prompt 的 <forbidden> 段。 */
  constraints?: string[];
  /** 本角色建议的工作量档位，用于上层决定开几个并行实例。 */
  effort?: "low" | "medium" | "high";
}

/**
 * 内置「部门」预设。
 *
 * 这套组合对应 Anthropic 在生产里验证过的 orchestrator-worker 形态：
 * planner 拆 -> worker 并行做 -> reviewer 独立验收 -> synthesizer 汇总。
 * 关键点是 **reviewer 不和 worker 共享上下文**，否则交叉污染会让验收变成自我
 * 肯定（MAST 里 FM-3.3「错误验证」的典型来源）。
 */
export const DEPARTMENTS: Record<string, RoleSpec> = {
  planner: {
    name: "planner",
    goal: "把用户的目标拆成一组互不重叠、可并行的最小子任务，并返回结构化计划。",
    stopCondition: "计划已列出，且每个子任务的输入来源与验收标准都写清楚了，立即停止，不要自己执行任何子任务。",
    maxToolCalls: 20,
    allowedTools: ["fs", "fs-search", "web-search"],
    forbiddenTools: ["str-replace-editor", "bash", "pwsh"],
    constraints: [
      "只做规划，绝不执行子任务本身。",
      "子任务之间不得有重复的范围（重复会浪费额度并产生互相矛盾的产物）。",
      "串行依赖的任务不要用并行拆分来糊弄。",
    ],
    deliverables: ["每个子任务的 title / goal / dependsOn / acceptance"],
    outputSchema: {
      type: "object",
      required: ["subtasks"],
      properties: {
        subtasks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "goal", "acceptance"],
            properties: {
              id: { type: "string", minLength: 1 },
              goal: { type: "string", minLength: 1 },
              dependsOn: { type: "array", items: { type: "string" } },
              acceptance: { type: "string", minLength: 1 },
              parallel: { type: "boolean" },
            },
          },
        },
        notes: { type: "string" },
      },
    },
    effort: "low",
  },

  worker: {
    name: "worker",
    goal: "完成分配到的单个子任务，只对这个子任务负责。",
    stopCondition: "子任务的验收标准被满足后就停止；不要顺手改范围外的东西，也不要替别的子任务做决定。",
    maxToolCalls: 60,
    deliverables: ["对验收标准的逐条回应"],
    constraints: [
      "范围外的文件不要改动。",
      "拿不准的时候停下来说明缺什么信息，而不是猜。",
      "完成前自己先核对一遍验收标准。",
    ],
    outputSchema: {
      type: "object",
      required: ["status", "summary"],
      properties: {
        status: { type: "string", enum: ["done", "blocked", "partial"] },
        summary: { type: "string", minLength: 1 },
        artifacts: { type: "array", items: { type: "string" } },
        blockers: { type: "array", items: { type: "string" } },
      },
    },
    effort: "medium",
  },

  reviewer: {
    name: "reviewer",
    goal: "独立验收 worker 的产物，只根据可执行的证据下结论，不采信 worker 的自我陈述。",
    stopCondition: "给出 verdict 后立即停止。你没有权限修改产物——发现问题就退回，不要自己修。",
    maxToolCalls: 30,
    allowedTools: ["fs", "fs-search", "bash", "pwsh"],
    forbiddenTools: ["str-replace-editor"],
    constraints: [
      "不要修改被审查的文件（你自己动手改就等于替 worker 掩盖问题）。",
      "每一条『通过』都必须对应一个实际执行过的检查命令/断言；没有证据就是 unverified。",
      "发现任何一项不合格，verdict 就是 reject，不接受『基本通过』。",
    ],
    deliverables: ["逐条 acceptance 的裁定 + 证据"],
    outputSchema: {
      type: "object",
      required: ["verdict", "checks"],
      properties: {
        verdict: { type: "string", enum: ["accept", "reject"] },
        checks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["acceptance", "passed", "evidence"],
            properties: {
              acceptance: { type: "string", minLength: 1 },
              passed: { type: "boolean" },
              evidence: { type: "string", minLength: 1 },
            },
          },
        },
        notes: { type: "string" },
      },
    },
    effort: "medium",
  },

  synthesizer: {
    name: "synthesizer",
    goal: "把多个分支的结果压缩成一份对用户有价值的结论，丢弃过程噪声。",
    stopCondition: "结论已完整覆盖上游产物的关键点后立即停止，不要再开新的探索。",
    maxToolCalls: 20,
    forbiddenTools: ["bash", "pwsh", "str-replace-editor"],
    constraints: [
      "摘要而不是复述：不要把所有分支原文拼在一起。",
      "上游互相矛盾时明确标注矛盾点，不要私自选一个。",
      "不引用任何上游分支里没有的证据。",
    ],
    outputSchema: {
      type: "object",
      required: ["answer"],
      properties: {
        answer: { type: "string", minLength: 1 },
        sources: { type: "array", items: { type: "string" } },
        conflicts: { type: "array", items: { type: "string" } },
      },
    },
    effort: "low",
  },
};

/** 违规项。每条都带 code（供程序分支）和 evidence（供人看）。 */
export interface RoleViolation {
  code:
    | "ROLE_TOOL_NOT_ALLOWED"
    | "ROLE_TOOL_FORBIDDEN"
    | "ROLE_MAX_TOOL_CALLS"
    | "ROLE_STEP_REPETITION"
    | "ROLE_OUTPUT_SCHEMA"
    | "ROLE_EMPTY_OUTPUT"
    | "ROLE_MISSING_JSON";
  message: string;
  evidence?: string;
}

export interface RoleAudit {
  role: string;
  ok: boolean;
  violations: RoleViolation[];
  /** 结果里的 JSON 对象（若 role 声明了 outputSchema 且成功解析）。 */
  parsedOutput?: unknown;
  /** Schema 里存在但本校验器不认识的约束 —— 这些规则实际没生效。 */
  unsupportedSchemaKeys?: string[];
  toolCalls: number;
}

/**
 * 拒绝空壳角色。
 *
 * 一个没有 schema、没有工具边界、没有终止条件的「部门」，除了给 prompt 多加
 * 一点词之外没有任何约束力；把它当成角色用，是 MAST 里「违反角色设定」的
 * 主要来源。返回错误列表，空数组表示可投入使用。
 */
export function validateRoleSpec(spec: RoleSpec): string[] {
  const problems: string[] = [];
  if (!spec.name.trim()) problems.push("role.name must not be empty");
  if (!spec.goal.trim()) problems.push("role.goal must not be empty");
  if (spec.maxToolCalls !== undefined && (!Number.isFinite(spec.maxToolCalls) || spec.maxToolCalls < 1)) {
    problems.push("role.maxToolCalls must be a positive number");
  }
  if (
    spec.maxIdenticalCalls !== undefined &&
    (!Number.isFinite(spec.maxIdenticalCalls) || spec.maxIdenticalCalls < 1)
  ) {
    problems.push("role.maxIdenticalCalls must be a positive number");
  }
  if (spec.allowedTools && spec.forbiddenTools) {
    const overlap = spec.allowedTools.filter((t) => spec.forbiddenTools!.includes(t));
    if (overlap.length > 0)
      problems.push("role: tools listed in both allowedTools and forbiddenTools: " + overlap.join(","));
  }
  return problems;
}

const ROLE_MARKER = "<role-contract>";

/** True when `text` already carries a compiled contract (avoids double injection). */
export function hasRoleContract(text: string): boolean {
  return text.includes(ROLE_MARKER);
}

/**
 * 把角色契约编译成一段固定格式的 XML，拼到任务前面。
 *
 * 用 XML 标签而不是自然语言段是有意的：附录/contract 边界在不同模型上的遵循
 * 率比纯散文高，而且机器可解析——出问题时可以直接 grep 出边界在哪。
 */
export function compileRoleContract(spec: RoleSpec): string {
  const lines: string[] = [];
  lines.push(ROLE_MARKER);
  lines.push("  <name>" + spec.name + "</name>");
  lines.push("  <goal>" + spec.goal + "</goal>");
  if (spec.stopCondition) {
    // MAST: 不清楚终止条件 = 12.4% 的失败。这一行必须存在，默认不写。
    lines.push("  <stop-when>" + spec.stopCondition + "</stop-when>");
  } else {
    lines.push("  <stop-when>目标达成后立即停止，不要追加额外工作。</stop-when>");
  }
  if (spec.allowedTools?.length) {
    lines.push("  <allowed-tools>" + spec.allowedTools.join(", ") + "</allowed-tools>");
  }
  if (spec.forbiddenTools?.length) {
    lines.push("  <forbidden-tools>" + spec.forbiddenTools.join(", ") + "</forbidden-tools>");
  }
  if (spec.maxToolCalls !== undefined) {
    lines.push("  <max-tool-calls>" + spec.maxToolCalls + "</max-tool-calls>");
  }
  for (const c of spec.constraints ?? []) lines.push("  <constraint>" + c + "</constraint>");
  if (spec.deliverables?.length) {
    lines.push("  <deliverables>");
    for (const d of spec.deliverables) lines.push("    <item>" + d + "</item>");
    lines.push("  </deliverables>");
  }
  if (spec.outputSchema) {
    lines.push("  <output-format>只返回一段 JSON，不要包 markdown 围栏，不要加解释。Schema：");
    lines.push(JSON.stringify(spec.outputSchema));
    lines.push("  </output-format>");
  }
  lines.push("</role-contract>");
  return lines.join("\n");
}

/** 把 contract 拼到任务正文前面。已带 contract 的任务不会被重复注入。 */
export function attachRoleContract(task: string, spec: RoleSpec): string {
  if (hasRoleContract(task)) return task;
  return compileRoleContract(spec) + "\n\n" + task;
}

/** 工具调用的重复指纹：工具名 + 稳定化的参数。 */
function callFingerprint(call: DshToolInvocation): string {
  let args: string;
  try {
    args = JSON.stringify(call.args ?? null);
  } catch {
    // 循环引用的参数是子 agent 传错东西的信号，不能让异常把整次审计带崩。
    args = "<unserializable>";
  }
  return call.name + "|" + args;
}

/**
 * 事后审计：拿 DshResult 的调用记录核对契约。
 *
 * 这里的每一项都对应 MAST 里一个具体的失败模式，见注释。
 */
export function auditRoleRun(spec: RoleSpec, result: DshResult): RoleAudit {
  const violations: RoleViolation[] = [];
  const calls = result.toolCalls ?? [];

  // FM-1.2 违反角色设定 —— 用了契约外的工具 / 用了明令禁止的工具。
  if (spec.allowedTools?.length) {
    const used: string[] = [];
    for (const c of calls) {
      if (c.name && !spec.allowedTools.includes(c.name) && !used.includes(c.name)) used.push(c.name);
    }
    if (used.length > 0) {
      violations.push({
        code: "ROLE_TOOL_NOT_ALLOWED",
        message: "角色 " + spec.name + " 使用了白名单外的工具",
        evidence: used.join(", "),
      });
    }
  }
  if (spec.forbiddenTools?.length) {
    const used: string[] = [];
    for (const c of calls) {
      if (c.name && spec.forbiddenTools.includes(c.name) && !used.includes(c.name)) used.push(c.name);
    }
    if (used.length > 0) {
      violations.push({
        code: "ROLE_TOOL_FORBIDDEN",
        message: "角色 " + spec.name + " 使用了被禁止的工具",
        evidence: used.join(", "),
      });
    }
  }

  // FM-1.5 不清楚终止条件 —— 步数超过上限还在跑。
  if (spec.maxToolCalls !== undefined && calls.length > spec.maxToolCalls) {
    violations.push({
      code: "ROLE_MAX_TOOL_CALLS",
      message: "工具调用 " + calls.length + " 次，超过契约上限 " + spec.maxToolCalls,
      evidence: "calls=" + calls.length,
    });
  }

  // FM-1.3 步骤重复（MAST 里单条最高，15.7%）—— 同一个 工具+参数 反复调用。
  const limit = spec.maxIdenticalCalls ?? 3;
  const counts = new Map<string, number>();
  for (const c of calls) {
    const fp = callFingerprint(c);
    counts.set(fp, (counts.get(fp) ?? 0) + 1);
  }
  const repeated = Array.from(counts.entries())
    .filter(([, n]) => n >= limit)
    .sort((a, b) => b[1] - a[1]);
  if (repeated.length > 0) {
    violations.push({
      code: "ROLE_STEP_REPETITION",
      message: "存在重复的工具调用组合（同一 工具+参数 ≥ " + limit + " 次）",
      evidence: repeated.map(([fp, n]) => n + "× " + fp.slice(0, 160)).join(" ; "),
    });
  }

  let parsedOutput: unknown;
  let unsupportedSchemaKeys: string[] | undefined;

  // FM-1.1 违反任务规格 —— 声明了输出 schema 却交不出合规 JSON。
  if (spec.outputSchema) {
    const extracted = extractJson(result.answer ?? "");
    if (extracted === undefined) {
      violations.push({
        code: "ROLE_MISSING_JSON",
        message: "角色 " + spec.name + " 要求结构化输出，但回答里解析不出 JSON",
        evidence: (result.answer ?? "").slice(0, 200),
      });
    } else {
      const check = checkSchema(spec.outputSchema, extracted);
      parsedOutput = extracted;
      unsupportedSchemaKeys = check.unsupported.length > 0 ? check.unsupported : undefined;
      if (!check.ok) {
        violations.push({
          code: "ROLE_OUTPUT_SCHEMA",
          message: "输出不符合契约 schema",
          evidence: check.errors.slice(0, 5).join(" ; "),
        });
      }
    }
  }

  const answer = (result.answer ?? "").trim();
  if (answer.length === 0) {
    // 没有答案 = 交接时信息全丢。上游 DAG 节点会收到一个空字符串还以为成功了。
    violations.push({
      code: "ROLE_EMPTY_OUTPUT",
      message: "没有产出任何回答",
      evidence: result.error?.message ?? "exit=" + result.exitCode,
    });
  }

  return {
    role: spec.name,
    ok: violations.length === 0,
    violations,
    parsedOutput,
    unsupportedSchemaKeys,
    toolCalls: calls.length,
  };
}

/**
 * 按名字取内置部门；找不到时返回 undefined（**不要**静默回退到某个默认角色，
 * 那会让调用方以为它拿到了一个规划专家，其实是另一个东西）。
 */
export function getDepartment(name: string): RoleSpec | undefined {
  return DEPARTMENTS[name];
}
