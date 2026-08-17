// DshClient - single-instance wrapper around one dsh subprocess.
//
// Spawns `node <bin.js> --profile <name> [args...]` and yields a stream of
// DshEvent. The `run` helper returns a Promise<DshResult>; the `stream`
// method returns an AsyncIterable<DshEvent>; the `serve` method boots a
// long-running profile (e.g. web) and exposes a handle.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve as resolvePath } from "node:path";
import { classifyLine } from "./event-parser.js";
function classifyLineSync(line: string, seqRef: { value: number }): DshEvent {
  return classifyLine(line, seqRef);
}
import { resolveDsh, type ResolvedDsh } from "./install.js";
import type { DshEvent, DshResult, DshTask, DshToolInvocation, DshToolResult, DshUsage } from "./types.js";
import { PolicyEnforcer } from "./policy-enforcer.js";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024; // 64 MiB

function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(proc.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    } catch {
      try {
        proc.kill(signal);
      } catch {
        /* best effort */
      }
    }
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* best effort */
    }
  }
}

export interface DshClientOptions {
  dshModuleRoot?: string;
  dshHome?: string;
  workspace?: string;
  installIfMissing?: boolean;
  defaultProfile?: string;
  defaultTimeoutMs?: number;
  /** P0-10: max total bytes (stdout + stderr) before the process is killed. Default 64 MiB. */
  maxOutputBytes?: number;
  /** PART-2: pre-execution policy gate */
  policy?: PolicyEnforcer | import("./policy.js").Policy;
}

interface AsyncQueue<T> {
  push(item: T): void;
  end(): void;
  iterator: AsyncIterableIterator<T>;
}

function makeAsyncQueue<T>(maxBuffered = 10_000): AsyncQueue<T> {
  const buf: T[] = [];
  let waiting: ((v: IteratorResult<T>) => void) | null = null;
  let closed = false;
  const iter: AsyncIterableIterator<T> = {
    next() {
      if (buf.length > 0) return Promise.resolve({ value: buf.shift() as T, done: false });
      if (closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    return() {
      closed = true;
      const w = waiting;
      waiting = null;
      if (w) w({ value: undefined as unknown as T, done: true });
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    },
    [Symbol.asyncIterator]() {
      return iter;
    },
  } as AsyncIterableIterator<T>;
  return {
    push(item: T) {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: item, done: false });
      } else {
        buf.push(item);
        // A stalled consumer must not be able to grow the process indefinitely.
        if (buf.length > maxBuffered) buf.splice(0, buf.length - maxBuffered);
      }
    },
    end() {
      closed = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: undefined as unknown as T, done: true });
      }
    },
    iterator: iter,
  };
}

export class DshClient extends EventEmitter {
  readonly resolved: ResolvedDsh;
  readonly defaultProfile: string;
  readonly defaultTimeoutMs: number;
  readonly maxOutputBytes: number;
  /** PART-2: optional pre-execution policy gate. */
  readonly policy?: PolicyEnforcer;

  constructor(opts: DshClientOptions = {}) {
    super();
    this.resolved = resolveDsh({
      dshModuleRoot: opts.dshModuleRoot,
      dshHome: opts.dshHome,
      workspace: opts.workspace,
      installIfMissing: opts.installIfMissing,
    });
    this.defaultProfile = opts.defaultProfile ?? "headless";
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10 * 60 * 1000;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (opts.policy) {
      this.policy = opts.policy instanceof PolicyEnforcer ? opts.policy : new PolicyEnforcer(opts.policy);
    }
  }

  /** One-shot headless task. */
  async run(task: DshTask): Promise<DshResult> {
    const validated = this.policy ? this.policy.assert(task) : task;
    const events: DshEvent[] = [];
    for await (const evt of this.stream(validated)) events.push(evt);
    return summarize(events);
  }

  /** Streaming version of run. Yields every DshEvent as it arrives. */
  stream(task: DshTask): AsyncIterable<DshEvent> {
    const validated = this.policy ? this.policy.assert(task) : task;
    return this._stream(validated);
  }

  private async *_stream(task: DshTask): AsyncGenerator<DshEvent> {
    const proc = this.spawnProc(task);
    const start = Date.now();
    let aborted = false;
    // P0-10: track max output bytes per stream; abort if exceeded
    const maxOutputBytes = task.maxOutputBytes ?? this.maxOutputBytes;

    const queue = makeAsyncQueue<DshEvent>();

    let forceKillTimer: NodeJS.Timeout | undefined;
    const killTree = (signal: NodeJS.Signals) => killProcessTree(proc, signal);

    const timer = setTimeout(() => {
      aborted = true;
      killTree("SIGTERM");
      forceKillTimer = setTimeout(() => killTree("SIGKILL"), 5000);
    }, task.timeoutMs ?? this.defaultTimeoutMs);

    let signalListener: (() => void) | undefined;
    // P0-10: track output bytes; abort if exceeded. These are mutated by the
    // stdout/stderr data handlers further down.
    let stdoutBytes = 0;
    let stderrBytes = 0;
    if (task.signal) {
      const onAbort = () => {
        aborted = true;
        killTree("SIGTERM");
        forceKillTimer = setTimeout(() => killTree("SIGKILL"), 5000);
      };
      if (task.signal.aborted) {
        onAbort();
      } else {
        task.signal.addEventListener("abort", onAbort, { once: true });
        signalListener = onAbort;
      }
    }

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");

    // Line-by-line classification via the shared split2-based classifier.
    // split2 module is wired in event-parser.ts for use by callers that want a Transform;
    // here we use the sync classifier directly on chunked lines for lower overhead.
    let stdoutBuf = "";
    let stderrBuf = "";
    // Sequence zero is reserved as the polling cursor before the first event.
    let eventSeq = 1;
    const handleChunk = (chunk: string, buf: string, seqRef: { value: number }, stderr: boolean) => {
      buf += chunk;
      const events: DshEvent[] = [];
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        const evt = classifyLineSync(line, seqRef);
        if (stderr) (evt as DshEvent).kind = "stderr";
        events.push(evt);
      }
      return { remaining: buf, events };
    };

    proc.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (maxOutputBytes > 0 && stdoutBytes + stderrBytes > maxOutputBytes) {
        aborted = true;
        killTree("SIGTERM");
        forceKillTimer = setTimeout(() => killTree("SIGKILL"), 5000);
        return;
      }
      const r = handleChunk(
        chunk,
        stdoutBuf,
        {
          get value() {
            return eventSeq;
          },
          set value(v: number) {
            eventSeq = v;
          },
        },
        false,
      );
      stdoutBuf = r.remaining;
      for (const evt of r.events) {
        queue.push(evt);
        this.emit("event", evt);
      }
    });
    proc.stderr?.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (maxOutputBytes > 0 && stdoutBytes + stderrBytes > maxOutputBytes) {
        aborted = true;
        killTree("SIGTERM");
        forceKillTimer = setTimeout(() => killTree("SIGKILL"), 5000);
        return;
      }
      const r = handleChunk(
        chunk,
        stderrBuf,
        {
          get value() {
            return eventSeq;
          },
          set value(v: number) {
            eventSeq = v;
          },
        },
        true,
      );
      stderrBuf = r.remaining;
      for (const evt of r.events) {
        queue.push(evt);
        this.emit("event", evt);
      }
    });

    let closed = false;
    const completion = new Promise<void>((resolveP) => {
      const finish = (exitCode: number | null) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (signalListener && task.signal) task.signal.removeEventListener("abort", signalListener);

        // Flush any trailing partial line before the terminal event.
        if (stdoutBuf.length > 0) {
          const evt = classifyLineSync(stdoutBuf, { value: eventSeq++ });
          queue.push(evt);
          this.emit("event", evt);
        }
        if (stderrBuf.length > 0) {
          const evt = classifyLineSync(stderrBuf, { value: eventSeq++ });
          evt.kind = "stderr";
          queue.push(evt);
          this.emit("event", evt);
        }
        const finalEvt: DshEvent = {
          kind: aborted ? "error" : "exit",
          ts: Date.now(),
          seq: eventSeq++,
          data: { exitCode, durationMs: Date.now() - start, aborted },
        };
        queue.push(finalEvt);
        this.emit("event", finalEvt);
        queue.end();
        resolveP();
      };
      proc.once("close", (code) => finish(code));
      proc.once("error", () => finish(null));
    });

    try {
      // Consume while the child is running; this is a real-time stream.
      for await (const evt of queue.iterator) yield evt;
      await completion;
    } finally {
      if (!closed) {
        aborted = true;
        killTree("SIGTERM");
        forceKillTimer = setTimeout(() => killTree("SIGKILL"), 5000);
      }
    }
  }

  /** Boot a long-running profile (e.g. web). Returns a handle with the child pid and a kill() method. */
  serve(
    args: { profile?: string; extraArgs?: string[]; cwd?: string; env?: Record<string, string> } = {},
  ): DshServerHandle {
    const profile = args.profile ?? "web";
    const cliArgs = ["--profile", profile, ...(args.extraArgs ?? [])];
    const env = {
      ...process.env,
      DSH_HOME: this.resolved.dshHome,
      ...(args.env ?? {}),
    } as NodeJS.ProcessEnv;
    const spawnOpts: SpawnOptions = {
      cwd: args.cwd ? resolvePath(args.cwd) : process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    };
    const proc = spawn(process.execPath, [this.resolved.binJs, ...cliArgs], spawnOpts);
    return new DshServerHandle(proc, profile);
  }

  private spawnProc(task: DshTask): ChildProcess {
    const profile = task.profile ?? this.defaultProfile;
    const cliArgs: string[] = ["--profile", profile];
    for (const p of task.patches ?? []) cliArgs.push("--patch", p);
    cliArgs.push(task.task);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: this.resolved.dshHome,
      ...(task.env ?? {}),
    };
    const spawnOpts: SpawnOptions = {
      cwd: task.cwd ? resolvePath(task.cwd) : process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    };
    return spawn(process.execPath, [this.resolved.binJs, ...cliArgs], spawnOpts);
  }
}

export class DshServerHandle {
  readonly proc: ChildProcess;
  readonly profile: string;
  readonly startedAt: number;
  private killed = false;

  constructor(proc: ChildProcess, profile: string) {
    this.proc = proc;
    this.profile = profile;
    this.startedAt = Date.now();
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  stdout(): NodeJS.ReadableStream | null {
    return this.proc.stdout;
  }
  stderr(): NodeJS.ReadableStream | null {
    return this.proc.stderr;
  }

  async waitForExit(): Promise<number | null> {
    return await new Promise((resolveP) => {
      this.proc.on("close", (code) => resolveP(code));
      this.proc.on("error", () => resolveP(null));
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.killed && signal !== "SIGKILL") return;
    this.killed = true;
    killProcessTree(this.proc, signal);
  }
}

export function summarize(events: DshEvent[]): DshResult {
  let answer = "";
  let usage: DshUsage | undefined;
  const toolCalls: DshToolInvocation[] = [];
  const toolResults: DshToolResult[] = [];
  let exitCode: number | null = null;
  let aborted = false;
  let durationMs = 0;
  const stderrLines: string[] = [];

  for (const e of events) {
    if (e.kind === "answer") {
      const d = e.data as { line?: string; answer?: string; text?: string; final?: string };
      const text = d.answer ?? d.final ?? d.text ?? d.line ?? "";
      if (typeof text === "string" && text.length > 0) {
        if (answer.length === 0) answer = text;
        else answer += "\n" + text;
      }
    } else if (e.kind === "tool_call") {
      const d = e.data as {
        tool_call?: { name: string; args: unknown };
        tool?: { name: string; args: unknown };
        name?: string;
        args?: unknown;
      };
      const tc = d.tool_call ?? d.tool ?? { name: d.name ?? "", args: d.args };
      if (tc.name) toolCalls.push({ name: tc.name, args: tc.args });
    } else if (e.kind === "tool_result") {
      const d = e.data as {
        tool_result?: DshToolResult;
        result?: { name: string; ok: boolean; output: unknown; durationMs?: number };
        name?: string;
        ok?: boolean;
        output?: unknown;
        durationMs?: number;
      };
      const tr = d.tool_result ??
        d.result ?? { name: d.name ?? "", ok: !!d.ok, output: d.output, durationMs: d.durationMs ?? 0 };
      if (tr.name) toolResults.push({ name: tr.name, ok: tr.ok, output: tr.output, durationMs: tr.durationMs ?? 0 });
    } else if (e.kind === "usage") {
      const d = e.data as { usage?: DshUsage };
      if (d.usage) usage = d.usage;
    } else if (e.kind === "stderr") {
      const d = e.data as { line?: string };
      if (typeof d.line === "string") stderrLines.push(d.line);
    } else if (e.kind === "exit") {
      const d = e.data as { exitCode: number | null; durationMs: number; aborted: boolean };
      exitCode = d.exitCode;
      durationMs = d.durationMs;
      aborted = d.aborted;
    } else if (e.kind === "error") {
      const d = e.data as { message?: string };
      if (typeof d.message === "string") stderrLines.push("[error] " + d.message);
    }
  }

  const stderrTail = stderrLines.slice(-20).join("\n");

  if (aborted && !answer) {
    return {
      answer: "",
      usage,
      toolCalls,
      toolResults,
      events: events.length,
      durationMs,
      exitCode,
      stderrTail,
      error: { message: "task aborted or timed out", code: "ABORTED" },
    };
  }

  return { answer, usage, toolCalls, toolResults, events: events.length, durationMs, exitCode, stderrTail };
}
