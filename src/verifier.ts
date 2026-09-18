// verifier.ts — 独立验证层（Verification Layer）。
//
// 为什么必须独立：MAST(arXiv:2503.13657) 里**任务验证类失败约占 23%**，
// 主要形态是「过早终止」和「验证不完整」——表现形式是测试跑通了但功能没实现、
// 或者 agent 自己宣布完成了而没人真的检查过。Anthropic 在生产里的结论也一样：
// **模型自评不可靠**，验证必须是可执行的、独立于执行者的。
//
// 所以这里做的是「任务结束后，由框架（不是那个 agent）跑一遍你指定的检查」：
//   - command: 真的去跑 lint / tsc / vitest，看退出码
//   - answer-schema: 用 json-schema 校验它的结论结构
//   - answer-match / answer-not-match: 正则断言
//   - file-exists: 产物到底有没有落盘（带最小体积，防止 touch 出来的空文件）
//   - max-tool-calls / tool-not-used: 行为边界
//
// 两条硬约定：
//   1. **命令永远以 argv 数组形式执行，shell: false** —— 不留 shell 注入面。
//   2. **不认识的规则一律算失败** —— 静默跳过一条检查，等于告诉调用方
//      「验证过了」，而实际上那条检查从来没跑。这跟 dsh-client 里修掉的
//      「失败被上报为成功」是同一类错误。

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { checkSchema, extractJson, type JsonSchema } from "./json-schema.js";
import type { DshResult } from "./types.js";

/** 单条校验规则。所有字段都是 JSON 友好的，方便从 MCP / CLI / 配置文件传入。 */
export type VerifyRule =
  | {
      kind: "command";
      /** 命令及其参数。**必须是数组**，不允许字符串命令行（防 shell 注入）。 */
      argv: string[];
      /** 期望的退出码，默认 0。 */
      expectExitCode?: number;
      timeoutMs?: number;
      cwd?: string;
      /** stderr 非空也算失败（默认 false：很多工具往 stderr 打进度）。 */
      failOnStderr?: boolean;
      /** stdout 必须匹配的正则。 */
      stdoutMatch?: string;
      name?: string;
    }
  | { kind: "answer-schema"; schema: JsonSchema; strict?: boolean; name?: string }
  | { kind: "answer-match"; pattern: string; flags?: string; name?: string }
  | { kind: "answer-not-match"; pattern: string; flags?: string; name?: string }
  | { kind: "answer-min-length"; min: number; name?: string }
  | { kind: "file-exists"; path: string; minBytes?: number; baseDir?: string; name?: string }
  | { kind: "max-tool-calls"; max: number; name?: string }
  | { kind: "tool-not-used"; tool: string; name?: string };

export type VerifyRuleKind = VerifyRule["kind"];

export interface VerifyCheck {
  name: string;
  kind: VerifyRuleKind | "unknown";
  ok: boolean;
  /** 失败原因；成功时为空字符串。 */
  detail: string;
  durationMs: number;
}

export interface VerifyReport {
  ok: boolean;
  checks: VerifyCheck[];
  durationMs: number;
  /** 规则里存在但本模块不认识的 kind —— 这些检查实际没执行。 */
  unknownKinds: string[];
  /**
   * 部分 commander 失败的输入属于「配置错」而非「验证不通过」，
   * 两者混在一起会让归因失真，所以单独列出来。
   */
  configErrors: string[];
}

export interface VerifyContext {
  /** 被校验的那次运行结果。 */
  result: DshResult;
  /** 校验命令的工作目录，默认 process.cwd()。 */
  cwd?: string;
  /** file-exists 规则的相对路径基准，默认同 cwd。 */
  baseDir?: string;
  /** 单条 command 的默认超时，默认 120_000。 */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Windows 上没有 .cmd/.bat 的可执行位概念，`spawn("npm")` 会直接 ENOENT。
 * 这里按 PATHEXT 逐个试探，让 `["npm","test"]` 在 Windows 和 POSIX 上表现一致。
 * 找得到就返回原 argv（只是把 argv[0] 换成带扩展名的形式）。
 */
function resolveWin32Argv(argv: string[]): string[] {
  const exe = argv[0]!;
  // 带路径分隔符或已经有扩展名的，原样交给 CreateProcess 处理。
  if (/[/\\]/.test(exe) || /\.[a-zA-Z0-9]+$/.test(exe)) return argv;
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e.startsWith("."));
  for (const ext of [...exts, ""]) {
    const probe = spawnSync("where", [exe + ext], { windowsHide: true });
    if (probe.status === 0 && probe.stdout && probe.stdout.toString().trim().length > 0) {
      return [exe + ext, ...argv.slice(1)];
    }
  }
  return argv;
}

function killTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(proc.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
      return;
    } catch {
      /* fall through to a direct kill */
    }
  }
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    /* already gone */
  }
}

interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function runCommand(argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<CommandOutcome> {
  return new Promise((resolveP) => {
    const finalArgv = process.platform === "win32" ? resolveWin32Argv(argv) : argv;
    let proc: ChildProcess;
    try {
      proc = spawn(finalArgv[0]!, finalArgv.slice(1), {
        cwd: opts.cwd,
        // 安全边界：永远不走 shell，argv 里有僵尸般的元字符也不会被执行。
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      resolveP({
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (outcome: CommandOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP(outcome);
    };
    const timer = setTimeout(() => {
      killTree(proc, "SIGTERM");
      // 子进程组可能忽略 SIGTERM，给 5s 后强杀，避免验证步骤自己挂死整条流水线。
      setTimeout(() => killTree(proc, "SIGKILL"), 5000).unref();
      finish({ exitCode: null, timedOut: true, stdout, stderr: stderr + "\n[verifier] command timed out" });
    }, opts.timeoutMs);
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    proc.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    proc.once("error", (e: Error) => finish({ exitCode: null, timedOut: false, stdout, stderr: e.message }));
    proc.once("close", (code: number | null) => finish({ exitCode: code, timedOut: false, stdout, stderr }));
  });
}

function ruleName(rule: VerifyRule, index: number): string {
  if ("name" in rule && typeof rule.name === "string" && rule.name.trim()) return rule.name;
  switch (rule.kind) {
    case "command":
      return "command: " + rule.argv.join(" ");
    case "file-exists":
      return "file-exists: " + rule.path;
    case "answer-match":
    case "answer-not-match":
      return rule.kind + ": /" + rule.pattern + "/";
    default:
      return rule.kind + "#" + index;
  }
}

/**
 * 对一次运行结果执行全部校验规则。
 *
 * 规则**顺序执行**：校验命令之间常常有隐式依赖（先 install 再 test），并行跑出
 * 来的失败往往不可复现，反而把归因搞得更贵。
 *
 * @returns VerifyReport。`ok` 为真当且仅当所有检查都通过、没有未知 kind、
 *          也没有配置错误。
 */
export async function verifyResult(rules: VerifyRule[], ctx: VerifyContext): Promise<VerifyReport> {
  const startedAt = Date.now();
  const checks: VerifyCheck[] = [];
  const unknownKinds: string[] = [];
  const configErrors: string[] = [];
  const cwd = ctx.cwd ? resolvePath(ctx.cwd) : process.cwd();
  const baseDir = ctx.baseDir ? resolvePath(ctx.baseDir) : cwd;
  const defaultTimeout = ctx.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = ctx.result;
  const answer = result.answer ?? "";

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    const name = ruleName(rule, i);
    const started = Date.now();
    const end = (ok: boolean, detail: string): void => {
      checks.push({ name, kind: rule.kind, ok, detail, durationMs: Date.now() - started });
    };

    switch (rule.kind) {
      case "command": {
        if (!Array.isArray(rule.argv) || rule.argv.length === 0 || !rule.argv[0]?.trim()) {
          configErrors.push(`rule#${i} (${name}): command argv must be a non-empty array`);
          end(false, "invalid argv");
          break;
        }
        const outcome = await runCommand(rule.argv, {
          cwd: rule.cwd ? resolvePath(rule.cwd) : cwd,
          timeoutMs: rule.timeoutMs ?? defaultTimeout,
        });
        if (outcome.timedOut) {
          end(false, "timed out after " + (rule.timeoutMs ?? defaultTimeout) + "ms");
          break;
        }
        const expected = rule.expectExitCode ?? 0;
        if (outcome.exitCode !== expected) {
          end(false, `exit ${outcome.exitCode} (expected ${expected})` + tail(outcome.stderr || outcome.stdout));
          break;
        }
        if (rule.failOnStderr && outcome.stderr.trim().length > 0) {
          end(false, "stderr not empty" + tail(outcome.stderr));
          break;
        }
        if (rule.stdoutMatch) {
          const ok = safeMatch(outcome.stdout, rule.stdoutMatch);
          if (!ok) {
            end(false, "stdout does not match /" + rule.stdoutMatch + "/" + tail(outcome.stdout));
            break;
          }
        }
        end(true, "exit " + outcome.exitCode);
        break;
      }

      case "answer-schema": {
        const parsed = extractJson(answer);
        if (parsed === undefined) {
          end(false, "no JSON object could be parsed from the answer");
          break;
        }
        const check = checkSchema(rule.schema, parsed, { strict: rule.strict });
        if (!check.ok) {
          end(false, check.errors.slice(0, 5).join(" ; "));
          break;
        }
        if (check.unsupported.length > 0) {
          end(true, "passed, but these constraints were NOT enforced: " + check.unsupported.join(","));
          break;
        }
        end(true, "conforms");
        break;
      }

      case "answer-match": {
        if (!safeMatch(answer, rule.pattern, rule.flags)) {
          end(false, "answer does not match /" + rule.pattern + "/");
          break;
        }
        end(true, "matched");
        break;
      }

      case "answer-not-match": {
        if (safeMatch(answer, rule.pattern, rule.flags)) {
          end(false, "answer unexpectedly matches /" + rule.pattern + "/");
          break;
        }
        end(true, "not matched");
        break;
      }

      case "answer-min-length": {
        if (answer.trim().length < rule.min) {
          end(false, `answer is ${answer.trim().length} chars, needs >= ${rule.min}`);
          break;
        }
        end(true, answer.trim().length + " chars");
        break;
      }

      case "file-exists": {
        // 规则自己的 baseDir 优先级高于全局：同一批校验里常常要跨多个目录检查。
        const dir = rule.baseDir ? resolvePath(rule.baseDir) : baseDir;
        const target = resolvePath(dir, rule.path);
        if (!existsSync(target)) {
          end(false, "missing: " + target);
          break;
        }
        if (rule.minBytes !== undefined) {
          const size = statSync(target).size;
          if (size < rule.minBytes) {
            end(false, `${target} is ${size} bytes, needs >= ${rule.minBytes}`);
            break;
          }
          end(true, statSync(target).size + " bytes");
          break;
        }
        end(true, "exists");
        break;
      }

      case "max-tool-calls": {
        const calls = result.toolCalls?.length ?? 0;
        if (calls > rule.max) {
          end(false, `${calls} tool calls, limit ${rule.max}`);
          break;
        }
        end(true, calls + " tool calls");
        break;
      }

      case "tool-not-used": {
        const used = result.toolCalls?.some((c) => c.name === rule.tool) ?? false;
        if (used) {
          end(false, "rule expected " + rule.tool + " to be unused, but it was called");
          break;
        }
        end(true, rule.tool + " not used");
        break;
      }

      default: {
        // 认不出来就必须说出来。把它当通过，等于伪造了一份验收报告。
        const kind = (rule as { kind?: string }).kind ?? "?";
        unknownKinds.push(kind);
        checks.push({
          name,
          kind: "unknown",
          ok: false,
          detail: `unsupported verify rule kind "${kind}" — this check did NOT run`,
          durationMs: Date.now() - started,
        });
      }
    }
  }

  const allPassed = checks.every((c) => c.ok);
  return {
    ok: allPassed && unknownKinds.length === 0 && configErrors.length === 0,
    checks,
    durationMs: Date.now() - startedAt,
    unknownKinds: Array.from(new Set(unknownKinds)),
    configErrors,
  };
}

function tail(text: string, max = 400): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  return " | " + (trimmed.length > max ? trimmed.slice(-max) : trimmed).replace(/\s+/g, " ");
}

/** RegExp 可能因为用户给的 flags/pattern 非法而抛错 —— 那是配置错误，不是验证失败。 */
function safeMatch(text: string, pattern: string, flags?: string): boolean {
  try {
    return new RegExp(pattern, flags).test(text);
  } catch {
    return false;
  }
}

/**
 * 从一组常见的工程约定生成验证规则。
 *
 * 这是「默认就该有的验证」——MAST 里 23% 的验证失败里有一大批纯粹是因为
 * 根本没设验证。给不出自定义规则时，用这个兜底比留空强。
 */
export function defaultVerifyRules(opts: { hasTests?: boolean; deliverables?: string[] } = {}): VerifyRule[] {
  const rules: VerifyRule[] = [];
  for (const d of opts.deliverables ?? []) {
    rules.push({ kind: "file-exists", path: d, minBytes: 1 });
  }
  if (opts.hasTests) {
    rules.push({ kind: "command", argv: ["npm", "test", "--silent"], timeoutMs: 300_000, name: "npm test" });
  }
  return rules;
}
