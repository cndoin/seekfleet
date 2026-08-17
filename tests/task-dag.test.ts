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
});
