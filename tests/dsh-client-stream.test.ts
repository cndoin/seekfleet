import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClient } from "../src/dsh-client.js";

let root: string;
let dshHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fake-dsh-"));
  dshHome = join(root, "home");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "test", type: "module" }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("DshClient streaming", () => {
  it("yields output before the child process exits", async () => {
    writeFileSync(
      join(root, "lib", "bin.js"),
      "console.log(JSON.stringify({type:'log',message:'first'})); await new Promise(r=>setTimeout(r,300)); console.log(JSON.stringify({type:'answer',answer:'done'}));",
    );
    const client = new DshClient({ dshModuleRoot: root, dshHome });
    const startedAt = Date.now();
    let firstAt = 0;
    const events = [];
    for await (const event of client.stream({ task: "x", timeoutMs: 2000 })) {
      if (!firstAt) firstAt = Date.now();
      events.push(event);
    }
    expect(firstAt - startedAt).toBeLessThan(250);
    expect(events.some((event) => event.kind === "answer")).toBe(true);
    expect(events.at(-1)?.kind).toBe("exit");
  });

  it("keeps event sequence numbers unique across stdout and stderr", async () => {
    writeFileSync(join(root, "lib", "bin.js"), "console.log('one'); console.error('two'); console.log('three');");
    const client = new DshClient({ dshModuleRoot: root, dshHome });
    const events = [];
    for await (const event of client.stream({ task: "x", timeoutMs: 2000 })) events.push(event);
    const seqs = events.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
