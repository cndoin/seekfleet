import { describe, it, expect } from "vitest";
import { DagExecutor, type NodeRunner } from "../src/task-dag.js";

describe("DagExecutor", () => {
  const buildRunner =
    (results: Record<string, string>): NodeRunner =>
    async (task) => {
      const raw = String(task.task);
      const id = raw.split("=")[1] ?? raw;
      return {
        result: {
          answer: results[id] ?? "ok",
          toolCalls: [],
          toolResults: [],
          events: 1,
          durationMs: 1,
          exitCode: 0,
          stderrTail: "",
        },
      };
    };

  it("runs independent nodes in parallel within concurrency", async () => {
    const calls: string[] = [];
    const runner: NodeRunner = async (task) => {
      const raw = String(task.task);
      const id = raw.split("=")[1] ?? raw;
      calls.push("start:" + id);
      await new Promise((r) => setTimeout(r, 50));
      calls.push("end:" + id);
      return {
        result: { answer: id, toolCalls: [], toolResults: [], events: 1, durationMs: 1, exitCode: 0, stderrTail: "" },
      };
    };
    const exec = new DagExecutor(runner);
    const r = await exec.run({
      nodes: [
        { id: "a", task: "__test_id=a" },
        { id: "b", task: "__test_id=b" },
      ],
      concurrency: 2,
    });
    expect(r.order[0]?.sort()).toEqual(["a", "b"]);
    expect(r.failed).toEqual([]);
  });

  it("respects dependencies (b waits for a)", async () => {
    const exec = new DagExecutor(buildRunner({ a: "A", b: "B", c: "C" }));
    const r = await exec.run({
      nodes: [
        { id: "a", task: "__test_id=a" },
        { id: "b", task: "__test_id=b", dependsOn: ["a"] },
        { id: "c", task: "__test_id=c" },
      ],
    });
    const flat = r.order.flat();
    expect(flat.indexOf("a")).toBeLessThan(flat.indexOf("b"));
  });

  it("detects cycles", async () => {
    const exec = new DagExecutor(buildRunner({}));
    await expect(
      exec.run({
        nodes: [
          { id: "a", task: "a", dependsOn: ["b"] },
          { id: "b", task: "b", dependsOn: ["a"] },
        ],
      }),
    ).rejects.toThrow(/cycle/);
  });

  it("rejects duplicate node ids", async () => {
    const exec = new DagExecutor(buildRunner({}));
    await expect(
      exec.run({
        nodes: [
          { id: "a", task: "one" },
          { id: "a", task: "two" },
        ],
      }),
    ).rejects.toThrow(/duplicate/);
  });

  it("injects completed dependency answers into downstream tasks", async () => {
    let downstreamPrompt = "";
    const exec = new DagExecutor(async (task) => {
      if (task.task.startsWith("synthesize")) downstreamPrompt = task.task;
      return {
        result: {
          answer: task.task === "research" ? "finding-a" : "done",
          toolCalls: [],
          toolResults: [],
          events: 1,
          durationMs: 1,
          exitCode: 0,
          stderrTail: "",
        },
      };
    });
    await exec.run({
      nodes: [
        { id: "research", task: "research" },
        { id: "synthesis", task: "synthesize", dependsOn: ["research"] },
      ],
    });
    expect(downstreamPrompt).toContain("finding-a");
    expect(downstreamPrompt).toContain("dependency-results");
  });

  it("skips downstream when critical dep fails", async () => {
    const runner: NodeRunner = async (task) => {
      const raw = String(task.task);
      const id = raw.split("=")[1] ?? raw;
      if (id === "bad") throw new Error("intentional");
      return {
        result: { answer: id, toolCalls: [], toolResults: [], events: 1, durationMs: 1, exitCode: 0, stderrTail: "" },
      };
    };
    const exec = new DagExecutor(runner);
    const r = await exec.run({
      nodes: [
        { id: "bad", task: "__test_id=bad" },
        { id: "down", task: "__test_id=down", dependsOn: ["bad"] },
      ],
      abortOnFailure: false,
    });
    expect(r.nodes.find((n) => n.id === "down")?.status).toBe("skipped");
    expect(r.nodes.find((n) => n.id === "bad")?.status).toBe("failed");
  });

  it("marks a node failed when the runner resolves with a failed result", async () => {
    // route() resolves with soft failures instead of throwing, so a runner that
    // never throws can still hand back a crashed run. Status used to be keyed
    // off "did the promise resolve", which reported the crash as a success with
    // an empty answer and let downstream nodes run on garbage.
    const runner: NodeRunner = async (task) => {
      const id = String(task.task).split("=")[1] ?? "x";
      const failed = id === "bad";
      return {
        result: {
          answer: "",
          toolCalls: [],
          toolResults: [],
          events: 2,
          durationMs: 5,
          exitCode: failed ? 1 : 0,
          stderrTail: failed ? "dsh: MISSING_CREDENTIAL: no API key" : "",
          ...(failed ? { error: { message: "dsh exited with code 1", code: "EXIT_NONZERO" } } : {}),
        },
      };
    };
    const exec = new DagExecutor(runner);
    const r = await exec.run({
      nodes: [
        { id: "bad", task: "__test_id=bad" },
        { id: "down", task: "__test_id=down", dependsOn: ["bad"] },
        { id: "good", task: "__test_id=good" },
      ],
      abortOnFailure: false,
    });
    const bad = r.nodes.find((n) => n.id === "bad");
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toContain("exit");
    // The full result is retained so the caller can inspect stderr / exit code.
    expect(bad?.result?.exitCode).toBe(1);
    expect(r.failed).toContain("bad");
    expect(r.cacheHits).not.toContain("bad");
    expect(r.nodes.find((n) => n.id === "down")?.status).toBe("skipped");
    expect(r.nodes.find((n) => n.id === "good")?.status).toBe("ok");
  });

  it("treats a bare non-zero exit code as a failure", async () => {
    const exec = new DagExecutor(async () => ({
      result: {
        answer: "",
        toolCalls: [],
        toolResults: [],
        events: 1,
        durationMs: 1,
        exitCode: 7,
        stderrTail: "",
      },
    }));
    const r = await exec.run({ nodes: [{ id: "only", task: "x" }], abortOnFailure: false });
    expect(r.nodes[0]?.status).toBe("failed");
    expect(r.failed).toEqual(["only"]);
  });

  it("accounts for every node when the DAG aborts early", async () => {
    // An aborted 2-node DAG used to return a node list holding only the failed
    // node, so a caller could not distinguish "finished" from "stopped early".
    const runner: NodeRunner = async (task) => {
      const id = String(task.task).split("=")[1] ?? "x";
      const failed = id === "bad";
      return {
        result: {
          answer: failed ? "" : id,
          toolCalls: [],
          toolResults: [],
          events: 1,
          durationMs: 1,
          exitCode: failed ? 1 : 0,
          stderrTail: "",
        },
      };
    };
    const exec = new DagExecutor(runner);
    const r = await exec.run({
      nodes: [
        { id: "bad", task: "__test_id=bad" },
        { id: "never", task: "__test_id=never" },
      ],
      concurrency: 1,
      // abortOnFailure defaults to true
    });
    expect(r.aborted).toBe(true);
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes.find((n) => n.id === "bad")?.status).toBe("failed");
    const never = r.nodes.find((n) => n.id === "never");
    expect(never?.status).toBe("skipped");
    expect(never?.error).toContain("aborted");
  });
});
