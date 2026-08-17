// event-parser.ts - Transform-stream based NDJSON parser for dsh stdout/stderr.
//
// Uses split2 for backpressure-safe line splitting. Each line is classified
// into a DshEvent. We never throw on parse errors - bad lines become log events.

import { Transform } from "node:stream";
import split2 from "split2";
import type { DshEvent, DshEventKind } from "./types.js";

export interface ParserOptions {
  /** if true, only emit events for JSON-parsable lines */
  jsonOnly?: boolean;
}

/** Build a Transform that converts a byte stream of dsh output into DshEvent objects. */
export function createEventTransform(opts: ParserOptions = {}): Transform {
  let seq = 0;
  const classify = (line: string): DshEvent => {
    const trimmed = line.trim();
    if (trimmed.length > 0 && (trimmed[0] === "{" || trimmed[0] === "[")) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object") {
          return {
            kind: inferKindFromObject(obj),
            ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
            seq: seq++,
            data: obj,
          };
        }
      } catch {
        /* fall through */
      }
    }
    const kind: DshEventKind = !opts.jsonOnly && looksLikeAnswer(line) ? "answer" : "log";
    return { kind, ts: Date.now(), seq: seq++, data: { line } };
  };
  return split2((line: string) => classify(line));
}

/** Synchronous line-classifier. Useful for testing or pre-classifying buffers. */
export function classifyLine(line: string, seqRef: { value: number }): DshEvent {
  const trimmed = line.trim();
  if (trimmed.length > 0 && (trimmed[0] === "{" || trimmed[0] === "[")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") {
        return {
          kind: inferKindFromObject(obj),
          ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
          seq: seqRef.value++,
          data: obj,
        };
      }
    } catch {
      /* fall through */
    }
  }
  const kind: DshEventKind = looksLikeAnswer(line) ? "answer" : "log";
  return { kind, ts: Date.now(), seq: seqRef.value++, data: { line } };
}

function inferKindFromObject(obj: Record<string, unknown>): DshEventKind {
  if (typeof obj.type === "string") {
    const t = obj.type.toLowerCase();
    if (t.includes("tool") && t.includes("call")) return "tool_call";
    if (t.includes("tool") && t.includes("result")) return "tool_result";
    if (t.includes("usage") || t.includes("token")) return "usage";
    if (t.includes("subagent")) return "subagent";
    if (t.includes("answer") || t.includes("final")) return "answer";
    if (t.includes("error")) return "error";
  }
  if ("tool_call" in obj || "toolCall" in obj) return "tool_call";
  if ("tool_result" in obj || "toolResult" in obj) return "tool_result";
  if ("usage" in obj) return "usage";
  if ("answer" in obj || "final" in obj) return "answer";
  if ("error" in obj) return "error";
  if ("subagent_id" in obj || "subagentId" in obj) return "subagent";
  return "log";
}

function looksLikeAnswer(line: string): boolean {
  if (line.length > 4000) return false;
  if (/^(DEBUG|INFO|WARN|ERROR|\[)/i.test(line)) return false;
  return true;
}

/** Backwards-compatible EventParser that buffers (used by tests). */
export class EventParser {
  private seq = 0;
  private buf = "";
  private readonly opts: ParserOptions;
  constructor(opts: ParserOptions = {}) {
    this.opts = opts;
  }
  feed(chunk: string): DshEvent[] {
    this.buf += chunk;
    const out: DshEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      const ref = { value: this.seq++ };
      out.push(classifyLine(line, ref));
    }
    return out;
  }
  flush(): DshEvent[] {
    if (this.buf.length === 0) return [];
    const line = this.buf;
    this.buf = "";
    return [classifyLine(line, { value: this.seq++ })];
  }
}
