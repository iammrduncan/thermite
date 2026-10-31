import type { Harness } from "../../../core/agents.ts";
import {
  countUnknown,
  endTurn,
  OUTPUT_MAX,
  parseLine,
  type SessionEvent,
  type SessionLogAdapter,
  startTurn,
} from "../session-log.ts";

/**
 * Claude Code's and Codex's hook signals as events (goal 169): the lines Thermite's hook program
 * (main.ts) writes to a trial's signals file, `{t, src, event, payload}`, one for each hook it
 * ran, each payload as the program gave it (Claude Code 2.1.308 and Codex 0.162.1 give the same
 * fields), and a `thermite.given` line for each owner's message it gave the program. The two
 * programs' hooks match, so one adapter reads both:
 *
 * - SessionStart: the session; UserPromptSubmit: a turn begins with the prompt, or, while one is
 *   under way (in Codex, one with the same turn id), the prompt is taken into it (typed in
 *   mid-turn, in a program's terminal);
 * - PreToolUse and PostToolUse (Claude Code's PostToolUseFailure too): a tool call and its result;
 * - Stop: the turn ended; StopFailure (Claude Code): it ended on a failed call or a usage limit;
 *   Interrupt (Codex): it was interrupted; SessionEnd: the program ended;
 * - Codex's notify, `agent-turn-complete`: the turn ended, for the session's own thread only
 *   (Codex also sends one for the hidden thread that names the session);
 * - `thermite.given`: an owner's message went in after a tool (taken in mid-turn) or at the
 *   turn's end (a new turn begins with it).
 *
 * Usage is in no hook: the program's output and session log give it.
 */

/** Hooks left out on purpose: they say nothing the events carry. */
const IGNORED = new Set([
  "Notification",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
]);

export interface HookSignalsState {
  session?: string | undefined;
  turn: boolean;
  /** The turn under way's id, where the program gives one (Codex). */
  turnId?: string | undefined;
  unknown: Map<string, number>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** A tool's result as the hook gave it: Codex's text, or Claude Code's output fields. */
function outputOf(v: unknown): string {
  if (typeof v === "string") return v.slice(0, OUTPUT_MAX);
  const o = obj(v);
  const text = [str(o.stdout), str(o.stderr)].filter(Boolean).join("\n");
  return (text || (v === undefined ? "" : JSON.stringify(v))).slice(0, OUTPUT_MAX);
}

/** One signal's events. */
function signalEvents(
  s: HookSignalsState,
  src: string,
  event: string,
  p: Record<string, unknown>,
): SessionEvent[] | undefined {
  const out: SessionEvent[] = [];
  const id = str(p.tool_use_id);
  switch (event) {
    case "SessionStart": {
      const session = str(p.session_id);
      if (session && session !== s.session) {
        s.session = session;
        out.push({ type: "session", id: session });
      }
      return out;
    }
    case "UserPromptSubmit": {
      const turnId = str(p.turn_id) || undefined;
      const within = s.turn && (!turnId || turnId === s.turnId);
      if (!within) {
        startTurn(s, out, turnId);
        s.turnId = turnId;
      }
      const text = str(p.prompt);
      if (text) out.push({ type: "user", origin: within ? "steer" : "prompt", text });
      return out;
    }
    case "PreToolUse":
      out.push({ type: "tool.call", id, name: str(p.tool_name) || "tool", input: p.tool_input });
      return out;
    case "PostToolUse":
      out.push({ type: "tool.result", id, ok: true, output: outputOf(p.tool_response) });
      return out;
    case "PostToolUseFailure":
      out.push({ type: "tool.result", id, ok: false, output: outputOf(p.error) });
      return out;
    case "Stop":
      endTurn(s, out, "done");
      return out;
    case "StopFailure": {
      const error = str(p.error) || "error";
      if (/rate.?limit|usage.?limit/i.test(error)) {
        out.push({ type: "limit", message: str(p.last_assistant_message) || error });
        endTurn(s, out, "limit", error);
      } else endTurn(s, out, "error", error);
      return out;
    }
    case "Interrupt":
      endTurn(s, out, "interrupted");
      return out;
    case "SessionEnd":
      out.push({ type: "session.end" });
      return out;
    case "agent-turn-complete":
      // Codex's notify: its own thread's turns only.
      if (src === "codex-notify" && str(p["thread-id"]) === s.session) endTurn(s, out, "done");
      return out;
    case "thermite.given":
      if (str(p.at) === "turn-end") startTurn(s, out);
      else out.push({ type: "queue", op: "deliver" });
      return out;
  }
  return IGNORED.has(event) ? out : undefined;
}

/** The hook signals adapter for one program (Claude Code or Codex). */
export function hookSignals(
  id: Extract<Harness, "claude-code" | "codex">,
): SessionLogAdapter<HookSignalsState> {
  return {
    id,
    // As the program's own session log counts them.
    turns: id === "codex" ? "items" : "calls",
    newState: () => ({ turn: false, unknown: new Map() }),
    read(lines, s) {
      const out: SessionEvent[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const o = obj(parseLine(line));
        const event = str(o.event);
        if (!event) {
          countUnknown(s.unknown, "(not a signal)");
          continue;
        }
        const got = signalEvents(s, str(o.src), event, obj(o.payload));
        if (got) out.push(...got);
        else countUnknown(s.unknown, event);
      }
      return out;
    },
    unknown: (s) => s.unknown,
  };
}
