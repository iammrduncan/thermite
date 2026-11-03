import { z } from "zod";
import { MCP_SERVER_NAME, MCP_TOOL_NAME } from "../../mcp.ts";
import { PROMPT_RECORD_MAX_CHARS, PROMPT_TURN_MAX, PromptSection } from "../../prompts.ts";
import { CallUsage } from "../../usage.ts";
import { ADVISOR_PROMPT_ROLES } from "../harness/prompts.ts";
import type { Route } from "../route.ts";

/**
 * An advisor's call in a process of its own (goal 169; src/supervisor/advisors/terminal/pi.ts
 * answers): on a rig whose agents run in their own terminal, an advisor in Pi runs in its Pi view,
 * in a process the terminal host runs as an advisor user. The process reaches the supervisor only
 * over these routes, on localhost for the length of its call, with a credential made for the call
 * (`call.<hex>`): its tools, which the supervisor runs as it runs a headless advisor's; its lines
 * for Live; the owner's messages for its role; its model usage; its compactions; its later turns;
 * its answer, which the supervisor checks as a headless advisor's; and its end. Its view's console
 * takes the owner's input over the Pi view's routes (core/api/harness/console.ts), on the same
 * server. Nothing here can set a verdict, a rule or a champion: an answer goes to the advisor's
 * pass, as a headless advisor's does.
 */

/** The most characters of a tool's answer, a line, or why a call ended. */
const TEXT_MAX = 200_000;

/** One of the advisor's own tools (not an MCP server's), by name, with its arguments. */
export const ADVISOR_CALL_TOOL = {
  method: "POST",
  path: "/v1/call/tool",
  body: z.strictObject({
    tool: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()),
  }),
  answer: z.looseObject({ text: z.string().max(TEXT_MAX) }),
  maxBytes: 4 * 1024 * 1024,
} as const satisfies Route;

/** One tool of an MCP server the run's kit gives the advisors, called by the supervisor. */
export const ADVISOR_CALL_MCP = {
  method: "POST",
  path: "/v1/call/mcp-call",
  body: z.strictObject({
    server: z.string().regex(MCP_SERVER_NAME),
    tool: z.string().regex(MCP_TOOL_NAME),
    arguments: z.record(z.string(), z.unknown()),
  }),
  answer: z.looseObject({ content: z.unknown().optional(), isError: z.boolean().optional() }),
  maxBytes: 4 * 1024 * 1024,
} as const satisfies Route;

/** The advisor's MCP tools listed again from the servers (its Pi view's /mcp reconnect). */
export const ADVISOR_CALL_MCP_TOOLS = {
  method: "POST",
  path: "/v1/call/mcp-tools",
  body: z.strictObject({
    /** Every server, or one by its name. */
    fresh: z.union([z.literal(true), z.string().regex(MCP_SERVER_NAME)]),
  }),
  answer: z.looseObject({
    tools: z.array(
      z.object({
        server: z.string(),
        name: z.string(),
        description: z.string(),
        input_schema: z.record(z.string(), z.unknown()),
        reads: z.boolean(),
      }),
    ),
    unavailable: z.array(z.object({ server: z.string(), why: z.string() })),
  }),
  maxBytes: 1024,
} as const satisfies Route;

/**
 * The advisor's answer, its `answer` tool's arguments: taken, or refused with its problems and the
 * words its tool gives the advisor, which then answers again. The first answer taken counts.
 */
export const ADVISOR_CALL_ANSWER = {
  method: "POST",
  path: "/v1/call/answer",
  body: z.strictObject({ answer: z.unknown() }),
  answer: z.union([
    z.looseObject({ ok: z.literal(true) }),
    z.looseObject({ ok: z.literal(false), problems: z.string(), words: z.string() }),
  ]),
  maxBytes: 4 * 1024 * 1024,
} as const satisfies Route;

/** Lines of the advisor's session for the run's Live: what it says and does, and its waits. */
export const ADVISOR_CALL_LIVE = {
  method: "POST",
  path: "/v1/call/live",
  body: z.strictObject({
    entries: z
      .array(
        z.strictObject({
          kind: z.enum(["text", "thinking", "tool", "result", "status"]),
          text: z.string().max(8000),
        }),
      )
      .max(200),
  }),
  answer: z.looseObject({ ok: z.literal(true) }),
  maxBytes: 256 * 1024,
} as const satisfies Route;

/** The owner's messages that wait for the advisor's role in its run, but those it was given. */
export const ADVISOR_CALL_MESSAGES = {
  method: "GET",
  path: "/v1/call/messages",
  answer: z.looseObject({ messages: z.array(z.object({ id: z.number(), text: z.string() })) }),
} as const satisfies Route;

/** The owner's messages its agent took into its conversation: given, for their receipts. */
export const ADVISOR_CALL_READ = {
  method: "POST",
  path: "/v1/call/messages/read",
  body: z.strictObject({ ids: z.array(z.number().int().min(0)).min(1).max(100) }),
  answer: z.looseObject({ ok: z.literal(true) }),
  maxBytes: 16 * 1024,
} as const satisfies Route;

/** The most usage records one hand-over carries. */
export const ADVISOR_CALL_USAGE_MAX = 500;

/** Each model call's usage, as the process measured it (goal 075). */
export const ADVISOR_CALL_USAGE = {
  method: "POST",
  path: "/v1/call/usage",
  body: z.strictObject({ calls: z.array(CallUsage).min(1).max(ADVISOR_CALL_USAGE_MAX) }),
  answer: z.looseObject({ recorded: z.number() }),
  maxBytes: 256 * 1024,
} as const satisfies Route;

/** The most characters of a conversation kept before a compaction. */
export const ADVISOR_CALL_KEPT_MAX = 8_000_000;

/**
 * The conversation before compaction `number` (goal 070), kept with the records of the advisors'
 * rounds: where, in words, for its summary to name. Refused when the call has no place to keep it.
 */
export const ADVISOR_CALL_KEEP = {
  method: "POST",
  path: "/v1/call/kept",
  body: z.strictObject({
    number: z.number().int().min(1).max(10_000),
    markdown: z.string().max(ADVISOR_CALL_KEPT_MAX),
  }),
  answer: z.looseObject({ kept: z.string() }),
  maxBytes: 2 * ADVISOR_CALL_KEPT_MAX + 64 * 1024,
} as const satisfies Route;

/** A compaction done (goal 070): its record with the round's, and a line in the run's Live. */
export const ADVISOR_CALL_COMPACTED = {
  method: "POST",
  path: "/v1/call/compacted",
  body: z.strictObject({
    number: z.number().int().min(1).max(10_000),
    tokens_before: z.number().int().min(0).nullable(),
    tokens_after: z.number().int().min(0).nullable(),
    how: z.enum(["summary", "trimmed"]),
    kept: z.string().max(4000).nullable(),
    error: z.string().max(4000).optional(),
  }),
  answer: z.looseObject({ ok: z.literal(true) }),
  maxBytes: 16 * 1024,
} as const satisfies Route;

/**
 * A later turn the process sent inside its call (goal 166): what it goes on from after a
 * compaction, or the owner's words, as its role rendered it, kept as its first prompt is.
 */
export const ADVISOR_CALL_TURN = {
  method: "POST",
  path: "/v1/call/turn",
  body: z.strictObject({
    role: z.enum(ADVISOR_PROMPT_ROLES),
    program: z.literal("pi"),
    turn: z.number().int().min(1).max(PROMPT_TURN_MAX),
    sections: z
      .array(PromptSection)
      .min(1)
      .max(200)
      .refine(
        (ss) => ss.reduce((n, s) => n + s.text.length, 0) <= PROMPT_RECORD_MAX_CHARS,
        `a prompt kept has at most ${PROMPT_RECORD_MAX_CHARS.toLocaleString("en-US")} characters`,
      ),
  }),
  answer: z.looseObject({ ok: z.literal(true) }),
  maxBytes: 16 * 1024 * 1024,
} as const satisfies Route;

/** The call's end: its tokens, and why it gave no answer when it gave none. */
export const ADVISOR_CALL_END = {
  method: "POST",
  path: "/v1/call/end",
  body: z.strictObject({
    tokens_in: z.number().int().min(0),
    tokens_out: z.number().int().min(0),
    error: z.string().max(TEXT_MAX).optional(),
  }),
  answer: z.looseObject({ ok: z.literal(true) }),
  maxBytes: TEXT_MAX + 1024,
} as const satisfies Route;
