// verifier.test.ts — 独立验证层的行为合约。
//
// 这一层的价值全靠「它真的执行了」来支撑，所以测试重点不是 happy path，
// 而是三条容易出假的地方：
//   1. 失败的命令必须让整体 ok=false（不能因为异步竞态漏掉）
//   2. 不认识的规则必须让整体 ok=false（不能假装通过）
//   3. 超时必须能被收住，不能把整条流水线挂死

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultVerifyRules, verifyResult, type VerifyRule } from "../src/verifier.js";
import type { DshResult } from "../src/types.js";

const node = process.execPath;

function result(partial: Partial<DshResult> = {}): DshResult {
  return {
    answer: "done",
    toolCalls: [],
    toolResults: [],
    events: 0,
    durationMs: 1,
    exitCode: 0,
    stderrTail: "",
    ...partial,
  };
}

/** 起一个会立刻以指定码退出的子进程。跨平台：用 node 自身当解释器。 */
function exitWith(code: number): string[] {
  return [node, "-e", `process.exit(${code})`];
}

describe("verifyResult / command", () => {
  it("passes when the command exits with the expected code", async () => {
    const report = await verifyResult([{ kind: "command", argv: exitWith(0) }], { result: result() });
    expect(report.ok).toBe(true);
    expect(report.checks[0]!.ok).toBe(true);
  });

  it("fails on a non-zero exit code and keeps the output for diagnosis", async () => {
    const argv = [node, "-e", 'console.error("boom"); process.exit(3)'];
    const report = await verifyResult([{ kind: "command", argv }], { result: result() });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toContain("exit 3");
    expect(report.checks[0]!.detail).toContain("boom");
  });

  it("honours expectExitCode for tools that use non-zero codes as a signal", async () => {
    const report = await verifyResult([{ kind: "command", argv: exitWith(2), expectExitCode: 2 }], {
      result: result(),
    });
    expect(report.ok).toBe(true);
  });

  it("kills a hanging command instead of hanging the pipeline", async () => {
    // 故意写一个永不退出的子进程 + 200ms 超时。
    const argv = [node, "-e", "setInterval(() => {}, 1000)"];
    const started = Date.now();
    const report = await verifyResult([{ kind: "command", argv, timeoutMs: 200 }], { result: result() });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toContain("timed out");
    // 强杀宽限是 5s，但正常情况下不到这儿就返回了；这里只保证它确实返回了。
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("never goes through a shell, so a hostile argv is just an argument", async () => {
    // 如果哪天有人把 shell:true 加回来，这条会变成 inject 成功 -> ping 失败 -> 红
    const argv = [node, "-e", "console.log(process.argv[1]); process.exit(0)", "x & echo pwned"];
    const report = await verifyResult([{ kind: "command", argv, stdoutMatch: "x & echo pwned" }], {
      result: result(),
    });
    expect(report.ok).toBe(true);
  });

  it("fails when stdout does not match the required pattern", async () => {
    const argv = [node, "-e", 'console.log("all good")'];
    const report = await verifyResult([{ kind: "command", argv, stdoutMatch: "^expected" }], { result: result() });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toContain("does not match");
  });

  it("can be strict about stderr", async () => {
    const argv = [node, "-e", 'console.error("warning: deprecated"); process.exit(0)'];
    const lenient = await verifyResult([{ kind: "command", argv }], { result: result() });
    expect(lenient.ok).toBe(true);
    const strict = await verifyResult([{ kind: "command", argv, failOnStderr: true }], { result: result() });
    expect(strict.ok).toBe(false);
  });

  it("records bad command configuration as a config error, not as a passed check", async () => {
    const report = await verifyResult([{ kind: "command", argv: [] }], { result: result() });
    expect(report.ok).toBe(false);
    expect(report.configErrors.some((e) => e.includes("argv"))).toBe(true);
  });
});

describe("verifyResult / answer assertions", () => {
  it("validates the answer against a schema", async () => {
    const rules: VerifyRule[] = [
      {
        kind: "answer-schema",
        schema: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } },
      },
    ];
    expect((await verifyResult(rules, { result: result({ answer: '{"verdict":"accept"}' }) })).ok).toBe(true);
    expect((await verifyResult(rules, { result: result({ answer: '{"verdict":123}' }) })).ok).toBe(false);
  });

  it("fails schema validation when no JSON can be parsed instead of passing", async () => {
    const rules: VerifyRule[] = [{ kind: "answer-schema", schema: { type: "object" } }];
    const report = await verifyResult(rules, { result: result({ answer: "我觉得可以了" }) });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toContain("no JSON object");
  });

  it("flags constraints the validator cannot enforce even when the value passes", async () => {
    const rules: VerifyRule[] = [{ kind: "answer-schema", schema: { anyOf: [{ type: "object" }] } }];
    const report = await verifyResult(rules, { result: result({ answer: "{}" }) });
    expect(report.ok).toBe(true);
    expect(report.checks[0]!.detail).toContain("NOT enforced");
  });

  it("supports match / not-match / min-length", async () => {
    const base = { result: result({ answer: "Task completed successfully." }) };
    expect((await verifyResult([{ kind: "answer-match", pattern: "completed" }], base)).ok).toBe(true);
    expect((await verifyResult([{ kind: "answer-match", pattern: "^nope" }], base)).ok).toBe(false);
    expect((await verifyResult([{ kind: "answer-not-match", pattern: "TODO|later" }], base)).ok).toBe(true);
    expect((await verifyResult([{ kind: "answer-not-match", pattern: "successfully" }], base)).ok).toBe(false);
    expect((await verifyResult([{ kind: "answer-min-length", min: 5 }], base)).ok).toBe(true);
    expect((await verifyResult([{ kind: "answer-min-length", min: 500 }], base)).ok).toBe(false);
  });

  it("survives an invalid regex instead of crashing the verification run", async () => {
    const report = await verifyResult([{ kind: "answer-match", pattern: "(((" }], { result: result() });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toContain("does not match");
  });
});

describe("verifyResult / behaviour bounds", () => {
  it("enforces a tool-call ceiling", async () => {
    const r = result({
      toolCalls: [
        { name: "fs", args: {} },
        { name: "bash", args: {} },
      ],
    });
    expect((await verifyResult([{ kind: "max-tool-calls", max: 3 }], { result: r })).ok).toBe(true);
    expect((await verifyResult([{ kind: "max-tool-calls", max: 1 }], { result: r })).ok).toBe(false);
  });

  it("can assert a tool was never used (e.g. a reviewer must not edit files)", async () => {
    const r = result({ toolCalls: [{ name: "str-replace-editor", args: {} }] });
    const rules: VerifyRule[] = [{ kind: "tool-not-used", tool: "str-replace-editor" }];
    expect((await verifyResult(rules, { result: r })).ok).toBe(false);
    expect((await verifyResult(rules, { result: result() })).ok).toBe(true);
  });
});

describe("verifyResult / file-exists", () => {
  it("passes for a real non-empty file and fails for a missing one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    const file = "artifact.txt";
    writeFileSync(join(dir, file), "hello", "utf8");
    const rules: VerifyRule[] = [{ kind: "file-exists", path: file, minBytes: 1, baseDir: dir }];
    expect((await verifyResult(rules, { result: result() })).ok).toBe(true);
    const missing: VerifyRule[] = [{ kind: "file-exists", path: "nope.txt", baseDir: dir }];
    expect((await verifyResult(missing, { result: result() })).ok).toBe(false);
  });

  it("catches an empty placeholder file created just to satisfy the check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    writeFileSync(join(dir, "empty.txt"), "", "utf8");
    const rules: VerifyRule[] = [{ kind: "file-exists", path: "empty.txt", minBytes: 1, baseDir: dir }];
    const report = await verifyResult(rules, { result: result() });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toContain("0 bytes");
  });
});

describe("verifyResult / honesty guarantees", () => {
  it("fails when the rule kind is unknown rather than skipping it silently", async () => {
    const bogus = [{ kind: "screenshot-match", expected: "x.png" }] as unknown as VerifyRule[];
    const report = await verifyResult(bogus, { result: result() });
    expect(report.ok).toBe(false);
    expect(report.unknownKinds).toContain("screenshot-match");
    expect(report.checks[0]!.detail).toContain("did NOT run");
  });

  it("reports one check per rule, even when several fail", async () => {
    const report = await verifyResult(
      [
        { kind: "answer-match", pattern: "nope" },
        { kind: "answer-min-length", min: 9999 },
      ],
      { result: result() },
    );
    expect(report.checks).toHaveLength(2);
    expect(report.checks.every((c) => !c.ok)).toBe(true);
  });

  it("returns ok=true for an empty rule set — nothing claimed, nothing faked", async () => {
    const report = await verifyResult([], { result: result() });
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([]);
  });

  it("uses the provided name so failures point at a readable rule", async () => {
    const report = await verifyResult([{ kind: "answer-match", pattern: "^zzz", name: "必须有结论段" }], {
      result: result(),
    });
    expect(report.checks[0]!.name).toBe("必须有结论段");
  });
});

describe("defaultVerifyRules", () => {
  it("generates file checks for declared deliverables", () => {
    const rules = defaultVerifyRules({ deliverables: ["src/a.ts"] });
    expect(rules).toEqual([{ kind: "file-exists", path: "src/a.ts", minBytes: 1 }]);
  });

  it("adds a npm test command when tests exist", () => {
    const rules = defaultVerifyRules({ hasTests: true });
    expect(rules.some((r) => r.kind === "command" && r.argv[0] === "npm")).toBe(true);
  });

  it("emits nothing when there is nothing to check, rather than inventing a rule", () => {
    expect(defaultVerifyRules({})).toEqual([]);
  });
});
