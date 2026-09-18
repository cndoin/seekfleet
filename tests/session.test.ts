import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session.js";
import type { DshEvent } from "../src/types.js";

const evt = (seq: number, kind: DshEvent["kind"]): DshEvent => ({ kind, ts: Date.now(), seq, data: { seq } });

describe("SessionStore", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-sess-"));
    store = new SessionStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates and loads", () => {
    const s = store.create({ task: "x", profile: "headless" });
    expect(s.status).toBe("queued");
    const loaded = store.load(s.runId);
    expect(loaded?.runId).toBe(s.runId);
  });

  it("appends events with cap", () => {
    const s = store.create({ task: "x" });
    const startedAt = Date.now();
    for (let i = 0; i < 1500; i++) store.appendEvent(s.runId, evt(i, "log"));
    const elapsedMs = Date.now() - startedAt;
    const loaded = store.load(s.runId);
    expect(loaded?.events.length).toBe(1000);
    expect(loaded?.lastSeq).toBe(1499);
    // Each append used to be a full read-parse-write-with-fsync of the record,
    // making a 1500-event burst quadratic and blocking (it exceeded a 30s test
    // timeout). Assert a bound so a regression fails immediately with a useful
    // message instead of hanging.
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("flushes coalesced appends to disk on demand", () => {
    const s = store.create({ task: "flush" });
    store.appendEvent(s.runId, evt(1, "log"));
    store.appendEvent(s.runId, evt(2, "log"));
    // A different store has no in-memory view, so it proves the bytes landed.
    expect(new SessionStore(dir).load(s.runId)?.events.length ?? 0).toBe(0);
    store.flush();
    const reloaded = new SessionStore(dir).load(s.runId);
    expect(reloaded?.events.length).toBe(2);
    expect(reloaded?.lastSeq).toBe(2);
  });

  it("persists lifecycle changes synchronously", () => {
    const s = store.create({ task: "x" });
    store.setStatus(s.runId, "running");
    store.addCheckpoint(s.runId, { ts: Date.now(), costUsd: 0.02, inputTokens: 1, outputTokens: 2 });
    // No explicit flush: status and checkpoints must be durable immediately.
    const reloaded = new SessionStore(dir).load(s.runId);
    expect(reloaded?.status).toBe("running");
    expect(reloaded?.checkpoints.length).toBe(1);
  });

  it("transitions status", () => {
    const s = store.create({ task: "x" });
    store.setStatus(s.runId, "running");
    expect(store.load(s.runId)?.status).toBe("running");
    store.setStatus(s.runId, "succeeded");
    const loaded = store.load(s.runId);
    expect(loaded?.status).toBe("succeeded");
    expect(loaded?.finishedAt).toBeDefined();
  });

  it("survives reload (persistence)", () => {
    const s = store.create({ task: "x" });
    store.setStatus(s.runId, "running");
    store.addCheckpoint(s.runId, { ts: Date.now(), costUsd: 0.01, inputTokens: 100, outputTokens: 50 });
    // New store instance reads the same dir
    const store2 = new SessionStore(dir);
    const loaded = store2.load(s.runId);
    expect(loaded?.status).toBe("running");
    expect(loaded?.checkpoints.length).toBe(1);
  });

  it("lists and filters", () => {
    const a = store.create({ task: "a" });
    const b = store.create({ task: "b" });
    store.setStatus(a.runId, "succeeded");
    store.setStatus(b.runId, "running");
    expect(store.list().length).toBe(2);
    expect(store.findByStatus("running").length).toBe(1);
  });

  it("persists file on disk", () => {
    const s = store.create({ task: "x" });
    expect(existsSync(join(dir, "sessions", s.runId + ".json"))).toBe(true);
  });

  it("rejects run ids that could escape the session directory", () => {
    expect(store.load("../outside")).toBeNull();
    expect(store.patch("..\\outside", (record) => record)).toBeNull();
    expect(() => store.delete("../outside")).not.toThrow();
  });
});
