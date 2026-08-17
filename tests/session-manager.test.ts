import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session-manager.js";
import type { DshEvent, DshResult } from "../src/types.js";

let dir: string;
let manager: SessionManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-sm-"));
  manager = new SessionManager({
    dshHome: dir,
    runner: async (task, ctx) => {
      const seqRef = { value: 0 };
      const emit = (kind: DshEvent["kind"], data: unknown): void => {
        ctx.onEvent({ kind, ts: Date.now(), seq: ++seqRef.value, data });
      };
      emit("log", { msg: "starting" });
      emit("answer", { answer: "ECHO: " + task.task });
      return {
        answer: "ECHO: " + task.task,
        toolCalls: [],
        toolResults: [],
        events: 2,
        durationMs: 1,
        exitCode: 0,
        stderrTail: "",
      } as DshResult;
    },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const waitFor = async (runId: string, status: string, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const s = manager.status(runId);
    if (s?.status === status) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout waiting for status " + status);
};

describe("SessionManager", () => {
  it("creates a queued session", () => {
    const r = manager.create({ task: "hello" });
    expect(r.status).toBe("queued");
    expect(r.task).toBe("hello");
  });

  it("start() runs to completion in background", async () => {
    const r = manager.create({ task: "x" });
    await manager.start(r.runId);
    await waitFor(r.runId, "succeeded");
    const status = manager.status(r.runId);
    expect(status?.status).toBe("succeeded");
    expect(status?.result?.answer).toBe("ECHO: x");
  });

  it("events() returns the streamed events", async () => {
    const r = manager.create({ task: "y" });
    await manager.start(r.runId);
    await waitFor(r.runId, "succeeded");
    const ev = manager.events(r.runId);
    expect(ev.events.length).toBeGreaterThan(0);
    expect(ev.events[0]?.kind).toBe("log");
  });

  it("cancel() marks the session as cancelled", async () => {
    const slow = new SessionManager({
      dshHome: dir,
      runner: async (_task, ctx) => {
        return new Promise<DshResult>((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(
            () =>
              resolve({
                answer: "never",
                toolCalls: [],
                toolResults: [],
                events: 0,
                durationMs: 1000,
                exitCode: 0,
                stderrTail: "",
              }),
            5000,
          );
        });
      },
    });
    const r = slow.create({ task: "slow" });
    await slow.start(r.runId);
    await new Promise((r) => setTimeout(r, 50));
    slow.cancel(r.runId);
    await waitFor(r.runId, "cancelled");
  });

  it("rehydrate marks running sessions as paused", async () => {
    const { SessionStore } = await import("../src/session.js");
    const fake = new SessionStore(dir);
    const r = fake.create({ task: "crashed" });
    fake.setStatus(r.runId, "running");
    // Now construct a fresh manager pointing to the same dir
    const fresh = new SessionManager({ dshHome: dir });
    const after = fresh.status(r.runId);
    expect(after?.status).toBe("paused");
  });

  it("result() returns the final DshResult", async () => {
    const r = manager.create({ task: "z" });
    await manager.start(r.runId);
    await waitFor(r.runId, "succeeded");
    const { result } = manager.result(r.runId);
    expect(result?.answer).toBe("ECHO: z");
  });

  it("delete() removes the record", () => {
    const r = manager.create({ task: "del" });
    expect(manager.delete(r.runId)).toBe(true);
    expect(manager.status(r.runId)).toBeNull();
  });

  it("list() returns most recent first", async () => {
    const a = manager.create({ task: "a" });
    await new Promise((r) => setTimeout(r, 5));
    const b = manager.create({ task: "b" });
    const list = manager.list();
    expect(list.length).toBe(2);
    expect(list[0]?.runId).toBe(b.runId);
    expect(list[1]?.runId).toBe(a.runId);
  });
});
