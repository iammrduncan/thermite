import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { type LiveKind, liveText, summarizeArgs } from "../../../core/live.ts";
import { type CallUsage, callUsage } from "../../../core/usage.ts";

/** OpenCode's JSON output, read into a tally of turns, calls and usage (moved out of opencode.ts). */

/** What OpenCode's JSON output has said so far. */
export interface OpencodeTally {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  session?: string | undefined;
  errors: string[];
  lastText: string;
  /** Completed tool calls: their tool and what they returned (the model check reads these). */
  tools: { tool: string; output: string; ok: boolean }[];
  /** Its last lines that were not JSON (it prints startup errors that way). */
  notes: string[];
  /** Each step's model usage, since they were last taken (goal 075). */
  calls: CallUsage[];
  /** The step under way: when it started, its first part's start, and whether it ran a tool. */
  step?: { start: number | undefined; first: number | undefined; tools: boolean } | undefined;
}

export const newTally = (): OpencodeTally => ({
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: [],
  lastText: "",
  tools: [],
  notes: [],
  calls: [],
});

type Event = {
  type?: string;
  /** When OpenCode recorded the event (ms). */
  timestamp?: number;
  sessionID?: string;
  part?: {
    text?: string;
    tool?: string;
    /** A text's or reasoning's start and end (ms). */
    time?: { start?: number; end?: number };
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
      time?: { start?: number; end?: number };
    };
    /** OpenCode's TokenUsage.Info: input not cached, visible output, reasoning, cache. */
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  error?: { message?: string; type?: string };
};

const num = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);

/** A part of the step under way began at `at`: the step's first token is the earliest. */
function partAt(t: OpencodeTally, at: unknown): void {
  const n = num(at);
  if (t.step && n !== undefined) t.step.first = Math.min(t.step.first ?? n, n);
}

/**
 * A step's usage (goal 075), from OpenCode's step_finish and the lines before it. OpenCode's own
 * tokens leave the cache out of `input` and the reasoning out of `output`, so they are added back:
 * in counts every input token, out every output token. A step ends only after the tools it ran,
 * so its time is a model call's only for a step that ran none; the first token is the earliest
 * text, reasoning or tool call the step began.
 */
function stepUsage(t: OpencodeTally, e: Event): CallUsage | undefined {
  const k = e.part?.tokens;
  if (!k) return undefined;
  const s = t.step;
  const end = num(e.timestamp);
  const start = s?.start ?? end ?? Date.now();
  const read = num(k.cache?.read);
  const write = num(k.cache?.write) ?? 0;
  const reasoning = num(k.reasoning);
  return callUsage({
    at: start,
    calls: 1,
    tokensIn: (k.input ?? 0) + (read !== undefined ? read + write : 0),
    cachedIn: read ?? null,
    tokensOut: (k.output ?? 0) + (reasoning ?? 0),
    reasoning: reasoning ?? null,
    firstTokenMs:
      s?.start !== undefined && s.first !== undefined && s.first >= s.start
        ? s.first - s.start
        : null,
    callMs: s?.start !== undefined && end !== undefined && !s.tools ? end - s.start : null,
  });
}

/** Reads lines of OpenCode's JSON output into the tally; returns them as live-view lines. */
export function readOpencodeEvents(
  lines: string[],
  t: OpencodeTally,
): { kind: LiveKind; text: string }[] {
  const live: { kind: LiveKind; text: string }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      t.notes = [...t.notes, line.slice(0, 500)].slice(-5);
      continue;
    }
    if (e.sessionID) t.session = e.sessionID;
    const p = e.part ?? {};
    switch (e.type) {
      case "step_start":
        t.step = { start: num(e.timestamp), first: undefined, tools: false };
        break;
      case "text":
        partAt(t, p.time?.start);
        if (p.text) {
          t.lastText = p.text;
          live.push({ kind: "text", text: liveText(p.text) });
        }
        break;
      case "reasoning":
        partAt(t, p.time?.start);
        break;
      case "tool_use": {
        t.toolCalls++;
        if (t.step) t.step.tools = true;
        partAt(t, p.state?.time?.start);
        const tool = String(p.tool ?? "tool");
        const st = p.state ?? {};
        const ok = st.status === "completed";
        const output = String(st.output ?? st.error ?? "");
        t.tools.push({ tool, output: output.slice(0, 4000), ok });
        live.push({ kind: "tool", text: liveText(`${tool} ${summarizeArgs(st.input)}`) });
        live.push({
          kind: "result",
          text: `${tool}${ok ? "" : " failed"}: ${output.slice(0, 1200)}`,
        });
        break;
      }
      case "step_finish": {
        t.turns++;
        t.tokensIn += p.tokens?.input ?? 0;
        t.tokensOut += (p.tokens?.output ?? 0) + (p.tokens?.reasoning ?? 0);
        const u = stepUsage(t, e);
        if (u) t.calls.push(u);
        t.step = undefined;
        break;
      }
      case "error": {
        const message = String(e.error?.message ?? e.error?.type ?? "error").slice(0, 500);
        t.errors.push(message);
        live.push({ kind: "text", text: `(OpenCode: ${message})` });
        break;
      }
    }
  }
  return live;
}

/** The most bytes of a growing file one read takes; the rest waits for the next read. */
export const READ_NEW_MAX = 4 * 1024 * 1024;

/**
 * Reads what a growing file gained since `from`: whole lines only, at most `max` bytes. `more`:
 * the read stopped at `max`, and the file holds more now. A line longer than `max` is passed over
 * in steps of `max`; its last part then reads as a line of its own. The file is the lane's (a
 * program's run appends to it), so it is read as a plain file and never through a link.
 */
export function readNew(
  path: string,
  from: number,
  max = READ_NEW_MAX,
): { lines: string[]; next: number; more: boolean } {
  const nothing = { lines: [], next: from, more: false };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return nothing;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size <= from) return nothing;
    const buf = Buffer.alloc(Math.min(st.size - from, max));
    const got = readSync(fd, buf, 0, buf.length, from);
    const more = got === max && st.size - from > max;
    const end = buf.subarray(0, got).lastIndexOf(0x0a);
    if (end < 0) return more ? { lines: [], next: from + got, more } : nothing;
    return {
      lines: buf.subarray(0, end).toString("utf8").split("\n"),
      next: from + end + 1,
      more,
    };
  } catch {
    return nothing;
  } finally {
    closeSync(fd);
  }
}
