// json-schema.ts — 结果校验用的 JSON Schema 子集实现。
//
// 为什么自己写而不用 ajv：这是要打进 SDK 的一块，多一个依赖就多一份供应链
// 风险；而我们真正需要的只是在「子 agent 交回来的东西合不合规」这件事上拿
// 到一个确定的布尔答案，不是完整的 draft-07 语义。
//
// 支持的约束：
//   type / enum / const / properties / required / additionalProperties
//   items / minItems / maxItems / minimum / maximum / exclusiveMinimum / exclusiveMaximum
//   minLength / maxLength / pattern
//
// 不支持的约束（$ref / $defs / allOf / anyOf / oneOf / not / format / contains ...）
// 会被收集到 `unsupported` 里返回，**而不是静默跳过**。
// 原因和 sumary() 里那条「失败不能报成功」是一致的：如果 Validate 对一段它
// 看不懂的 schema 返回 ok:true，调用方就会以为自己拿到了校验保障，实际上
// 什么都没校验。宁可让调用方知道「这条没生效」，也不要给假的安全感。

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface JsonSchema {
  type?: string | string[];
  enum?: JsonValue[];
  const?: JsonValue;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Free-form description; never validated. */
  description?: string;
  /** Anything else a user wrote that we do not implement. */
  [key: string]: unknown;
}

export interface SchemaCheckResult {
  ok: boolean;
  errors: string[];
  /**
   * Schema keys that were present but not understood (e.g. `$ref`, `allOf`).
   * Non-empty means the check did NOT cover everything the schema asked for.
   */
  unsupported: string[];
}

const SUPPORTED_KEYS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "description",
  "title",
  "examples",
  "default",
]);

/** Keys we recognise well enough to warn about but cannot enforce. */
const KNOWN_UNSUPPORTED = new Set([
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "format",
  "contains",
  "patternProperties",
  "propertyNames",
  "uniqueItems",
  "dependencies",
  "if",
  "then",
  "else",
  "multipleOf",
]);

/**
 * 「答案文本里到底哪一段是 JSON」。
 *
 * 子 agent 的实际输出几乎从来不是裸 JSON —— 它会在 JSON 前后加解释、
 * 加 markdown 代码块围栏、甚至给两段 JSON。这里做三步提取：
 *   1. 找 ```json ... ``` 围栏里的东西；
 *   2. 退化为找第一个完整的 top-level {...} / [...] 花括号块（带引号感知）；
 *   3. 都没有则返回 undefined，由调用方决定这是「没有输出」还是「格式违规」。
 */
export function extractJson(text: string): JsonValue | undefined {
  const fenced = text.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const bare = scanBalanced(text);
  if (bare !== undefined) candidates.push(bare);
  for (const c of candidates) {
    try {
      return JSON.parse(c) as JsonValue;
    } catch {
      /* try the next candidate */
    }
  }
  // Some models emit the object without any fence and with trailing prose on
  // the same line; try the raw text last.
  try {
    return JSON.parse(text.trim()) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Scan for the first balanced {} or [] region, respecting strings and escapes. */
function scanBalanced(text: string): string | undefined {
  let start = -1;
  let quote: string | null = null;
  let depth = 0;
  let open = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) {
        start = i;
        open = ch;
      }
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        const close = open === "{" ? "}" : "]";
        if (text[start] === "{" && close === "}") return text.slice(start, i + 1);
        if (text[start] === "[" && close === "]") return text.slice(start, i + 1);
        start = -1;
      }
    }
  }
  return undefined;
}

/** Collect unsupported keys anywhere in the schema tree, deduplicated. */
function collectUnsupported(schema: JsonSchema, into: Set<string>): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYS.has(key)) into.add(key);
  }
  for (const sub of Object.values(schema.properties ?? {})) collectUnsupported(sub, into);
  if (Array.isArray(schema.items)) {
    for (const sub of schema.items) collectUnsupported(sub, into);
  } else if (schema.items && typeof schema.items === "object") {
    collectUnsupported(schema.items, into);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    collectUnsupported(schema.additionalProperties, into);
  }
}

/**
 * Validate `value` against `schema`.
 *
 * `unsupported` is always populated regardless of the outcome, so callers can
 * tell "this value conformed" from "nothing was actually checked". Pass
 * `strict: true` to treat unsupported constraints as failures — recommended
 * when the schema is machine-authored and silently dropping a rule would give
 * a false sense of safety.
 */
export function checkSchema(schema: JsonSchema, value: unknown, opts: { strict?: boolean } = {}): SchemaCheckResult {
  const errors: string[] = [];
  const unsupported = new Set<string>();
  collectUnsupported(schema, unsupported);
  walk(schema, value, errors, "$");
  const unsupportedList = Array.from(unsupported).sort();
  if (opts.strict) {
    for (const key of unsupportedList) {
      errors.push(`$: constraint "${key}" is not supported by this validator (strict mode)`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    unsupported: unsupportedList,
  };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object") return "object";
  return typeof v;
}

/** True when `actual` satisfies the declared `expected` type name. */
function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  // JSON Schema: every integer is also a number.
  if (expected === "number" && actual === "integer") return true;
  return false;
}

function walk(schema: JsonSchema, value: unknown, errors: string[], path: string): void {
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!allowed.some((t) => typeMatches(t, actual))) {
      errors.push(`${path}: expected type ${allowed.join("|")} but got ${actual}`);
      // A type mismatch makes the remaining constraints meaningless; stop here
      // rather than emitting a cascade of derived errors.
      return;
    }
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: value not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined) {
      let re: RegExp;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        errors.push(`${path}: invalid pattern ${schema.pattern}`);
        return;
      }
      if (!re.test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push(`${path}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: array has ${value.length} items, minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: array has ${value.length} items, maxItems ${schema.maxItems}`);
    }
    if (schema.items && !Array.isArray(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        walk(schema.items, value[i], errors, `${path}[${i}]`);
      }
    } else if (Array.isArray(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const sub = schema.items[i];
        if (sub) walk(sub, value[i], errors, `${path}[${i}]`);
      }
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) walk(sub, obj[key], errors, `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}: unexpected property "${key}"`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) walk(schema.additionalProperties, obj[key], errors, `${path}.${key}`);
      }
    }
  }

  // $ref / anyOf / allOf / oneOf 之类的组合约束我们没有实现。它们是「完全
  // 不生效」而不是「部分生效」，所以仅仅返回 ok:true 会让调用方以为自己拿到
  // 了保障。这类 key 由 checkSchema 的 unsupported 列表上报（strict 模式下
  // 直接算失败），这里不重复往 errors 里塞。
  // (void 只是让编辑器知道这段的下文没有 fall-through 逻辑)
  void KNOWN_UNSUPPORTED;
}
