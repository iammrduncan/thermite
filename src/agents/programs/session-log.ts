import type { Harness } from "../../core/agents.ts";
import type { CallUsage } from "../../core/usage.ts";

/**
 * The session logs the agent programs keep of their own (goal 169), read into one set of events:
 * Claude Code's transcript (claude-code/transcript.ts), the Codex CLI's rollout (codex/rollout.ts),
 * and OpenCode's events and messages (opencode/session-events.ts). Each adapter is pure: it takes
 * batches of new whole lines and keeps its own state, so a log can be followed as it grows or read
 * whole. The formats are the programs' own and can change with any release, so each adapter counts
 * the kinds of record it neither reads nor leaves out on purpose, and the tests on recorded logs
 * fail on any.
 *
 * Today's readers of each program's headless output (its events.ts) still make a trial's record.
 * A tally of the events (tallyEvents) gives the counts theirs give, so the two can be compared.
 */

/**
 * Where a message on the user's side came from, as far as the log says:
 * - prompt: it opened a turn (typed, given on the command line, or sent through a server);
 * - steer: it was taken in while the program worked, within the turn;
 * - queued: it was held until a turn ended and then sent as the next one (OpenCode's queue);
 * - hook: a hook's words that sent the program on (a Stop hook that blocks);
 * - auto: the program's own, as when it goes on by itself after a usage limit resets;
 * - peer: another session's message (Claude Code's messaging socket).
 */
export type UserOrigin = "prompt" | "steer" | "queued" | "hook" | "auto" | "peer";

/**
 * How a turn ended: the program finished, it was interrupted, a call failed, a usage limit
 * stopped it, or the log gave no word (a new turn began, or the program stopped without one).
 */
export type TurnEnd = "done" | "interrupted" | "error" | "limit" | "unknown";

/** One thing a session log says. */
export type SessionEvent =
  /** The session's id, when it is first seen or changes. */
  | { type: "session"; id: string }
  | { type: "turn.started"; turnId?: string | undefined }
  | { type: "turn.ended"; reason: TurnEnd; error?: string | undefined }
  | { type: "user"; origin: UserOrigin; text: string }
  | { type: "assistant.text"; messageId: string; text: string }
  | { type: "tool.call"; id: string; name: string; input: unknown }
  /** `ok` is left out when the log does not say whether the call worked. */
  | { type: "tool.result"; id: string; ok?: boolean | undefined; output: string }
  /** One model call's usage, given once however many records repeat it. */
  | { type: "usage"; call: CallUsage }
  /** A usage limit: its window, when it resets (ISO) and the program's words, where it says. */
  | {
      type: "limit";
      window?: string | undefined;
      resetsAt?: string | undefined;
      overage?: string | undefined;
      message?: string | undefined;
    }
  | { type: "queue"; op: "enqueue" | "deliver" | "remove"; text?: string | undefined }
  | { type: "compaction"; tokensBefore?: number | undefined }
  /** The program ended cleanly, with its own totals where it gives them. */
  | { type: "session.end"; totals?: { tokensIn: number; tokensOut: number } | undefined };

/** One program's session-log adapter. It reads only the lines it is given. */
export interface SessionLogAdapter<S> {
  id: Exclude<Harness, "pi">;
  /**
   * What one of the tally's turns is, as the program's headless reader counts it: each model
   * call (Claude Code, OpenCode), or each message and each tool call (Codex).
   */
  turns: "calls" | "items";
  newState(): S;
  /** Reads a batch of new whole lines into events; empty lines are skipped. */
  read(lines: string[], s: S): SessionEvent[];
  /** The kinds of record read so far that it neither reads nor leaves out on purpose, counted. */
  unknown(s: S): Map<string, number>;
}

// ------------------------------------------------------------------ what the adapters share

/** The most kinds of unknown record kept by name; more are counted under one name. */
const UNKNOWN_KINDS_MAX = 100;
/**
 * The most ids an adapter remembers in one set (one for each model call or message); past it, the
 * oldest are forgotten.
 */
const SEEN_MAX = 100_000;
/** The most characters of a tool's output an event keeps; the rest is cut. */
export const OUTPUT_MAX = 16_000;

/** Counts a kind of record the adapter does not know. */
export function countUnknown(unknown: Map<string, number>, kind: string): void {
  const k = unknown.has(kind) || unknown.size < UNKNOWN_KINDS_MAX ? kind : "(more kinds)";
  unknown.set(k, (unknown.get(k) ?? 0) + 1);
}

/** Adds an id to a set of those seen, forgetting the oldest past SEEN_MAX. */
export function remember(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size > SEEN_MAX) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
}

/** A line as JSON, or undefined when it is not JSON. */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The text of a message's content: a string, or the `text` of each part of a list. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
        ? (c as { text: string }).text
        : "",
    )
    .join("");
}

/** A turn opens; one still open had no end in the log, which says so. */
export function startTurn(
  s: { turn: boolean },
  out: SessionEvent[],
  turnId?: string | undefined,
): void {
  if (s.turn) out.push({ type: "turn.ended", reason: "unknown" });
  s.turn = true;
  out.push({ type: "turn.started", ...(turnId ? { turnId } : {}) });
}

/** The open turn ends; nothing happens when none is open. */
export function endTurn(
  s: { turn: boolean },
  out: SessionEvent[],
  reason: TurnEnd,
  error?: string | undefined,
): void {
  if (!s.turn) return;
  s.turn = false;
  out.push({ type: "turn.ended", reason, ...(error ? { error } : {}) });
}

// ------------------------------------------------------------------ the tally

/**
 * What a session's events add up to: the counts today's headless readers keep for a trial
 * (the harness's CliTally), with the same meaning. Tokens in count every input token, cached or
 * not, as CallUsage does.
 */
export interface SessionTally {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  session?: string | undefined;
  lastText: string;
  /** Each call failure or usage limit that ended a turn, in words. */
  errors: string[];
  /** Completed tool calls: their tool and what they returned. */
  tools: { tool: string; output: string; ok: boolean }[];
  calls: CallUsage[];
  /** Each tool call's name by its id, for its result. */
  names: Map<string, string>;
}

export const newSessionTally = (): SessionTally => ({
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  lastText: "",
  errors: [],
  tools: [],
  calls: [],
  names: new Map(),
});

/** Adds events to a tally; `turns` is the adapter's rule for what one turn is. */
export function tallyEvents(
  t: SessionTally,
  events: readonly SessionEvent[],
  turns: SessionLogAdapter<unknown>["turns"],
): void {
  for (const e of events) {
    switch (e.type) {
      case "session":
        t.session = e.id;
        break;
      case "assistant.text":
        if (turns === "items") t.turns++;
        if (e.text) t.lastText = e.text;
        break;
      case "tool.call":
        if (turns === "items") t.turns++;
        t.toolCalls++;
        t.names.set(e.id, e.name);
        break;
      case "tool.result":
        // As today's readers say it: worked, unless the program said it did not.
        t.tools.push({
          tool: t.names.get(e.id) ?? "tool",
          output: e.output.slice(0, 4000),
          ok: e.ok !== false,
        });
        break;
      case "usage":
        if (turns === "calls") t.turns++;
        t.calls.push(e.call);
        t.tokensIn += e.call.tokens_in;
        t.tokensOut += e.call.tokens_out;
        break;
      case "turn.ended":
        if (e.reason === "error" || e.reason === "limit") t.errors.push(e.error ?? e.reason);
        break;
    }
  }
}

/**
 * A whole log read at once: its tally, and the kinds of record the adapter did not know. A last
 * line without its newline is left out: the program may be writing it still.
 */
export function tallyLog<S>(
  adapter: SessionLogAdapter<S>,
  text: string,
): { tally: SessionTally; unknown: Map<string, number> } {
  const s = adapter.newState();
  const tally = newSessionTally();
  const lines = text.split("\n");
  lines.pop();
  tallyEvents(tally, adapter.read(lines, s), adapter.turns);
  return { tally, unknown: adapter.unknown(s) };
}

/** The counts two tallies of one session can be compared on. */
export type TallyCounts = Pick<
  SessionTally,
  "turns" | "toolCalls" | "tokensIn" | "tokensOut" | "session" | "lastText"
>;

/**
 * Where two tallies of one session disagree: each count that differs, with both values. The last
 * text is given by its length, so a log line carries none of the agent's words.
 */
export function tallyDifferences(
  output: TallyCounts,
  log: TallyCounts,
): Record<string, { output: number | string | null; log: number | string | null }> {
  const out: Record<string, { output: number | string | null; log: number | string | null }> = {};
  for (const k of ["turns", "toolCalls", "tokensIn", "tokensOut", "session"] as const)
    if (output[k] !== log[k]) out[k] = { output: output[k] ?? null, log: log[k] ?? null };
  if (output.lastText !== log.lastText)
    out.lastTextLength = { output: output.lastText.length, log: log.lastText.length };
  return out;
}
