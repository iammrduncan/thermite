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
  type UserOrigin,
} from "../session-log.ts";

/**
 * Claude Code's transcript (`~/.claude/projects/<project>/<session>.jsonl`) read into session
 * events (goal 169), as version 2.1.308 writes it, in its terminal UI and in `-p`. It writes one
 * record for each content block of a reply, each with the reply's usage, so usage counts once
 * for each message id. A turn ends at its `turn_duration` (the terminal UI only), at a Stop
 * hook's summary that did not block, at an interrupt, at a failed call or a usage limit, or when
 * the program exits cleanly (`cost-state`). Typed text taken in mid-turn comes as a queued
 * command, a Stop hook's block as a blocking error: both are the user's side of the turn.
 */

const Origin = z.looseObject({ kind: z.string() });
const Usage = z.looseObject({
  input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
});
const Block = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  is_error: z.boolean().nullish(),
});
const Content = z.union([z.string(), z.array(Block)]);
/** A usage limit as the transcript gives it: `resetsAt` in seconds. */
const RateLimit = z.looseObject({
  resetsAt: z.number().nullish(),
  rateLimitType: z.string().nullish(),
  overageStatus: z.string().nullish(),
});

const Envelope = z.looseObject({ type: z.string(), sessionId: z.string().optional() });
const Assistant = z.looseObject({
  timestamp: z.iso.datetime(),
  message: z.looseObject({
    id: z.string(),
    model: z.string().optional(),
    content: Content.optional(),
    usage: Usage.nullish(),
  }),
  isApiErrorMessage: z.boolean().optional(),
  apiError: z.string().nullish(),
  error: z.string().nullish(),
  apiErrorParams: z.looseObject({ rate_limit_info: RateLimit.nullish() }).nullish(),
  quotaLimits: RateLimit.nullish(),
});
const User = z.looseObject({
  message: z.looseObject({ content: Content }),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  origin: Origin.optional(),
  promptSource: z.string().optional(),
  promptId: z.string().optional(),
  interruptedMessageId: z.string().optional(),
});
const System = z.looseObject({
  subtype: z.string(),
  hookErrors: z.array(z.unknown()).optional(),
  compactMetadata: z.looseObject({ preTokens: z.number().optional() }).optional(),
  compact_metadata: z.looseObject({ pre_tokens: z.number().optional() }).optional(),
});
const QueueOperation = z.looseObject({
  operation: z.string(),
  content: z.string().optional(),
  reason: z.string().optional(),
});
const Attachment = z.looseObject({
  attachment: z.looseObject({
    type: z.string(),
    prompt: z.string().optional(),
    commandMode: z.string().optional(),
    origin: Origin.optional(),
    blockingError: z.looseObject({ blockingError: z.string() }).optional(),
  }),
});
const CostState = z.looseObject({
  modelUsage: z
    .record(
      z.string(),
      z.looseObject({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cacheReadInputTokens: z.number().optional(),
        cacheCreationInputTokens: z.number().optional(),
      }),
    )
    .optional(),
});

/**
 * Records left out on purpose: the modes it was in, file backups, the last prompt again, and the
 * requests it sent (`api-request*`: its system prompt, tools and messages, which the events need
 * none of).
 */
const IGNORED = new Set([
  "mode",
  "permission-mode",
  "atis-latch",
  "file-history-snapshot",
  "last-prompt",
  "api-request",
  "api-request-shape",
  "api-request-blob",
]);

/** What the adapter keeps between batches. */
export interface TranscriptState {
  session?: string | undefined;
  turn: boolean;
  /** Message ids whose usage was given. */
  messages: Set<string>;
  /** The program's exit was given, and nothing has happened since. */
  ended: boolean;
  unknown: Map<string, number>;
}

const iso = (seconds: number | null | undefined) =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : undefined;
const n = (x: number | null | undefined) => x ?? 0;

/**
 * Whose words a user record holds, for one that opens a turn: typed (`origin.kind` human), given
 * to `-p` (`promptSource` sdk), another session's, or the program's own after a usage reset.
 * Undefined for the program's own records: a slash command and its output, a Stop hook's
 * feedback (its blocking error gives the words), a compaction's summary.
 */
function originOf(r: z.infer<typeof User>, s: TranscriptState): UserOrigin | undefined {
  if (r.isCompactSummary) return undefined;
  const kind = r.origin?.kind;
  if (kind === "human") return "prompt";
  if (kind === "peer") return "peer";
  if (kind === "auto-continuation") return "auto";
  if (kind !== undefined) {
    countUnknown(s.unknown, `user/origin:${kind}`);
    return "prompt";
  }
  if (r.promptSource === undefined) return undefined;
  if (r.promptSource !== "sdk") countUnknown(s.unknown, `user/source:${r.promptSource}`);
  return "prompt";
}

function readUser(r: z.infer<typeof User>, s: TranscriptState, out: SessionEvent[]): void {
  for (const b of typeof r.message.content === "string" ? [] : r.message.content)
    if (b.type === "tool_result")
      out.push({
        type: "tool.result",
        id: b.tool_use_id ?? "",
        ok: b.is_error !== true,
        output: textOf(b.content).slice(0, OUTPUT_MAX),
      });
  if (r.interruptedMessageId) {
    endTurn(s, out, "interrupted");
    return;
  }
  const origin = originOf(r, s);
  if (!origin) return;
  startTurn(s, out, r.promptId);
  out.push({ type: "user", origin, text: textOf(r.message.content) });
}

function readAssistant(
  r: z.infer<typeof Assistant>,
  s: TranscriptState,
  out: SessionEvent[],
): void {
  const m = r.message;
  // A failed call or a usage limit: Claude Code's own message, with no model call behind it.
  if (r.isApiErrorMessage) {
    const words = textOf(m.content) || r.apiError || r.error || "error";
    if (r.error === "rate_limit" || r.apiError === "usage_limit_reached") {
      const info = r.apiErrorParams?.rate_limit_info ?? r.quotaLimits;
      out.push({
        type: "limit",
        window: info?.rateLimitType ?? undefined,
        resetsAt: iso(info?.resetsAt),
        overage: info?.overageStatus ?? undefined,
        message: words,
      });
      endTurn(s, out, "limit", words);
    } else endTurn(s, out, "error", words);
    return;
  }
  if (!s.messages.has(m.id) && m.usage && m.model !== "<synthetic>") {
    const u = m.usage;
    out.push({
      type: "usage",
      call: callUsage({
        at: r.timestamp,
        calls: 1,
        tokensIn:
          n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
        cachedIn: u.cache_read_input_tokens ?? null,
        tokensOut: n(u.output_tokens),
        reasoning: null,
        firstTokenMs: null,
        callMs: null,
      }),
    });
  }
  remember(s.messages, m.id);
  // Thinking blocks are left out: no count needs them, and the terminal shows them.
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b.type === "text")
      out.push({ type: "assistant.text", messageId: m.id, text: b.text ?? "" });
    else if (b.type === "tool_use")
      out.push({ type: "tool.call", id: b.id ?? "", name: b.name ?? "tool", input: b.input });
  }
}

function readSystem(r: z.infer<typeof System>, s: TranscriptState, out: SessionEvent[]): void {
  switch (r.subtype) {
    case "turn_duration":
      endTurn(s, out, "done");
      break;
    // A Stop hook that blocked sent the program on: the turn goes on.
    case "stop_hook_summary":
      if (!r.hookErrors?.length) endTurn(s, out, "done");
      break;
    case "compact_boundary":
      out.push({
        type: "compaction",
        tokensBefore: r.compactMetadata?.preTokens ?? r.compact_metadata?.pre_tokens,
      });
      break;
    // Notices for the screen: a held message, a wait for a usage limit.
    case "informational":
      break;
    default:
      countUnknown(s.unknown, `system/${r.subtype}`);
  }
}

function readQueue(
  r: z.infer<typeof QueueOperation>,
  s: TranscriptState,
  out: SessionEvent[],
): void {
  const text = r.content;
  if (r.operation === "enqueue") out.push({ type: "queue", op: "enqueue", text });
  else if (r.operation === "dequeue") out.push({ type: "queue", op: "deliver", text });
  // Removed because it was taken into the running turn: delivered.
  else if (r.operation === "remove")
    out.push({ type: "queue", op: r.reason === "absorbed_mid_turn" ? "deliver" : "remove", text });
  else countUnknown(s.unknown, `queue-operation/${r.operation}`);
}

/**
 * Context Claude Code adds to a request is left out, apart from two kinds that carry the user's
 * side: text taken in mid-turn (a queued command) and a hook's block. Context a hook adds to a
 * tool's result is left out too: the hook's own record has it.
 */
function readAttachment(
  r: z.infer<typeof Attachment>,
  s: TranscriptState,
  out: SessionEvent[],
): void {
  const a = r.attachment;
  if (a.type === "queued_command") {
    if (a.commandMode !== undefined && a.commandMode !== "prompt")
      countUnknown(s.unknown, `attachment/queued_command:${a.commandMode}`);
    out.push({
      type: "user",
      origin: a.origin?.kind === "peer" ? "peer" : "steer",
      text: a.prompt ?? "",
    });
  } else if (a.type === "hook_blocking_error" && a.blockingError)
    out.push({ type: "user", origin: "hook", text: a.blockingError.blockingError });
}

/**
 * Claude Code exited cleanly: its totals cover every call, those it keeps out of the transcript
 * (a title for each typed prompt) too.
 */
function readCost(r: z.infer<typeof CostState>, s: TranscriptState, out: SessionEvent[]): void {
  endTurn(s, out, "done");
  if (s.ended) return;
  s.ended = true;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const m of Object.values(r.modelUsage ?? {})) {
    tokensIn += n(m.inputTokens) + n(m.cacheReadInputTokens) + n(m.cacheCreationInputTokens);
    tokensOut += n(m.outputTokens);
  }
  out.push({ type: "session.end", ...(r.modelUsage ? { totals: { tokensIn, tokensOut } } : {}) });
}

/** Reads one record; false when it is not one the adapter can read. */
function readRecord(raw: unknown, s: TranscriptState, out: SessionEvent[]): boolean {
  const env = Envelope.safeParse(raw);
  if (!env.success) return false;
  const { type, sessionId } = env.data;
  if (sessionId && sessionId !== s.session) {
    s.session = sessionId;
    out.push({ type: "session", id: sessionId });
  }
  const parse = <T extends z.ZodType>(schema: T, then: (r: z.infer<T>) => void): boolean => {
    const r = schema.safeParse(raw);
    if (r.success) then(r.data);
    else countUnknown(s.unknown, `${type} (unreadable)`);
    return true;
  };
  switch (type) {
    case "user":
      s.ended = false;
      return parse(User, (r) => readUser(r, s, out));
    case "assistant":
      s.ended = false;
      return parse(Assistant, (r) => readAssistant(r, s, out));
    case "system":
      return parse(System, (r) => readSystem(r, s, out));
    case "queue-operation":
      return parse(QueueOperation, (r) => readQueue(r, s, out));
    case "attachment":
      return parse(Attachment, (r) => readAttachment(r, s, out));
    case "cost-state":
      return parse(CostState, (r) => readCost(r, s, out));
    default:
      if (!IGNORED.has(type)) countUnknown(s.unknown, type);
      return true;
  }
}

/** Claude Code's transcript adapter. */
export const claudeTranscript: SessionLogAdapter<TranscriptState> = {
  id: "claude-code",
  // Each model reply is one turn, as the stream-json reader counts them.
  turns: "calls",
  newState: () => ({ turn: false, messages: new Set(), ended: false, unknown: new Map() }),
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
