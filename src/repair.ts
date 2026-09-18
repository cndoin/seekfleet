// 自纠错引擎：把「验收失败」变成「带证据再来一轮」，而不是把它变成一句报错。
//
// 为什么需要这一层：验证层（verifier）和角色契约（role-spec）能告诉你这一轮没做成，
// 但它们不改变结果 —— 任务照样失败。而绝大多数 agent 编排框架的做法是把失败抛给调用方，
// 于是「多 agent 系统 40%~90% 的失败率」有相当一部分本来是可以在闭环里自愈的。
//
// 但自纠错最容易做坏的地方是：**无脑重试**。LLM 的失败不是随机的，同一份 prompt、
// 同一个坏规格，重跑大概率得到同一个错误 —— 那只是把成本乘以 N。所以这个模块一半的
// 代码是在回答「这次还值不值得再跑一轮」，而不是怎么重试。
//
// 三条硬规则：
//   1. **没有客观判据不重试**。验收都没跑过（既没 verify 也没 role）就说失败了，
//      那是调用方的主观判断，重试没有依据。
//   2. **程序性失败默认不重试**（mode: "governed"）。EXIT_NONZERO / ABORTED /
//      进程崩这类失败是确定性的，第二次通常还是崩。只有「模型做错了但我们知道错在哪」
//      才值得重来 —— 也就是契约违约与验证不通过。
//   3. **指纹无变化即停**。第二轮犯的错和第一轮一模一样（同 code 集合），说明
//      失败源于输入/规格而不是采样噪声，继续跑是在烧钱。这时应该去改结构（见 hint）。

import type { DshResult, DshTask } from "./types.js";

/** 触发自纠错的失败类型。 */
export type RepairMode =
  /** 关闭自纠错（默认）。*/
  | "off"
  /** 只在契约违约 / 验证不通过时重试。这是推荐值。 */
  | "governed"
  /** 连进程崩溃、非零退出也重试。仅在明确知道副作用安全时使用。 */
  | "all";

export interface RepairPolicy {
  enabled: boolean;
  mode: RepairMode;
  /** 追加尝试的次数上限（不含首次尝试）。默认 2。 */
  maxAttempts: number;
  /**
   * 单次重试允许的 token 增长上限，相对首次运行的实际用量。
   * 例如 1.5 表示：首次用了 1000 tokens，任何一轮重试超过 1500 就不再继续。
   */
  maxTokenGrowth: number;
  /** 重试时避开上一次失败的实例。默认 true。 */
  rotateInstance: boolean;
}

/** `DshTask.selfRepair` 接受简写：true 等价于 { mode:"governed", maxAttempts:2 }。 */
export type RepairPolicyInput = boolean | number | Partial<RepairPolicy> | undefined | null;

/** 自纠错尝试上限。再高就是赌博了。 */
export const MAX_REPAIR_ATTEMPTS_HARD_CAP = 5;

/** 回填给模型的历史答案片段长度。太长会把上下文挤爆，太短模型不知道自己上一轮说了什么。 */
const ANSWER_HEAD_CHARS = 1200;
const ANSWER_TAIL_CHARS = 800;

export const DEFAULT_REPAIR_POLICY: RepairPolicy = {
  enabled: false,
  mode: "governed",
  maxAttempts: 2,
  maxTokenGrowth: 1.5,
  rotateInstance: true,
};

/**
 * 归一化策略输入。无法识别的输入按「关闭」处理，而不是猜一个策略出来 ——
 * 悄悄启用自纠错会让成本翻倍而调用方毫不知情。
 */
export function normalizeRepairPolicy(input: RepairPolicyInput): RepairPolicy {
  if (input === undefined || input === null || input === false) return { ...DEFAULT_REPAIR_POLICY, enabled: false };
  if (input === true) return { ...DEFAULT_REPAIR_POLICY, enabled: true };
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return { ...DEFAULT_REPAIR_POLICY, enabled: false };
    return {
      ...DEFAULT_REPAIR_POLICY,
      enabled: true,
      maxAttempts: clampAttempts(Math.floor(input)),
    };
  }
  const maxAttempts = clampAttempts(input.maxAttempts ?? DEFAULT_REPAIR_POLICY.maxAttempts);
  return {
    enabled: input.enabled ?? true,
    mode: input.mode ?? DEFAULT_REPAIR_POLICY.mode,
    maxAttempts,
    maxTokenGrowth:
      input.maxTokenGrowth !== undefined && input.maxTokenGrowth > 0
        ? input.maxTokenGrowth
        : DEFAULT_REPAIR_POLICY.maxTokenGrowth,
    rotateInstance: input.rotateInstance ?? DEFAULT_REPAIR_POLICY.rotateInstance,
  };
}

function clampAttempts(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_REPAIR_ATTEMPTS_HARD_CAP, Math.floor(n));
}

/**
 * 这类失败属于「模型做错了，而且我们知道错在哪」 —— 修复所需的全部信息都在
 * 审计结果里，值得带着证据重来一轮。
 */
const REPAIRABLE_CODES = new Set(["ROLE_CONTRACT_VIOLATION", "VERIFY_FAILED"]);

/** 代码 + 命名，一眼能认出的取值潜在 danger。 */
export function isRepairableFailure(code: string | undefined, mode: RepairMode): boolean {
  if (!code) return false;
  if (mode === "all") return true;
  return REPAIRABLE_CODES.has(code);
}

/** 一次失败观测：自纠错循环真正消费的最小结构。 */
export interface RepairObservation {
  /** 第几次尝试，0 表示首次。 */
  attempt: number;
  result: DshResult;
  errorCode?: string;
  errorMessage?: string;
  /** 违反的契约条款。取自 result.audit.role.violations。 */
  violations: Array<{ code: string; message: string; evidence?: string }>;
  /** 未通过的验收项。取自 result.audit.verification.checks。 */
  failedChecks: Array<{ name: string; kind: string; detail: string }>;
  tokens?: number;
}

export type RepairStopReason =
  | "ok"
  | "policy_disabled"
  | "no_judgement"
  | "not_repairable"
  | "max_attempts"
  | "no_progress"
  | "budget_exceeded"
  | "base_failure";

export interface RepairVerdict {
  action: "proceed" | "stop";
  reason: RepairStopReason;
  /** 若继续，这是第几次重试。 */
  nextAttempt: number;
  message: string;
  /**
   * 停下来时给调用方的结构性建议。自纠错止步的地方往往是「规格没写清楚」，
   * 而不是「运气不好」 —— 这一点必须写进返回值，否则调用方只会继续加重试次数。
   */
  hint?: string;
}

export interface RepairAttemptRecord {
  attempt: number;
  fingerprint: string;
  errorCode?: string;
  violations: string[];
  failedChecks: string[];
  tokens?: number;
}

/**
 * 自纠错的最终结论，挂在 `result.audit.repair` 上。
 *
 * `rescued` 是关键字段：它把「一次成功」和「修了三次才成功」区分开。
 * 后者在系统层面是个信号 —— 说明这条任务的规格需要改，而不是继续加重试次数。
 */
export interface RepairOutcome {
  enabled: boolean;
  mode: RepairMode;
  /** 使用的追加重试次数（不含首次）。 */
  attemptsUsed: number;
  /** 自纠错是否真的救回了这次任务。 */
  rescued: boolean;
  stopReason: RepairStopReason;
  message: string;
  /** 停下来时的结构性建议。 */
  hint?: string;
  history: RepairAttemptRecord[];
  /** 自纠错额外烧掉的 token（不含首次运行）。 */
  extraTokens: number;
}

/**
 * 稳定失败指纹：把这一轮的客观失败项（契约条款 + 验收项 + 错误码）排序后哈希。
 *
 * 排序是必须的 —— 列表顺序会因为调度抖动变化，不排序会误判为「有进展」。
 */
export function failureFingerprint(obs: RepairObservation): string {
  const parts: string[] = [];
  if (obs.errorCode) parts.push("E:" + obs.errorCode);
  for (const v of obs.violations) parts.push("V:" + v.code);
  for (const c of obs.failedChecks) parts.push("C:" + c.kind + ":" + c.name);
  parts.sort();
  return fnv1a32(parts.join("|"));
}

/** FNV-1a 32 位。零依赖、确定性，跨进程一致（归因聚合需要在多次运行间比对）。 */
function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * 自纠错循环的状态机。
 *
 * 用法：每跑完一轮就把结果喂给 `observe()`，它告诉你是继续还是停。
 * 停止理由一共八种，全部可解释 —— 不返回「不知道为什么停了」这种东西。
 */
export class RepairLoop {
  private readonly attempts: RepairAttemptRecord[] = [];
  private readonly seen = new Set<string>();
  private baselineTokens: number | undefined;

  constructor(readonly policy: RepairPolicy) {}

  /** 已完成的追加重试次数（不含首次）。 */
  get attemptCount(): number {
    return Math.max(0, this.attempts.length - 1);
  }

  get history(): RepairAttemptRecord[] {
    return [...this.attempts];
  }

  observe(obs: RepairObservation): RepairVerdict {
    const fp = failureFingerprint(obs);
    const failed = Boolean(obs.errorCode) || obs.violations.length > 0 || obs.failedChecks.length > 0;

    this.attempts.push({
      attempt: obs.attempt,
      fingerprint: fp,
      errorCode: obs.errorCode,
      violations: obs.violations.map((v) => v.code),
      failedChecks: obs.failedChecks.map((c) => c.kind + ":" + c.name),
      tokens: obs.tokens,
    });
    if (this.baselineTokens === undefined && obs.tokens !== undefined) this.baselineTokens = obs.tokens;

    if (!failed) {
      return { action: "stop", reason: "ok", nextAttempt: obs.attempt, message: "通过验收" };
    }

    if (!this.policy.enabled || this.policy.mode === "off") {
      return {
        action: "stop",
        reason: "policy_disabled",
        nextAttempt: obs.attempt,
        message: "自纠错未启用；失败已返回给调用方",
      };
    }

    // 规则 1：没有判据不重试。既没契约审计也没验收检查，失败从何而来？
    const hasJudgement = obs.violations.length > 0 || obs.failedChecks.length > 0;
    if (!hasJudgement) {
      return {
        action: "stop",
        reason: "no_judgement",
        nextAttempt: obs.attempt,
        message: "本次失败没有可复核的判据（未配置 role 契约或 verify 规则），重试缺乏依据",
        hint:
          '自纠错需要客观证据才能工作：给任务加上 role（如 "worker"）或 verify 规则' +
          '（如 { kind:"command", argv:["npm","test"] }）。',
      };
    }

    // 规则 2：崩溃类失败默认不重试（mode:"governed"）。
    if (hasJudgement && !isRepairableFailure(obs.errorCode, this.policy.mode)) {
      return {
        action: "stop",
        reason: "not_repairable",
        nextAttempt: obs.attempt,
        message: `失败码 ${obs.errorCode ?? "(none)"} 在当前 mode="${this.policy.mode}" 下不参与自纠错`,
        hint: '进程崩溃 / 非零退出通常是确定性的。若要连这类失败也重试，显式设 selfRepair: { mode: "all" }。',
      };
    }

    if (this.attemptCount >= this.policy.maxAttempts) {
      return {
        action: "stop",
        reason: "max_attempts",
        nextAttempt: obs.attempt,
        message: `已达自纠错上限（${this.policy.maxAttempts} 次追加尝试）`,
        hint: "到达上限仍失败，说明不是采样噪声。去看最初那条失败证据，多半是任务规格本身不够具体。",
      };
    }

    // 规则 3：同指纹复现 = 无进展。
    if (this.seen.has(fp)) {
      return {
        action: "stop",
        reason: "no_progress",
        nextAttempt: obs.attempt,
        message: "重试复现了完全相同的失败集合，判定为无进展而停止",
        hint: "重复同一个错，问题在输入而不是运气：检查 schema/命令是否自相矛盾，或这条任务是否根本不适合这个角色。",
      };
    }
    this.seen.add(fp);

    // 预算闸门：重试越跑越贵通常意味着它在乱试。
    if (this.policy.maxTokenGrowth > 0 && this.baselineTokens !== undefined && obs.tokens !== undefined) {
      const ceiling = this.baselineTokens * this.policy.maxTokenGrowth;
      if (obs.tokens > ceiling) {
        return {
          action: "stop",
          reason: "budget_exceeded",
          nextAttempt: obs.attempt,
          message: `重试用量 ${obs.tokens} 超过基线 ${this.baselineTokens} 的 ${this.policy.maxTokenGrowth} 倍上限`,
          hint: "重试比首次贵很多通常是在盲目扩大搜索范围。收敛任务范围比放宽预算更有效。",
        };
      }
    }

    return {
      action: "proceed",
      reason: "base_failure",
      nextAttempt: obs.attempt + 1,
      message: `第 ${obs.attempt + 1} 次尝试：带着 ${obs.violations.length + obs.failedChecks.length} 条失败证据重来`,
    };
  }
}

/**
 * 组装挂在 `result.audit.repair` 上的最终结论。
 *
 * `finalOk` 决定是否标记为 rescued：**自纠错救回来的前提是最后一轮真的过了**，
 * 而不是「我们试过了所以态度端正」。
 */
export function summarizeRepair(loop: RepairLoop, verdict: RepairVerdict, finalOk: boolean): RepairOutcome {
  const history = loop.history;
  const extraTokens = history.slice(1).reduce((sum, h) => sum + (h.tokens ?? 0), 0);
  return {
    enabled: loop.policy.enabled,
    mode: loop.policy.mode,
    attemptsUsed: Math.max(0, history.length - 1),
    rescued: history.length > 1 && finalOk,
    stopReason: verdict.reason,
    message: verdict.message,
    hint: verdict.hint,
    history,
    extraTokens,
  };
}
/**
 * 构造修复轮的任务。
 *
 * 关键点：**原始任务原样保留在前面**。只塞「你上一轮错了」而不重申任务，
 * 模型会丢失目标，产出另一种形式的失败（这就是 MAST 里的 FM-2.3 脱轨）。
 */
export function buildRepairTask(original: DshTask, obs: RepairObservation, attempt: number): DshTask {
  const lines: string[] = [];
  lines.push("上一次尝试没有通过自动验收。以下是系统**实际观测到**的失败项，请逐条修复：");
  lines.push("");

  for (const v of obs.violations) {
    lines.push(`- [角色契约 ${v.code}] ${v.message}`);
    if (v.evidence) lines.push(`  证据：${v.evidence}`);
  }
  for (const c of obs.failedChecks) {
    lines.push(`- [验收 ${c.kind}/${c.name}] ${c.detail}`);
  }
  lines.push("");
  lines.push("要求：");
  lines.push("1. 只修复上面列出的问题，已经做对的部分不要推倒重来。");
  lines.push("2. 不要声称已完成，除非上面每一条都确实解决了。");
  lines.push("3. 如果某一条你认为无法完成，直接说明原因，不要绕过去。");
  lines.push("");

  const prev = obs.result.answer ?? "";
  if (prev.trim().length > 0) {
    lines.push("你上一轮的输出（节选）：");
    lines.push("---");
    lines.push(clipAnswer(prev));
    lines.push("---");
    lines.push("");
  }

  return {
    ...original,
    // 修复轮必须继承治理配置：不继承等于绕过验收，自纠错就成了作弊通道。
    role: original.role,
    verify: original.verify,
    // 每次重跑都是不同的输入/会用不同的缓存键；singleflight 也不能把它合并掉。
    task: "【原始任务】\n" + original.task + "\n\n【第 " + attempt + " 次修正】\n" + lines.join("\n"),
    label: original.label ? `${original.label}#repair${attempt}` : `repair${attempt}`,
    // 超时配额每轮重新计算：修复轮要重做卡住的那一步，配额不该被上一轮已经
    // 消耗掉的时间吃掉。signal 仍然继承 —— 用户按下取消必须能中断修复。
    timeoutMs: original.timeoutMs,
  };
}

/**
 * 截断历史答案：保留开头（目标与结构）和结尾（当时的结论），丢掉中间。
 * 中间通常是重复的工具调用记录，对修复没有价值却最占 token。
 */
export function clipAnswer(answer: string): string {
  const s = answer.trim();
  const limit = ANSWER_HEAD_CHARS + ANSWER_TAIL_CHARS;
  if (s.length <= limit) return s;
  const head = s.slice(0, ANSWER_HEAD_CHARS);
  const tail = s.slice(s.length - ANSWER_TAIL_CHARS);
  return head + "\n\n…[中间 N 字符已省略]…\n\n" + tail;
}

/** 从运行结果里抽出冰山下的客观痕迹，组成自纠错能消费的观测。 */
export function observeResult(result: DshResult, attempt: number): RepairObservation {
  const violations =
    result.audit?.role?.violations.map((v) => ({ code: v.code, message: v.message, evidence: v.evidence })) ?? [];
  const failedChecks =
    result.audit?.verification?.checks
      .filter((c) => !c.ok)
      .map((c) => ({ name: c.name, kind: c.kind, detail: c.detail })) ?? [];
  return {
    attempt,
    result,
    errorCode: result.error?.code,
    errorMessage: result.error?.message,
    violations,
    failedChecks,
    tokens: result.usage?.totalTokens,
  };
}
