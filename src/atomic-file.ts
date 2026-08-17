import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function renameWithRetry(source: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(source, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !["EACCES", "EBUSY", "EPERM"].includes(code ?? "")) throw err;
      sleepSync(10 * 2 ** attempt);
    }
  }
}

/** Atomically replace a file through a unique temporary sibling. */
export function writeFileAtomicSync(path: string, data: string | NodeJS.ArrayBufferView): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameWithRetry(tmp, path);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* renamed successfully or already cleaned up */
    }
  }
}

/** Serialize a short read-modify-write section across local processes. */
export function withFileLockSync<T>(lockPath: string, fn: () => T, timeoutMs = 5_000): T {
  const started = Date.now();
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
      } catch {
        /* another process released it */
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for file lock: ${lockPath}`);
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
    }
  }
}
