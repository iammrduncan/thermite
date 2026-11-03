import { type LiveKind, liveText, summarizeArgs } from "../../../core/live.ts";
import { type CallUsage, callUsage } from "../../../core/usage.ts";
import type { FoundCompaction } from "../../compaction/index.ts";
import { type PlanWindows, type RateLimitInfo, windowsOf } from "./windows.ts";

/** Claude Code's stream-json output, read into a tally of turns, calls, usage and its windows. */

/** What Claude Code's stream-json output has said so far. */
export interface ClaudeTally {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  session?: string | undefined;
  errors: string[];
  lastText: string;
  /** Completed tool calls: their tool and what they returned (the model check reads these). */
  tools: { tool: string; output: string; ok: boolean }[];
  /** Its last lines that were not JSON. */
  notes: string[];
  /** The subscription's windows, from its latest rate-limit event. */
  usage?: PlanWindows | undefined;
  /** Set when a window is full: when it resets (ISO). */
  limitedUntil?: string | undefined;
  /** The final result's text, when the run ended with one. */
  result?: string | undefined;
  /** Each turn's tokens by message id (a message comes in several events). */
  messages: Map<string, { input: number; output: number }>;
  toolNames: Map<string, string>;
  /** Compactions it reported (compact_boundary) since they were last taken (goal 070). */
  compactions: FoundCompaction[];
  /** Each run's model usage, since they were last taken (goal 075). */
  calls: CallUsage[];
  /** The run under way: each model call's usage by its message's id, and when the run began. */
  run: Map<string, Usage>;
  runAt?: number | undefined;
}

export const newClaudeTally = (): ClaudeTally => ({
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  errors: [],
  lastText: "",
  tools: [],
  notes: [],
  messages: new Map(),
  toolNames: new Map(),
  compactions: [],
  calls: [],
  run: new Map(),
});

type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type Usage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};
type Event = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { id?: string; content?: Block[] | string; usage?: Usage };
  rate_limit_info?: RateLimitInfo;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  usage?: Usage;
  errors?: string[];
  /** A compaction's boundary (`system`, `compact_boundary`): its trigger and its tokens. */
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  /**
   * The result's times (ms): the run's, its time in API calls, and from the run's start to its
   * first token and to its first request.
   */
  duration_ms?: number;
  duration_api_ms?: number;
  ttft_ms?: number;
  time_to_request_ms?: number;
};

const tokensIn = (u: Usage | undefined) =>
  (u?.input_tokens ?? 0) +
  (u?.cache_creation_input_tokens ?? 0) +
  (u?.cache_read_input_tokens ?? 0);

const num = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);

/**
 * One run's usage from Claude Code's result (goal 075): every input token (Anthropic's input,
 * cache written and cache read), the cache read as cached, the output, and its time in API calls.
 * Claude Code gives a run's first token only from the run's start, so the time to its first
 * request is taken off. It names no reasoning tokens apart from the output. `calls`: the model
 * calls it made, where its stream showed them; null where it did not (its JSON output).
 */
export function claudeResultUsage(result: unknown, calls: number | null): CallUsage | undefined {
  if (!result || typeof result !== "object") return undefined;
  const e = result as Event;
  if (e.type !== "result" || !e.usage) return undefined;
  const ttft = num(e.ttft_ms);
  const toRequest = num(e.time_to_request_ms);
  const duration = num(e.duration_ms);
  return callUsage({
    at: Date.now() - (duration ?? 0),
    calls,
    tokensIn: tokensIn(e.usage),
    cachedIn: num(e.usage.cache_read_input_tokens) ?? null,
    tokensOut: e.usage.output_tokens ?? 0,
    reasoning: null,
    firstTokenMs:
      ttft !== undefined && toRequest !== undefined && ttft >= toRequest ? ttft - toRequest : null,
    callMs: num(e.duration_api_ms) ?? null,
  });
}

/**
 * A run of Claude Code that ended without its result (a submission or the trial's time ended it):
 * its calls' usage as its stream showed it, with no times, which only the result gives (goal 075).
 */
export function closeClaudeRun(t: ClaudeTally): void {
  if (t.run.size) {
    const all = [...t.run.values()];
    const has = all.every((u) => typeof u.cache_read_input_tokens === "number");
    t.calls.push(
      callUsage({
        at: t.runAt ?? Date.now(),
        calls: t.run.size,
        tokensIn: all.reduce((n, u) => n + tokensIn(u), 0),
        cachedIn: has ? all.reduce((n, u) => n + (u.cache_read_input_tokens ?? 0), 0) : null,
        tokensOut: all.reduce((n, u) => n + (u.output_tokens ?? 0), 0),
        reasoning: null,
        firstTokenMs: null,
        callMs: null,
      }),
    );
  }
  t.run.clear();
  t.runAt = undefined;
}

const iso = (seconds: number | undefined) =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : undefined;
const text = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((x) => (typeof x === "object" && x && "text" in x ? String(x.text) : "")).join("")
      : "";

/** Reads lines of Claude Code's stream-json output into the tally; returns them as live-view lines. */
export function readClaudeEvents(
  lines: string[],
  t: ClaudeTally,
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
    if (e.session_id) t.session = e.session_id;
    t.runAt ??= Date.now();
    switch (e.type) {
      // Claude Code compacted its conversation (goal 070): its own summary replaces the turns
      // before this point, and the session goes on.
      case "system": {
        if (e.subtype !== "compact_boundary") break;
        const c = e.compact_metadata ?? {};
        t.compactions.push({
          at: live.length,
          tokensBefore: typeof c.pre_tokens === "number" ? c.pre_tokens : null,
          tokensAfter: typeof c.post_tokens === "number" ? c.post_tokens : null,
        });
        break;
      }
      case "assistant": {
        const m = e.message ?? {};
        const id = m.id ?? `m${t.messages.size}`;
        if (!t.messages.has(id)) t.turns++;
        t.messages.set(id, { input: tokensIn(m.usage), output: m.usage?.output_tokens ?? 0 });
        t.run.set(id, m.usage ?? {});
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b.type === "text" && b.text) {
            t.lastText = b.text;
            live.push({ kind: "text", text: liveText(b.text) });
          } else if (b.type === "thinking" && b.thinking) {
            live.push({ kind: "thinking", text: liveText(b.thinking) });
          } else if (b.type === "tool_use") {
            t.toolCalls++;
            const tool = String(b.name ?? "tool");
            if (b.id) t.toolNames.set(b.id, tool);
            live.push({ kind: "tool", text: liveText(`${tool} ${summarizeArgs(b.input)}`) });
          }
        }
        let inSum = 0;
        let outSum = 0;
        for (const v of t.messages.values()) {
          inSum += v.input;
          outSum += v.output;
        }
        t.tokensIn = inSum;
        t.tokensOut = outSum;
        break;
      }
      case "user": {
        const content = e.message?.content;
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type !== "tool_result") continue;
          const tool = t.toolNames.get(b.tool_use_id ?? "") ?? "tool";
          const output = text(b.content);
          const ok = b.is_error !== true;
          t.tools.push({ tool, output: output.slice(0, 4000), ok });
          live.push({
            kind: "result",
            text: `${tool}${ok ? "" : " failed"}: ${output.slice(0, 1200)}`,
          });
        }
        break;
      }
      case "rate_limit_event": {
        const r = e.rate_limit_info ?? {};
        t.usage = windowsOf(r, t.usage);
        if (r.status && r.status !== "allowed" && r.status !== "allowed_warning") {
          t.limitedUntil = iso(r.resetsAt);
          const which = r.rateLimitType === "seven_day" ? "weekly" : "5-hour";
          live.push({
            kind: "text",
            text: `(Claude Code: the subscription's ${which} window is full${t.limitedUntil ? ` until ${t.limitedUntil}` : ""})`,
          });
        }
        break;
      }
      case "result": {
        if (typeof e.num_turns === "number") t.turns = Math.max(t.turns, e.num_turns);
        if (e.usage) {
          t.tokensIn = Math.max(t.tokensIn, tokensIn(e.usage));
          t.tokensOut = Math.max(t.tokensOut, e.usage.output_tokens ?? 0);
        }
        // The run's usage, from its result: its calls are the messages its stream showed.
        const u = claudeResultUsage(e, t.run.size || null);
        if (u) {
          t.calls.push(u);
          t.run.clear();
          t.runAt = undefined;
        } else closeClaudeRun(t);
        if (typeof e.result === "string") t.result = e.result;
        if (e.is_error) {
          const message = String(e.result ?? e.errors?.join("; ") ?? e.subtype ?? "error").slice(
            0,
            500,
          );
          t.errors.push(message);
          live.push({ kind: "text", text: `(Claude Code: ${message})` });
        }
        break;
      }
    }
  }
  return live;
}
