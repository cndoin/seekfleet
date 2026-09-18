// Regression coverage for terminal-event semantics in summarize().
//
// The stream closes with a terminal event of kind "exit" on success and kind
// "error" when the task was aborted, timed out, or killed. Only "exit" used to
// be parsed, so every aborted task surfaced as a success with exitCode null,
// durationMs 0 and no error field. That silently turned timeouts into "ok"
// results, which the cluster then cached and the circuit breaker counted as a
// success.

import { describe, expect, it } from "vitest";
import { summarize } from "../src/dsh-client.js";
import type { DshEvent } from "../src/types.js";

const answer = (text: string, seq = 1): DshEvent => ({ kind: "answer", ts: 1, seq, data: { answer: text } });
const exit = (exitCode: number | null, seq: number, aborted = false, durationMs = 42): DshEvent => ({
  kind: "exit",
  ts: 2,
  seq,
  data: { exitCode, durationMs, aborted },
});
const abortEvent = (seq: number, durationMs = 5000): DshEvent => ({
  kind: "error",
  ts: 3,
  seq,
  data: { exitCode: null, durationMs, aborted: true },
});

describe("summarize terminal events", () => {
  it("reports a clean exit without an error", () => {
    const r = summarize([answer("done"), exit(0, 2)]);
    expect(r.answer).toBe("done");
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBe(42);
    expect(r.error).toBeUndefined();
  });

  it("surfaces a non-zero exit code as an error", () => {
    const r = summarize([exit(3, 1)]);
    expect(r.exitCode).toBe(3);
    // dsh exits non-zero for hard failures (missing credentials, bad flags,
    // crashed tool). Returning no `error` made cluster / DAG / cache / MCP all
    // read the run as a success and cache the empty answer.
    expect(r.error?.code).toBe("EXIT_NONZERO");
    expect(r.error?.message).toContain("3");
  });

  it("keeps a clean exit error-free", () => {
    const r = summarize([answer("ok"), exit(0, 2)]);
    expect(r.error).toBeUndefined();
  });

  it("prefers ABORTED over EXIT_NONZERO for an aborted run", () => {
    const r = summarize([exit(1, 1, true)]);
    expect(r.error?.code).toBe("ABORTED");
  });

  it("flags an aborted run as an error", () => {
    const r = summarize([exit(null, 1, true, 900)]);
    expect(r.error?.code).toBe("ABORTED");
    expect(r.durationMs).toBe(900);
  });

  it("flags an aborted run even when a partial answer was produced", () => {
    const r = summarize([answer("partial"), abortEvent(2)]);
    expect(r.answer).toBe("partial");
    expect(r.error?.code).toBe("ABORTED");
    expect(r.durationMs).toBe(5000);
    expect(r.exitCode).toBeNull();
  });

  it("keeps the timeout message in the stderr tail", () => {
    const events: DshEvent[] = [{ kind: "error", ts: 1, seq: 1, data: { message: "spawn ENOENT" } }];
    const r = summarize(events);
    expect(r.stderrTail).toContain("spawn ENOENT");
    // A plain error event with no abort payload is not an abort.
    expect(r.error).toBeUndefined();
  });
});
