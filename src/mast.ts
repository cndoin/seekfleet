// mast.ts — 失败归因：把一次失败的轨迹打到 MAST 的 14 种失败模式里。
//
// 出处：Cemri et al., "Why Do Multi-Agent LLM Systems Fail?" arXiv:2503.13657
// (UC Berkeley, 2025)。作者标注了 200+ 条真实多 agent 轨迹，标注者一致性
// κ=0.88，得到 14 种模式，归为三类：
//
//   系统设计问题 44.2%  |  agent 间失配 32.3%  |  任务验证与终止 ~23%
//
// **这份分类器是启发式的，不是真值。**
// 它读的是事后留下的客观痕迹（退出码、工具调用序列、答案长度、校验报告），
// 而不是 agent 的内心独白。每条信号都带 confidence 与 evidence：
//   confidence >= 0.7  有硬证据，可以直接去查
//   0.4 - 0.7          间接推断，用来排优先级
//   < 0.4              弱提示，别拿它当结论
// 用途是「先查哪一个」，不是「判谁的锅」。任何一条都应该拿 evidence 回去核对。

export type MastCategory = "system-design" | "inter-agent" | "verification";

export type MastCode =
  | "FM-1.1"
  | "FM-1.2"
  | "FM-1.3"
  | "FM-1.4"
  | "FM-1.5"
  | "FM-2.1"
  | "FM-2.2"
  | "FM-2.3"
  | "FM-2.4"
  | "FM-2.5"
  | "FM-2.6"
  | "FM-3.1"
  | "FM-3.2"
  | "FM-3.3";

export interface MastMode {
  code: MastCode;
  label: string;
  labelZh: string;
  category: MastCategory;
  /** 典型成因 */
  cause: string;
  /** 对应的结构级修法 —— 归因的最后一步必须是改结构，否则白归 */
  fix: string;
}

export const MAST_MODES: readonly MastMode[] = [
  // ---- 系统设计问题 (44.2%) ----
  {
    code: "FM-1.1",
    label: "Disobey task specification",
    labelZh: "违反任务规格",
    category: "system-design",
    cause: "任务的输入输出约定只写在自然语言里，没落成可校验的 schema。",
    fix: "给任务加 outputSchema，交不出合规 JSON 就是失败。",
  },
  {
    code: "FM-1.2",
    label: "Disobey role specification",
    labelZh: "违反角色设定",
    category: "system-design",
    cause: "角色的工具边界只是建议，没有执行时/事后检查。",
    fix: "用 RoleSpec 的 allowedTools/forbiddenTools，并在审计里核对调用记录。",
  },
  {
    code: "FM-1.3",
    label: "Step repetition",
    labelZh: "步骤重复",
    category: "system-design",
    cause: "没有步数上限，agent 在同一处反复重试到超时。",
    fix: "设 maxToolCalls + maxIdenticalCalls，重复即判失败而不是继续烧 token。",
  },
  {
    code: "FM-1.4",
    label: "Loss of conversation history",
    labelZh: "丢失对话历史",
    category: "system-design",
    cause: "上下文被压缩/截断/单开新会话，导致结论丢失。",
    fix: "产物写外部存储；交接只传结论不传上下文；交接后强制校验非空。",
  },
  {
    code: "FM-1.5",
    label: "Unaware of termination conditions",
    labelZh: "不清楚终止条件",
    category: "system-design",
    cause: "任务没写「什么时候算完」，agent 只能靠自己猜什么时候停。",
    fix: "RoleSpec.stopCondition 必写 + maxToolCalls 硬上限。",
  },

  // ---- agent 间失配 (32.3%) ----
  {
    code: "FM-2.1",
    label: "Conversation reset",
    labelZh: "对话重置",
    category: "inter-agent",
    cause: "子 agent 意外重开会话，之前谈好的东西全丢。",
    fix: "会话状态外部化；重开后先回放关键结论再继续。",
  },
  {
    code: "FM-2.2",
    label: "Fail to ask for clarification",
    labelZh: "该问清的不问",
    category: "inter-agent",
    cause: "任务本身含糊，而流程里没有「信息不足就停下来问」这一步。",
    fix: "契约里写明：信息不足时返回 blocked 而不是猜着做。",
  },
  {
    code: "FM-2.3",
    label: "Task derailment",
    labelZh: "任务脱轨",
    category: "inter-agent",
    cause: "工作量远超预期的拆分，子 agent 各自往外扩。",
    fix: "effort 预算显式化（MaxToolCalls / thinkingTokenBudget），超预算即报警。",
  },
  {
    code: "FM-2.4",
    label: "Information withholding",
    labelZh: "隐瞒信息",
    category: "inter-agent",
    cause: "上游拿到了关键信息但没往下游传。",
    fix: "交接必须有结构化小结字段，空值不允许交付。",
  },
  {
    code: "FM-2.5",
    label: "Ignored other agents' input",
    labelZh: "无视他人输入",
    category: "inter-agent",
    cause: "下游照着自己的想象做，没读上游给的结论。",
    fix: "把依赖结果注入 prompt；审计时检查下游是否真的读取过。",
  },
  {
    code: "FM-2.6",
    label: "Reasoning-action mismatch",
    labelZh: "推理与行动不匹配",
    category: "inter-agent",
    cause: "结论声称做了某件事，但调用记录里根本没有对应的工具调用。",
    fix: "声称 vs 调用记录交叉校验（answer 动词 vs toolCalls 工具）。",
  },

  // ---- 任务验证与终止 (~23%) ----
  {
    code: "FM-3.1",
    label: "Premature termination",
    labelZh: "过早终止",
    category: "verification",
    cause: "超时/被中断/预算耗尽，任务在半途被切断。",
    fix: "区分「没做完」和「做错了」；前者加预算，后者改结构。",
  },
  {
    code: "FM-3.2",
    label: "No or incomplete verification",
    labelZh: "无验证或验证不完整",
    category: "verification",
    cause: "没有独立的验收环节，acceptance 只停留在自我陈述。",
    fix: "用 verifier 跑可执行检查（lint/单测/schema/产物），且必须独立于执行者。",
  },
  {
    code: "FM-3.3",
    label: "Incorrect verification",
    labelZh: "错误验证",
    category: "verification",
    cause: "验证了但验证本身是假的——规则没生效却报了通过。",
    fix: "校验器对不支持的约束必须上报（unsupported / unknownKinds），不静默跳过。",
  },
] as const;

const MODE_BY_CODE = new Map<MastCode, MastMode>(MAST_MODES.map((m) => [m.code, m]));

export function getMode(code: MastCode): MastMode {
  const mode = MODE_BY_CODE.get(code);
  if (!mode) throw new Error("mast: unknown failure mode " + code);
  return mode;
}

/** 归因输入。刻意只收客观痕迹，避免让分类器去猜语义。 */
export interface TraceView {
  task?: string;
  roleName?: string;
  answer?: string;
  exitCode?: number | null;
  aborted?: boolean;
  /** 错误码，例如 summarize() 产出的 EXIT_NONZERO / ABORTED。 */
  errorCode?: string;
  /** [工具名, 参数指纹] 序列；传字符串时退化为工具名。 */
  toolCalls?: Array<{ name: string; args?: unknown } | string>;
  toolResults?: Array<{ name: string; ok: boolean }>;
  durationMs?: number;
  /** 任务是否声明了工具调用上限（来自 RoleSpec.maxToolCalls）。 */
  declaredMaxToolCalls?: number;
  /** 预期产物（检查 FM-2.6 时会用到）。 */
  expectedArtifacts?: string[];
  /** 是否向上游要过 / 拿到过依赖结论（DAG 场景）。 */
  upstream?: Array<{ id: string; answer?: string; status?: string }>;
  /** 是否把上游结论注入了本次 prompt。 */
  dependencyResultsInjected?: boolean;
  /** 独立验证层的报告。用最小结构，避免和 verifier 模块互相依赖。 */
  verification?: {
    ok: boolean;
    unknownKinds?: string[];
    checks?: Array<{ kind?: string; ok: boolean; detail?: string }>;
  };
  /** 角色契约审计结果。 */
  roleAudit?: {
    ok: boolean;
    violations: Array<{ code: string; message: string; evidence?: string }>;
  };
}

export interface FailureSignal {
  code: MastCode;
  category: MastCategory;
  labelZh: string;
  /** 0-1。越高越值得先查。 */
  confidence: number;
  /** 触发这条判断的客观证据，必须能在日志里被复核。 */
  evidence: string;
  fix: string;
}

export interface FailureAttribution {
  /** 没有检出任何失败信号时为 true。 */
  ok: boolean;
  signals: FailureSignal[];
  /** 置信度最高的那条。 */
  primary?: FailureSignal;
  categoryCounts: Record<MastCategory, number>;
}

function toolName(call: { name: string; args?: unknown } | string): string {
  return typeof call === "string" ? call : call.name;
}

function callFingerprint(call: { name: string; args?: unknown } | string): string {
  if (typeof call === "string") return call;
  let args: string;
  try {
    args = JSON.stringify(call.args ?? null);
  } catch {
    args = "<unserializable>";
  }
  return call.name + "|" + args;
}

/** 有副作用的工具——动过它们却不做验证，是 FM-3.2 的温床。 */
const SIDE_EFFECT_TOOLS = new Set(["bash", "pwsh", "fs", "str-replace-editor", "web"]);

function signal(code: MastCode, confidence: number, evidence: string): FailureSignal {
  const mode = getMode(code);
  return { code, category: mode.category, labelZh: mode.labelZh, confidence, evidence, fix: mode.fix };
}

const EMPTY_COUNTS = (): Record<MastCategory, number> => ({
  "system-design": 0,
  "inter-agent": 0,
  verification: 0,
});

/**
 * 对单条轨迹做归因。
 *
 * 返回的 signals 按置信度降序。`ok:true` 只代表「没找到痕迹」，
 * **不代表这次运行一定没问题** —— 证据不足和没有问题不是一回事。
 */
export function classifyTrace(view: TraceView): FailureAttribution {
  const signals: FailureSignal[] = [];
  const answer = (view.answer ?? "").trim();
  const calls = view.toolCalls ?? [];
  const callNames = calls.map(toolName).filter((n) => typeof n === "string" && n.length > 0);
  const fingerprints = calls.map(callFingerprint);

  // ---------- 优先采纳「已经由代码判定」的硬结论 ----------
  if (view.roleAudit && !view.roleAudit.ok) {
    for (const v of view.roleAudit.violations) {
      switch (v.code) {
        case "ROLE_OUTPUT_SCHEMA":
        case "ROLE_MISSING_JSON":
          signals.push(signal("FM-1.1", 0.85, v.evidence ?? v.message));
          break;
        case "ROLE_TOOL_NOT_ALLOWED":
        case "ROLE_TOOL_FORBIDDEN":
          signals.push(signal("FM-1.2", 0.85, v.evidence ?? v.message));
          break;
        case "ROLE_STEP_REPETITION":
          signals.push(signal("FM-1.3", 0.8, v.evidence ?? v.message));
          break;
        case "ROLE_MAX_TOOL_CALLS":
          signals.push(signal("FM-1.5", 0.75, v.evidence ?? v.message));
          break;
        case "ROLE_EMPTY_OUTPUT":
          signals.push(signal("FM-1.4", 0.7, v.evidence ?? v.message));
          break;
        default:
          break;
      }
    }
  }

  // ---------- FM-3.1 过早终止：被中断而不是做错 ----------
  if (view.aborted === true || view.errorCode === "ABORTED") {
    signals.push(
      signal(
        "FM-3.1",
        0.8,
        "aborted/timeout after " + callNames.length + " tool calls, durationMs=" + (view.durationMs ?? "?"),
      ),
    );
  }

  // ---------- FM-1.3 步骤重复（即使没有 role 契约也能独立检出） ----------
  if (!view.roleAudit) {
    const counts = new Map<string, number>();
    for (const fp of fingerprints) counts.set(fp, (counts.get(fp) ?? 0) + 1);
    const worst = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] >= 3) {
      signals.push(signal("FM-1.3", 0.7, worst[1] + "× " + worst[0].slice(0, 160)));
    }
  }

  // ---------- FM-1.5 不清楚终止条件：远超声明预算 ----------
  if (view.declaredMaxToolCalls !== undefined && callNames.length > view.declaredMaxToolCalls) {
    signals.push(signal("FM-1.5", 0.75, `${callNames.length} calls vs declared max ${view.declaredMaxToolCalls}`));
  }

  // ---------- FM-1.4 丢失上下文：干了活却交不出东西 ----------
  if (answer.length === 0 && callNames.length > 0 && view.aborted !== true) {
    signals.push(signal("FM-1.4", 0.7, `${callNames.length} tool calls produced an empty answer`));
  }

  // ---------- FM-3.2 / FM-3.3：验证层的三种状态 ----------
  if (view.verification) {
    if (view.verification.ok === false) {
      const failed = (view.verification.checks ?? [])
        .filter((c) => !c.ok)
        .map((c) => (c.kind ?? "check") + ": " + (c.detail ?? "failed"))
        .slice(0, 3);
      signals.push(signal("FM-3.2", 0.85, failed.length > 0 ? failed.join(" ; ") : "verification reported failure"));
    }
    if (view.verification.unknownKinds && view.verification.unknownKinds.length > 0) {
      signals.push(signal("FM-3.3", 0.7, "rules that did NOT execute: " + view.verification.unknownKinds.join(",")));
    }
    // 通过了但某条 check 自己声明「部分约束没生效」—— 通过是有水分的。
    const soft = (view.verification.checks ?? []).find((c) => c.ok && (c.detail ?? "").includes("NOT enforced"));
    if (soft) signals.push(signal("FM-3.3", 0.5, soft.detail ?? "some constraints were not enforced"));
  } else if (callNames.some((n) => SIDE_EFFECT_TOOLS.has(n)) && answer.length > 0) {
    // 动了文件系统/命令行却完全没有验收环节。
    signals.push(
      signal(
        "FM-3.2",
        0.55,
        "ran side-effect tools [" +
          callNames.filter((n) => SIDE_EFFECT_TOOLS.has(n)).join(",") +
          "] with no verification configured",
      ),
    );
  }

  // ---------- FM-2.6 推理与行动不匹配：声称改了东西但没调用对应工具 ----------
  const claimedWrites = /已?(修改|创建|写入|写入文件|更新了|生成了)|created|wrote|updated|modified/i.test(answer);
  if (claimedWrites && !callNames.some((n) => SIDE_EFFECT_TOOLS.has(n))) {
    signals.push(signal("FM-2.6", 0.5, "answer claims a write happened but no side-effect tool was called"));
  }

  // ---------- FM-2.5 无视他人输入：上游给了东西却没读 ----------
  const usableUpstream = (view.upstream ?? []).filter((u) => (u.answer ?? "").trim().length > 0);
  if (view.dependencyResultsInjected && usableUpstream.length > 0) {
    const referenced = usableUpstream.some((u) => answer.includes(u.id));
    if (!referenced) {
      signals.push(
        signal(
          "FM-2.5",
          0.45,
          "dependency results were injected but no upstream id (" +
            usableUpstream.map((u) => u.id).join(",") +
            ") appears in the answer",
        ),
      );
    }
  }

  // ---------- FM-2.4 隐瞒信息：上游有结论，本节点却交空 ----------
  if (usableUpstream.length > 0 && answer.length === 0) {
    signals.push(signal("FM-2.4", 0.5, "upstream delivered results but this node produced nothing downstream"));
  }

  // ---------- FM-2.2 该问清的不问：任务含糊且毫无动作 ----------
  const ambiguous = /\?|？|待定|或者|不确定|maybe|either|TBD/i.test(view.task ?? "");
  if (ambiguous && callNames.length === 0 && answer.length > 0) {
    signals.push(signal("FM-2.2", 0.4, "task looks ambiguous and no tool was called before answering"));
  }

  // ---------- FM-2.3 任务脱轨：步数爆量 ----------
  if (view.declaredMaxToolCalls !== undefined && view.declaredMaxToolCalls > 0) {
    const ratio = callNames.length / view.declaredMaxToolCalls;
    if (ratio >= 2)
      signals.push(signal("FM-2.3", 0.5, `${callNames.length} calls = ${ratio.toFixed(1)}× the declared budget`));
  }

  // ---------- FM-2.1 对话重置：中途被杀且毫无输出（区别于超时） ----------
  if (view.errorCode === "EXIT_NONZERO" && answer.length === 0 && callNames.length === 0) {
    signals.push(
      signal("FM-2.1", 0.45, "process exited non-zero before emitting anything (exit=" + view.exitCode + ")"),
    );
  }

  signals.sort((a, b) => b.confidence - a.confidence);
  const categoryCounts = EMPTY_COUNTS();
  for (const s of signals) categoryCounts[s.category]++;
  return {
    ok: signals.length === 0,
    signals,
    primary: signals[0],
    categoryCounts,
  };
}

export interface MastReportRow {
  code: MastCode;
  labelZh: string;
  category: MastCategory;
  count: number;
  share: number;
  fix: string;
}

export interface MastReport {
  /** 参与统计的轨迹数（含成功的）。 */
  totalTraces: number;
  /** 至少命中一条失败模式的轨迹数。 */
  failedTraces: number;
  failureRate: number;
  byCategory: Array<{ category: MastCategory; count: number; share: number }>;
  rows: MastReportRow[];
  /** 按「命中次数」排序，给出最值得先改的结构点。 */
  priorities: MastReportRow[];
}

/**
 * 批量聚合：回答「这批任务到底在哪一类上最吃亏」。
 *
 * 参考 MAST 的公开数据做对照（system-design 44.2% / inter-agent 32.3% /
 * verification ~23%）。如果你的分布明显偏向某一类，那就是结构问题，
 * 不是模型问题，换模型是浪费钱。
 */
export function aggregateFailures(list: Iterable<FailureAttribution>): MastReport {
  const counts = new Map<MastCode, number>();
  let total = 0;
  let failed = 0;
  const catCounts = EMPTY_COUNTS();

  for (const a of list) {
    total++;
    if (a.signals.length === 0) continue;
    failed++;
    for (const s of a.signals) {
      counts.set(s.code, (counts.get(s.code) ?? 0) + 1);
      catCounts[s.category] += 1;
    }
  }

  const rows: MastReportRow[] = Array.from(counts.entries())
    .map(([code, count]) => {
      const mode = getMode(code);
      return {
        code,
        labelZh: mode.labelZh,
        category: mode.category,
        count,
        share: failed > 0 ? count / failed : 0,
        fix: mode.fix,
      };
    })
    .sort((a, b) => b.count - a.count);

  const catTotal = catCounts["system-design"] + catCounts["inter-agent"] + catCounts.verification;
  const byCategory = (["system-design", "inter-agent", "verification"] as MastCategory[]).map((category) => ({
    category,
    count: catCounts[category],
    share: catTotal > 0 ? catCounts[category] / catTotal : 0,
  }));

  return {
    totalTraces: total,
    failedTraces: failed,
    failureRate: total > 0 ? failed / total : 0,
    byCategory,
    rows,
    priorities: [...rows],
  };
}

/** MAST 论文给出的基准分布，用于和自己的数据对照。 */
export const MAST_BASELINE = {
  "system-design": 0.442,
  "inter-agent": 0.323,
  verification: 0.235,
} as const;

/** 人类可读的单条归因，用于 CLI / MCP 的 text 输出。 */
export function formatAttribution(a: FailureAttribution): string {
  if (a.ok) return "no failure signal detected (note: absence of evidence, not evidence of absence)";
  const lines = a.signals.map(
    (s) =>
      `${s.code} [${s.category}] ${s.labelZh} — confidence ${s.confidence.toFixed(2)}\n    evidence: ${s.evidence}\n    fix: ${s.fix}`,
  );
  if (a.primary) lines.unshift("primary: " + a.primary.code + " " + a.primary.labelZh);
  return lines.join("\n");
}
