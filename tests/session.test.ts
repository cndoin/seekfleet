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
    for (let i = 0; i < 1500; i++) store.appendEvent(s.runId, evt(i, "log"));
    const loaded = store.load(s.runId);
    expect(loaded?.events.length).toBe(1000);
    expect(loaded?.lastSeq).toBe(1499);
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
