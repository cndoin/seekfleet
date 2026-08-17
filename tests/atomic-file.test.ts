import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLockSync, writeFileAtomicSync } from "../src/atomic-file.js";

describe("writeFileAtomicSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-atomic-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("replaces content without leaving temporary files", () => {
    const path = join(dir, "state.json");
    writeFileAtomicSync(path, "one");
    writeFileAtomicSync(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("releases a lock when the protected operation throws", () => {
    const lock = join(dir, "state.lock");
    expect(() =>
      withFileLockSync(lock, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(() => withFileLockSync(lock, () => "ok")).not.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
