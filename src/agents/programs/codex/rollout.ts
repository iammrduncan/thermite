import { z } from "zod";
import { callUsage } from "../../../core/usage.ts";
import {
  countUnknown,
  endTurn,
  OUTPUT_MAX,
  parseLine,
  remember,
  type SessionEvent,
  type SessionLogAdapter,
  startTurn,
  textOf,
} from "../session-log.ts";

/**
 * The Codex CLI's rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`) read into
 * session events (goal 169), as version 0.162.1 writes it: `{timestamp, type, payload}` lines,
 * written as they happen. The conversation is in its `response_item`s (the model's messages, tool
 * calls and their output), the turns and the user's words in its `event_msg`s, and each model
 * response's usage in a `token_usage_record`, once for each response id. A usage limit ends the
 * turn with an error that says so, and gives its reset only in words.
 */

const Line = z.looseObject({
  timestamp: z.iso.datetime().optional(),
  type: z.string(),
  payload: z.looseObject({ type: z.string().optional() }),
});
const SessionMeta = z.looseObject({ id: z.string() });
const TaskStarted = z.looseObject({ turn_id: z.string().optional() });
const TaskComplete = z.looseObject({
  error: z
    .looseObject({ message: z.string().optional(), codex_error_info: z.unknown().optional() })
    .nullish(),
});
const TurnAborted = z.looseObject({ reason: z.string().optional() });
const ItemCompleted = z.looseObject({
  item: z.looseObject({
    type: z.string(),
    id: z.string().optional(),
    content: z.unknown().optional(),
    fragments: z.array(z.looseObject({ text: z.string() })).optional(),
    status: z.string().optional(),
    exit_code: z.number().nullish(),
  }),
});
const Message = z.looseObject({
  id: z.string().optional(),
  role: z.string(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});
const ToolCall = z.looseObject({
  call_id: z.string(),
  name: z.string().optional(),
  arguments: z.string().optional(),
  input: z.unknown().optional(),
  action: z.unknown().optional(),
});
const ToolOutput = z.looseObject({ call_id: z.string(), output: z.unknown() });
const TokenUsage = z.looseObject({
  response_id: z.string(),
  usage: z.looseObject({
    input_tokens: z.number(),
    cached_input_tokens: z.number().nullish(),
    output_tokens: z.number(),
    reasoning_output_tokens: z.number().nullish(),
  }),
});
const Compacted = z.looseObject({ message: z.string().optional() });

/** What the adapter keeps between batches. */
export interface RolloutState {
  session?: string | undefined;
  turn: boolean;
  /** The model has answered in the turn under way: a user's message now is a steer. */
  answered: boolean;
  /** Response ids whose usage was given. */
  responses: Set<string>;
  /** Tool calls that wait for their item; whether each worked, by call id, until its result. */
  pending: Set<string>;
  worked: Map<string, boolean>;
  /** Tool calls already given their result. */
  results: Set<string>;
  unknown: Map<string, number>;
}

/** A function call's arguments as Codex records them: JSON text, read as JSON where it is. */
function argsOf(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const v = parseLine(text);
  return v === undefined ? text : v;
}

/** A tool's output as Codex records it: text, or content parts. */
function outputOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "content" in v) return textOf(v.content);
  return textOf(v) || JSON.stringify(v ?? "");
}

function readEvent(type: string, raw: unknown, s: RolloutState, out: SessionEvent[]): void {
  const parse = <T extends z.ZodType>(schema: T, then: (r: z.infer<T>) => void): void => {
    const r = schema.safeParse(raw);
    if (r.success) then(r.data);
    else countUnknown(s.unknown, `event_msg/${type} (unreadable)`);
  };
  switch (type) {
    case "task_started":
      parse(TaskStarted, (r) => {
        startTurn(s, out, r.turn_id);
        s.answered = false;
      });
      break;
    case "task_complete":
      parse(TaskComplete, (r) => {
        const e = r.error;
        const words = e ? (e.message ?? String(e.codex_error_info ?? "error")) : undefined;
        if (!e) endTurn(s, out, "done");
        else if (e.codex_error_info === "usage_limit_exceeded") {
          out.push({ type: "limit", message: words });
          endTurn(s, out, "limit", words);
        } else endTurn(s, out, "error", words);
      });
      break;
    case "turn_aborted":
      parse(TurnAborted, (r) =>
        endTurn(s, out, "interrupted", r.reason === "interrupted" ? undefined : r.reason),
      );
      break;
    case "item_completed":
      parse(ItemCompleted, (r) => readItem(r.item, s, out));
      break;
    // The thread's totals again (each response's usage has its own record), and its settings.
    case "token_count":
    case "thread_settings_applied":
      break;
    default:
      countUnknown(s.unknown, `event_msg/${type}`);
  }
}

/**
 * A completed item: the user's words (typed, or a Stop hook's), or the end of a tool call, which
 * says whether it worked. The model's messages are read from the response items instead. A
 * command that ends after its turn was interrupted (Codex leaves it running) is left out: its
 * call already has its result.
 */
function readItem(
  item: z.infer<typeof ItemCompleted>["item"],
  s: RolloutState,
  out: SessionEvent[],
): void {
  if (item.type === "UserMessage")
    out.push({ type: "user", origin: s.answered ? "steer" : "prompt", text: textOf(item.content) });
  else if (item.type === "HookPrompt")
    out.push({
      type: "user",
      origin: "hook",
      text: (item.fragments ?? []).map((f) => f.text).join("\n"),
    });
  else if (item.type === "AgentMessage") return;
  else if (item.id !== undefined && s.pending.delete(item.id))
    s.worked.set(item.id, item.status === "completed" && (item.exit_code ?? 0) === 0);
  else if (item.id === undefined || !s.results.has(item.id))
    countUnknown(s.unknown, `item_completed/${item.type}`);
}

function readResponse(type: string, raw: unknown, s: RolloutState, out: SessionEvent[]): void {
  const parse = <T extends z.ZodType>(schema: T, then: (r: z.infer<T>) => void): void => {
    const r = schema.safeParse(raw);
    if (r.success) then(r.data);
    else countUnknown(s.unknown, `response_item/${type} (unreadable)`);
  };
  switch (type) {
    // The user's and the instructions' messages are left out: the user's words come as items,
    // and the rest is what Codex adds to the prompt.
    case "message":
      parse(Message, (r) => {
        if (r.role !== "assistant") return;
        s.answered = true;
        out.push({ type: "assistant.text", messageId: r.id ?? "", text: textOf(r.content) });
      });
      break;
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
      parse(ToolCall, (r) => {
        s.answered = true;
        remember(s.pending, r.call_id);
        out.push({
          type: "tool.call",
          id: r.call_id,
          name: r.name ?? (type === "local_shell_call" ? "shell" : "tool"),
          input: r.arguments !== undefined ? argsOf(r.arguments) : (r.input ?? r.action),
        });
      });
      break;
    case "function_call_output":
    case "custom_tool_call_output":
      parse(ToolOutput, (r) => {
        const ok = s.worked.get(r.call_id);
        s.pending.delete(r.call_id);
        s.worked.delete(r.call_id);
        remember(s.results, r.call_id);
        out.push({
          type: "tool.result",
          id: r.call_id,
          ok,
          output: outputOf(r.output).slice(0, OUTPUT_MAX),
        });
      });
      break;
    // Its thinking: no count needs it.
    case "reasoning":
      break;
    default:
      countUnknown(s.unknown, `response_item/${type}`);
  }
}

/** Reads one record; false when it is not one the adapter can read. */
function readRecord(raw: unknown, s: RolloutState, out: SessionEvent[]): boolean {
  const line = Line.safeParse(raw);
  if (!line.success) return false;
  const { type, payload, timestamp } = line.data;
  switch (type) {
    case "session_meta": {
      const r = SessionMeta.safeParse(payload);
      if (!r.success) countUnknown(s.unknown, "session_meta (unreadable)");
      else if (r.data.id !== s.session) {
        s.session = r.data.id;
        out.push({ type: "session", id: r.data.id });
      }
      return true;
    }
    case "event_msg":
      readEvent(payload.type ?? "", payload, s, out);
      return true;
    case "response_item":
      readResponse(payload.type ?? "", payload, s, out);
      return true;
    case "token_usage_record": {
      const r = TokenUsage.safeParse(payload);
      if (!r.success || !timestamp) {
        countUnknown(s.unknown, "token_usage_record (unreadable)");
        return true;
      }
      s.answered = true;
      if (s.responses.has(r.data.response_id)) return true;
      remember(s.responses, r.data.response_id);
      const u = r.data.usage;
      out.push({
        type: "usage",
        call: callUsage({
          at: timestamp,
          calls: 1,
          tokensIn: u.input_tokens,
          cachedIn: u.cached_input_tokens ?? null,
          tokensOut: u.output_tokens,
          reasoning: u.reasoning_output_tokens ?? null,
          firstTokenMs: null,
          callMs: null,
        }),
      });
      return true;
    }
    case "compacted":
      if (!Compacted.safeParse(payload).success) countUnknown(s.unknown, "compacted (unreadable)");
      else out.push({ type: "compaction" });
      return true;
    // The state Codex gives the model each turn: its settings, folders and instructions.
    case "world_state":
    case "turn_context":
      return true;
    default:
      countUnknown(s.unknown, type);
      return true;
  }
}

/** The Codex CLI's rollout adapter. */
export const codexRollout: SessionLogAdapter<RolloutState> = {
  id: "codex",
  // Each message and each tool call is one turn, as the `exec --json` reader counts them.
  turns: "items",
  newState: () => ({
    turn: false,
    answered: false,
    responses: new Set(),
    pending: new Set(),
    worked: new Map(),
    results: new Set(),
    unknown: new Map(),
  }),
  read(lines, s) {
    const out: SessionEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!readRecord(parseLine(line), s, out)) countUnknown(s.unknown, "(not a record)");
    }
    return out;
  },
  unknown: (s) => s.unknown,
};
