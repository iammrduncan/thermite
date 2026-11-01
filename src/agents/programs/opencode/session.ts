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
 * OpenCode's session as events (goal 169), as version 2.1.4 gives it. Its session-log route gives
 * nothing usable at that version, so the record is its event stream (`GET /api/event`, or a
 * plugin's `event.subscribe()`: the same events) and its messages (the session's
 * `/api/session/<id>/message`), which the stream may have missed. This module reads both, one
 * record a line: an event (`{type, data}`, as JSON or as the stream's `data: ` line) or a
 * message (`{id, type, time}`), the messages oldest first and before the stream's events that
 * follow them. A step is one model call: its usage counts once by its assistant message's id,
 * from whichever came first. A turn is one execution: it starts, then succeeds, fails or is
 * interrupted. (Today's reader of the headless `opencode run --format json` is events.ts.)
 */

const Tokens = z.looseObject({
  input: z.number().optional(),
  output: z.number().optional(),
  reasoning: z.number().optional(),
  cache: z.looseObject({ read: z.number().optional(), write: z.number().optional() }).optional(),
});
const Failure = z.looseObject({
  type: z.string().optional(),
  message: z.string().optional(),
  retryAfterMs: z.number().optional(),
});
const Event = z.looseObject({
  type: z.string(),
  created: z.number().optional(),
  data: z.looseObject({ sessionID: z.string().optional() }),
});
const Message = z.looseObject({
  id: z.string(),
  type: z.string(),
  time: z.looseObject({ created: z.number(), completed: z.number().optional() }),
});

const Inbox = z.looseObject({
  inboxID: z.string(),
  item: z.looseObject({
    payload: z.looseObject({ text: z.string().optional() }).optional(),
    delivery: z.string().optional(),
  }),
});
const Delivered = z.looseObject({ inboxID: z.string() });
const StepStarted = z.looseObject({
  assistantMessageID: z.string(),
  started: z.number().optional(),
});
const StepEnded = z.looseObject({
  assistantMessageID: z.string(),
  tokens: Tokens.optional(),
  error: Failure.optional(),
});
const TextEnded = z.looseObject({ assistantMessageID: z.string(), text: z.string() });
const ToolNamed = z.looseObject({ id: z.string(), name: z.string() });
const ToolCalled = z.looseObject({ id: z.string(), input: z.unknown().optional() });
const ToolEnded = z.looseObject({
  id: z.string(),
  content: z.unknown().optional(),
  error: Failure.optional(),
});
const ExecutionEnded = z.looseObject({ error: Failure.optional() });

const UserMessage = z.looseObject({ text: z.string().optional() });
const AssistantMessage = z.looseObject({
  content: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        state: z
          .looseObject({
            status: z.string().optional(),
            input: z.unknown().optional(),
            content: z.unknown().optional(),
            error: Failure.optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  tokens: Tokens.optional(),
  error: Failure.optional(),
});
const IdleMessage = z.looseObject({ outcome: z.string().optional(), error: Failure.optional() });

/**
 * Events left out on purpose: the server's and project's state, a session's title, its running
 * totals (each step gives its own), the text as it streams (each text's end gives it whole), a
 * tool's input as it streams and its progress, the shells a tool runs, and a failed compaction.
 */
const IGNORED = new Set([
  "server.connected",
  "server.heartbeat",
  "log.synced",
  "project.updated",
  "integration.updated",
  "model.updated",
  "provider.updated",
  "vcs.branch.updated",
  "agent.updated",
  "command.updated",
  "skill.updated",
  "websearch.updated",
  "reference.updated",
  "plugin.updated",
  "session.instructions.updated",
  "session.usage.updated",
  "session.renamed",
  "session.viewed",
  "session.step.streamed",
  "session.text.started",
  "session.text.delta",
  "session.tool.input.ended",
  "session.tool.progress",
  "session.compaction.failed",
  "shell.created",
  "shell.exited",
  "shell.deleted",
]);

/**
 * Messages left out on purpose: what OpenCode adds of its own (its notes, a skill's text, a shell
 * command typed in its terminal).
 */
const IGNORED_MESSAGES = new Set(["synthetic", "system", "skill", "shell"]);

/** What the adapter keeps between batches. */
export interface OpencodeLogState {
  /** The session followed: the first one seen; others (a subagent's) are left out. */
  session?: string | undefined;
  turn: boolean;
  /** When the turn under way started (ms), and whether a step ran in it. */
  turnAt?: number | undefined;
  stepped: boolean;
  /** Messages waiting in the inbox, by id. */
  inbox: Map<string, { text: string; delivery: string | undefined }>;
  /**
   * Ids already given: the user's messages, the steps (assistant messages) whose usage and whose
   * text were given, the tool calls and their results.
   */
  users: Set<string>;
  steps: Set<string>;
  texts: Set<string>;
  calls: Set<string>;
  results: Set<string>;
  /** The newest time the messages read cover (ms): events up to it are in them already. */
  through?: number | undefined;
  /** Each step's start (ms) and each tool call's name, until used. */
  stepAt: Map<string, number>;
  tools: Map<string, string>;
  unknown: Map<string, number>;
}

const n = (x: number | undefined) => x ?? 0;

/** A step's usage: OpenCode leaves the cache out of `input` and the reasoning out of `output`. */
function stepUsage(at: number, k: z.infer<typeof Tokens>): SessionEvent {
  const read = k.cache?.read;
  return {
    type: "usage",
    call: callUsage({
      at,
      calls: 1,
      tokensIn: n(k.input) + n(read) + n(k.cache?.write),
      cachedIn: read ?? null,
      tokensOut: n(k.output) + n(k.reasoning),
      reasoning: k.reasoning ?? null,
      firstTokenMs: null,
      callMs: null,
    }),
  };
}

/** A failure as a usage limit (OpenCode's quota error, with when to try again) or a plain error. */
function failed(
  e: z.infer<typeof Failure> | undefined,
  at: number | undefined,
): { reason: "limit" | "error"; words: string; limit?: SessionEvent } {
  const words = e?.message ?? e?.type ?? "error";
  if (e?.type !== "provider.quota") return { reason: "error", words };
  const resetsAt =
    at !== undefined && e.retryAfterMs !== undefined
      ? new Date(at + e.retryAfterMs).toISOString()
      : undefined;
  return { reason: "limit", words, limit: { type: "limit", resetsAt, message: words } };
}

/**
 * A user's message comes into the turn: a steer once a step has run in it, else the turn's own
 * prompt (one held in the queue until the last turn ended, when OpenCode says so).
 */
function userIn(
  s: OpencodeLogState,
  out: SessionEvent[],
  text: string,
  delivery: string | undefined,
): void {
  const origin = s.stepped ? "steer" : delivery === "queue" ? "queued" : "prompt";
  out.push({ type: "user", origin, text });
}

/** A step ended (or failed): its usage, once, timed from its start where that was seen. */
function step(
  s: OpencodeLogState,
  out: SessionEvent[],
  id: string,
  at: number | undefined,
  k: z.infer<typeof Tokens> | undefined,
): void {
  s.stepped = true;
  const started = s.stepAt.get(id) ?? at;
  s.stepAt.delete(id);
  if (s.steps.has(id)) return;
  remember(s.steps, id);
  if (!k) return;
  if (started === undefined) countUnknown(s.unknown, "step with no time");
  else out.push(stepUsage(started, k));
}

function readEvent(e: z.infer<typeof Event>, s: OpencodeLogState, out: SessionEvent[]): void {
  const at = e.created;
  const parse = <T extends z.ZodType>(schema: T, then: (r: z.infer<T>) => void): void => {
    const r = schema.safeParse(e.data);
    if (r.success) then(r.data);
    else countUnknown(s.unknown, `${e.type} (unreadable)`);
  };
  switch (e.type) {
    case "session.created":
      break;
    case "session.inbox.enqueued":
      parse(Inbox, (r) => {
        const text = r.item.payload?.text ?? "";
        s.inbox.set(r.inboxID, { text, delivery: r.item.delivery });
        out.push({ type: "queue", op: "enqueue", text });
      });
      break;
    case "session.inbox.delivered":
      parse(Delivered, (r) => {
        const m = s.inbox.get(r.inboxID);
        s.inbox.delete(r.inboxID);
        out.push({ type: "queue", op: "deliver", ...(m ? { text: m.text } : {}) });
        if (s.users.has(r.inboxID)) return;
        remember(s.users, r.inboxID);
        userIn(s, out, m?.text ?? "", m?.delivery);
      });
      break;
    case "session.execution.started":
      startTurn(s, out);
      s.turnAt = at;
      s.stepped = false;
      break;
    case "session.execution.succeeded":
      endTurn(s, out, "done");
      break;
    case "session.execution.interrupted":
      endTurn(s, out, "interrupted");
      break;
    case "session.execution.failed":
      parse(ExecutionEnded, (r) => {
        const f = failed(r.error, at);
        endTurn(s, out, f.reason, f.words);
      });
      break;
    case "session.step.started":
      parse(StepStarted, (r) => {
        if (r.started !== undefined) s.stepAt.set(r.assistantMessageID, r.started);
      });
      break;
    case "session.step.ended":
      parse(StepEnded, (r) => step(s, out, r.assistantMessageID, at, r.tokens));
      break;
    // A failed step: an interrupted one still made its call; a quota error made none.
    case "session.step.failed":
      parse(StepEnded, (r) => {
        step(s, out, r.assistantMessageID, at, r.tokens);
        const f = failed(r.error, at);
        if (f.limit) out.push(f.limit);
      });
      break;
    case "session.text.ended":
      parse(TextEnded, (r) => {
        remember(s.texts, r.assistantMessageID);
        out.push({ type: "assistant.text", messageId: r.assistantMessageID, text: r.text });
      });
      break;
    case "session.tool.input.started":
      parse(ToolNamed, (r) => {
        s.tools.set(r.id, r.name);
      });
      break;
    case "session.tool.called":
      parse(ToolCalled, (r) => {
        if (s.calls.has(r.id)) return;
        remember(s.calls, r.id);
        out.push({
          type: "tool.call",
          id: r.id,
          name: s.tools.get(r.id) ?? "tool",
          input: r.input,
        });
      });
      break;
    case "session.tool.success":
    case "session.tool.failed":
      parse(ToolEnded, (r) => {
        s.tools.delete(r.id);
        if (s.results.has(r.id)) return;
        remember(s.results, r.id);
        const ok = e.type === "session.tool.success";
        const output = ok ? textOf(r.content) : (r.error?.message ?? r.error?.type ?? "");
        out.push({ type: "tool.result", id: r.id, ok, output: output.slice(0, OUTPUT_MAX) });
      });
      break;
    case "session.compaction.ended":
      out.push({ type: "compaction" });
      break;
    default:
      if (!IGNORED.has(e.type)) countUnknown(s.unknown, e.type);
  }
}

/** A message the stream may have missed: whatever of it was not given already. */
function readMessage(
  m: z.infer<typeof Message>,
  raw: unknown,
  s: OpencodeLogState,
  out: SessionEvent[],
): void {
  const parse = <T extends z.ZodType>(schema: T, then: (r: z.infer<T>) => void): void => {
    const r = schema.safeParse(raw);
    if (r.success) then(r.data);
    else countUnknown(s.unknown, `message/${m.type} (unreadable)`);
  };
  switch (m.type) {
    case "user":
      parse(UserMessage, (r) => {
        if (s.users.has(m.id)) return;
        remember(s.users, m.id);
        if (!s.turn) {
          startTurn(s, out);
          s.turnAt = m.time.created;
          s.stepped = false;
        }
        userIn(s, out, r.text ?? "", undefined);
      });
      break;
    case "assistant":
      // One under way is left to the stream, which gives the rest of it.
      if (m.time.completed === undefined) return;
      parse(AssistantMessage, (r) => assistantMessage(m.id, m.time, r, s, out));
      break;
    case "idle":
      parse(IdleMessage, (r) => {
        // An end that belongs to a turn before the one under way.
        if (s.turnAt !== undefined && m.time.created < s.turnAt) return;
        if (r.outcome === "succeeded") endTurn(s, out, "done");
        else if (r.outcome === "interrupted") endTurn(s, out, "interrupted");
        else if (r.outcome === "failed") {
          const f = failed(r.error, m.time.created);
          endTurn(s, out, f.reason, f.words);
        } else countUnknown(s.unknown, `message/idle:${r.outcome}`);
      });
      break;
    case "compaction":
      out.push({ type: "compaction" });
      break;
    default:
      if (!IGNORED_MESSAGES.has(m.type)) countUnknown(s.unknown, `message/${m.type}`);
  }
  s.through = Math.max(s.through ?? 0, m.time.completed ?? m.time.created);
}

/** A finished step from the messages: its text, its tool calls and results, its usage. */
function assistantMessage(
  id: string,
  time: { created: number; completed?: number | undefined },
  r: z.infer<typeof AssistantMessage>,
  s: OpencodeLogState,
  out: SessionEvent[],
): void {
  const texts = !s.texts.has(id);
  remember(s.texts, id);
  for (const c of r.content ?? []) {
    if (c.type === "text") {
      if (texts) out.push({ type: "assistant.text", messageId: id, text: c.text ?? "" });
    } else if (c.type === "tool" && c.id) {
      if (!s.calls.has(c.id)) {
        remember(s.calls, c.id);
        out.push({ type: "tool.call", id: c.id, name: c.name ?? "tool", input: c.state?.input });
      }
      const status = c.state?.status;
      if ((status === "completed" || status === "error") && !s.results.has(c.id)) {
        remember(s.results, c.id);
        const ok = status === "completed";
        const output = ok
          ? textOf(c.state?.content)
          : (c.state?.error?.message ?? c.state?.error?.type ?? "");
        out.push({ type: "tool.result", id: c.id, ok, output: output.slice(0, OUTPUT_MAX) });
      }
    } else if (c.type !== "reasoning") countUnknown(s.unknown, `message/assistant/${c.type}`);
  }
  step(s, out, id, time.created, r.tokens);
  const f = r.error ? failed(r.error, time.completed) : undefined;
  if (f?.limit) out.push(f.limit);
}

/**
 * One line: an event, as JSON or as the stream's `data: ` line, or a message. The stream's
 * comments (`: heartbeat`) and other fields are left out. False when it is not a record.
 */
function readLine(line: string, s: OpencodeLogState, out: SessionEvent[]): boolean {
  if (line.startsWith(":") || /^(event|id|retry):/.test(line)) return true;
  const raw = parseLine(line.startsWith("data:") ? line.slice(5) : line);
  const event = Event.safeParse(raw);
  if (event.success) {
    const e = event.data;
    const id = e.data.sessionID;
    if (id && !s.session) {
      s.session = id;
      out.push({ type: "session", id });
    }
    // Another session's (a subagent's), or one the messages read already gave.
    if (id && id !== s.session) return true;
    if (s.through !== undefined && e.created !== undefined && e.created <= s.through) return true;
    readEvent(e, s, out);
    return true;
  }
  const message = Message.safeParse(raw);
  if (!message.success) return false;
  readMessage(message.data, raw, s, out);
  return true;
}

/** OpenCode's session-log adapter: its events, and its messages. */
export const opencodeSession: SessionLogAdapter<OpencodeLogState> = {
  id: "opencode",
  // Each step is one turn, as the `run --format json` reader counts them.
  turns: "calls",
  newState: () => ({
    turn: false,
    stepped: false,
    inbox: new Map(),
    users: new Set(),
    steps: new Set(),
    texts: new Set(),
    calls: new Set(),
    results: new Set(),
    stepAt: new Map(),
    tools: new Map(),
    unknown: new Map(),
  }),
  read(lines, s) {
    const out: SessionEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!readLine(line.trim(), s, out)) countUnknown(s.unknown, "(not a record)");
    }
    return out;
  },
  unknown: (s) => s.unknown,
};
