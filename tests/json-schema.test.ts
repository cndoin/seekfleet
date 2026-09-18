// json-schema.test.ts — 校验器自身的可信度。
//
// 这个模块是「有没有真的校验」的最后一道防线：如果它对看不懂的约束假装通过，
// 上层所有的 ok:true 就都是假的。所以这里除了常规正误，还专门验证两件事：
//   1. extractJson 能从模型常见的脏输出里掏出 JSON；
//   2. 不支持的约束一定会被上报（strict 模式下一定算失败）。

import { describe, expect, it } from "vitest";
import { checkSchema, extractJson, type JsonSchema } from "../src/json-schema.js";

describe("extractJson", () => {
  it("reads a fenced json block even with prose around it", () => {
    const text = '下面是我的分析结果：\n```json\n{"verdict": "accept", "score": 9}\n```\n希望对你有帮助。';
    expect(extractJson(text)).toEqual({ verdict: "accept", score: 9 });
  });

  it("reads a bare object without fences", () => {
    expect(extractJson('前缀 {"a":1,"b":[2,3]} 后缀')).toEqual({ a: 1, b: [2, 3] });
  });

  it("stops at the matching brace instead of swallowing trailing prose", () => {
    // 卢卡斯陷阱：非贪心匹配会在第一个 } 就停，把 {"a":1} 之后的兄弟姐妹丢掉。
    const parsed = extractJson('{"subtasks":[{"id":"a"},{"id":"b"}],"notes":"ok"} 以上是计划');
    expect(parsed).toEqual({ subtasks: [{ id: "a" }, { id: "b" }], notes: "ok" });
  });

  it("ignores braces inside strings", () => {
    expect(extractJson('{"pattern":"a{b}c"}')).toEqual({ pattern: "a{b}c" });
  });

  it("returns undefined when there is genuinely no JSON", () => {
    expect(extractJson("我觉得这个方案可行，但还需要更多信息。")).toBeUndefined();
  });

  it("parses a top-level array", () => {
    expect(extractJson("答案：[1, 2, 3]")).toEqual([1, 2, 3]);
  });
});

describe("checkSchema", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["verdict"],
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["accept", "reject"] },
      score: { type: "integer", minimum: 0, maximum: 10 },
      evidence: { type: "string", minLength: 1 },
      tags: { type: "array", maxItems: 2, items: { type: "string" } },
    },
  };

  it("accepts a conforming value", () => {
    const r = checkSchema(schema, { verdict: "accept", score: 7, tags: ["a"] });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.unsupported).toEqual([]);
  });

  it("reports every violation, not just the first", () => {
    const r = checkSchema(schema, { verdict: "maybe", score: 42, tags: ["a", "b", "c"], extra: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("verdict"))).toBe(true);
    expect(r.errors.some((e) => e.includes("maximum"))).toBe(true);
    expect(r.errors.some((e) => e.includes("maxItems"))).toBe(true);
    expect(r.errors.some((e) => e.includes("extra"))).toBe(true);
  });

  it("reports missing required properties", () => {
    const r = checkSchema(schema, { score: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('missing required property "verdict"');
  });

  it("treats an integer as a number (JSON Schema numeric ladder)", () => {
    expect(checkSchema({ type: "number" }, 3).ok).toBe(true);
    expect(checkSchema({ type: "integer" }, 3.5).ok).toBe(false);
  });

  it("handles nested objects and arrays with precise paths", () => {
    const nested: JsonSchema = {
      type: "object",
      properties: { checks: { type: "array", items: { type: "object", required: ["passed"] } } },
    };
    const r = checkSchema(nested, { checks: [{ passed: true }, {}] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith("$.checks[1]"))).toBe(true);
  });

  it("reports an invalid regex instead of throwing", () => {
    const r = checkSchema({ type: "string", pattern: "([unclosed" }, "x");
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("invalid pattern");
  });

  it("does not pretend to have checked constraints it does not implement", () => {
    const withRef: JsonSchema = {
      type: "object",
      properties: { x: { $ref: "#/$defs/Thing" } },
      $defs: { Thing: { type: "string" } },
    };
    const r = checkSchema(withRef, { x: 1 });
    expect(r.unsupported).toContain("$ref");
    expect(r.unsupported).toContain("$defs");
    // 默认（非严格）模式：不会因为看不懂就把合法数据判失败。
    expect(r.ok).toBe(true);
  });

  it("fails closed in strict mode when it cannot enforce a constraint", () => {
    const anyOf: JsonSchema = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(checkSchema(anyOf, "x", { strict: true }).ok).toBe(false);
    expect(checkSchema(anyOf, "x").ok).toBe(true);
  });

  it("stops after a type mismatch instead of cascading", () => {
    const r = checkSchema({ type: "object", properties: { a: { type: "string" } } }, "not-an-object");
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
  });

  it("enforces const and enum", () => {
    expect(checkSchema({ const: 42 }, 42).ok).toBe(true);
    expect(checkSchema({ const: 42 }, 43).ok).toBe(false);
    expect(checkSchema({ enum: ["a", "b"] }, "a").ok).toBe(true);
    expect(checkSchema({ enum: ["a", "b"] }, "c").ok).toBe(false);
  });
});
