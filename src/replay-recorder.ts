// replay-recorder.ts - record and replay task event streams.
//
// Use cases:
//   - debugging: record a real run, then replay it offline to study behavior
//   - testing: feed recorded events back into a parser to verify event handling
//   - sharing: ship a .dshreplay file that others can replay

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DshEvent } from "./types.js";
import { writeFileAtomicSync } from "./atomic-file.js";

export interface ReplayHeader {
  version: 1;
  recordedAt: number;
  instanceLabel: string;
  profile: string;
  task: string;
  tags?: string[];
  exitCode: number | null;
  durationMs: number;
  /** total events recorded */
  events: number;
  /** SHA256 of header for integrity */
  sha256?: string;
}

export interface ReplayFile {
  header: ReplayHeader;
  events: DshEvent[];
}

export class ReplayRecorder {
  private events: DshEvent[] = [];
  private startedAt = Date.now();
  private taskMeta: { task: string; instanceLabel: string; profile: string; tags?: string[] };

  constructor(meta: { task: string; instanceLabel: string; profile: string; tags?: string[] }) {
    this.taskMeta = meta;
  }

  /** Call for every event seen during streaming. */
  record(evt: DshEvent): void {
    this.events.push(evt);
  }

  /** Stop recording; returns the full ReplayFile. */
  finalize(meta: { exitCode: number | null; durationMs: number }): ReplayFile {
    const header: ReplayHeader = {
      version: 1,
      recordedAt: this.startedAt,
      instanceLabel: this.taskMeta.instanceLabel,
      profile: this.taskMeta.profile,
      task: this.taskMeta.task,
      tags: this.taskMeta.tags,
      exitCode: meta.exitCode,
      durationMs: meta.durationMs,
      events: this.events.length,
    };
    return { header, events: this.events };
  }

  /** Save a ReplayFile to disk. */
  static save(file: ReplayFile, dir: string, name?: string): string {
    mkdirSync(dir, { recursive: true });
    const fileName = (name ?? "replay-" + file.header.recordedAt + "-" + file.header.instanceLabel + ".json").replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );
    const path = join(dir, fileName);
    writeFileAtomicSync(path, JSON.stringify(file, null, 2));
    return path;
  }

  /** Load a ReplayFile from disk. */
  static load(path: string): ReplayFile {
    if (!existsSync(path)) throw new Error("replay file not found: " + path);
    return JSON.parse(readFileSync(path, "utf8")) as ReplayFile;
  }

  /** Replay events through a handler in chronological order, with optional speed multiplier. */
  static async play(
    file: ReplayFile,
    handler: (evt: DshEvent, idx: number) => void | Promise<void>,
    speed = 0,
  ): Promise<void> {
    let prevTs = file.events[0]?.ts ?? 0;
    for (let i = 0; i < file.events.length; i++) {
      const evt = file.events[i]!;
      if (speed > 0) {
        const gap = (evt.ts - prevTs) / speed;
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      }
      await handler(evt, i);
      prevTs = evt.ts;
    }
  }

  /** Extract just the answers and tool calls for a quick summary. */
  static summarize(file: ReplayFile): {
    answers: string[];
    toolCalls: Array<{ name: string; args: unknown }>;
    toolResults: number;
    errors: string[];
  } {
    const answers: string[] = [];
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    const errors: string[] = [];
    let toolResults = 0;
    for (const e of file.events) {
      if (e.kind === "answer") {
        const d = e.data as { line?: string; answer?: string; text?: string; final?: string };
        const t = d.answer ?? d.final ?? d.text ?? d.line ?? "";
        if (t) answers.push(t);
      } else if (e.kind === "tool_call") {
        const d = e.data as { tool_call?: { name: string; args: unknown }; tool?: { name: string; args: unknown } };
        const tc = d.tool_call ?? d.tool;
        if (tc) toolCalls.push({ name: tc.name, args: tc.args });
      } else if (e.kind === "tool_result") {
        toolResults++;
      } else if (e.kind === "error") {
        const d = e.data as { message?: string };
        if (d.message) errors.push(d.message);
      }
    }
    return { answers, toolCalls, toolResults, errors };
  }
}
