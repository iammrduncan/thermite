import { z } from "zod";
import { COMMAND_MAX_BYTES, SignedCommand } from "../../commands.ts";
import { HealthAnswer } from "../../health.ts";
import { KbAskAnswer, KbReadAsk, KbSearchAsk } from "../../link/kb.ts";
import { McpConnection, McpUnavailable } from "../../mcp.ts";
import { ControlRoute } from "../model-route.ts";
import type { Route } from "../route.ts";

/**
 * The harness's API as its rig's supervisor uses it for itself (src/harness/api/ answers it):
 * the rig's reports and live lines to relay, the commands it delivers, the model route and the MCP
 * servers control gives the rig, past research for the runs' folders, the outbox, the rig's
 * settings and which advisors decide. The advisors' own routes are in advisors.ts beside this.
 * Every route but the health check takes the supervisor's token.
 */

/**
 * Whether the harness is well (`{ok, loops, rig, disk}`, core/health.ts): 503 when a loop is late
 * (goal 173). The supervisor waits for any answer, once, at start; deployments check it.
 */
export const HEALTH = {
  method: "GET",
  path: "/v1/health",
  answer: HealthAnswer,
} as const satisfies Route;

/** The rig's settings (Edit rig): the supervisor reads which advisors are switched on. */
export const SETTINGS = {
  method: "GET",
  path: "/v1/settings",
  what: "rig settings",
  answer: z.looseObject({
    teachers: z.boolean().optional(),
    auditor: z.boolean().optional(),
    review: z.boolean().optional(),
  }),
} as const satisfies Route;

/**
 * Which route the agents use now (never its key), with the planner's route's revision. A rig with
 * no agents answers 404.
 */
export const MODEL_ROUTE_GET = {
  method: "GET",
  path: "/v1/model-route",
  what: "model route",
  answer: z.looseObject({
    source: z.string(),
    revision: z.string().optional(),
    planner_revision: z.string().nullable().optional(),
  }),
} as const satisfies Route;

/** Control's route for the agents, and the planner's own, as the supervisor hands them over. */
export const MODEL_ROUTE_PUT = {
  method: "PUT",
  path: "/v1/model-route",
  what: "model route",
  body: z.object({ route: ControlRoute.nullable(), planner: ControlRoute.nullable().optional() }),
  answer: z.unknown(),
  maxBytes: 16 * 1024,
} as const satisfies Route;

/** The most MCP servers control gives a rig, and the most it says it can't give. */
export const MCP_SERVERS_MAX = 50;

/** The MCP servers the harness holds for its workers and planner: their revisions, never a secret. */
const McpServersHeld = z.looseObject({
  servers: z.array(z.looseObject({ name: z.string(), revision: z.string() })),
  unavailable: z.array(z.looseObject({ name: z.string(), why: z.string() })),
});

export const MCP_SERVERS_GET = {
  method: "GET",
  path: "/v1/mcp-servers",
  what: "MCP servers",
  answer: McpServersHeld,
} as const satisfies Route;

/** The workers' and the planner's share of the MCP servers control gave the rig. */
export const MCP_SERVERS_PUT = {
  method: "PUT",
  path: "/v1/mcp-servers",
  what: "MCP servers",
  body: z.object({
    servers: z.array(McpConnection).max(MCP_SERVERS_MAX),
    unavailable: z.array(McpUnavailable).max(MCP_SERVERS_MAX).default([]),
  }),
  answer: McpServersHeld,
  maxBytes: 512 * 1024,
} as const satisfies Route;

/** The longest words of an MCP server's failure the run's history keeps. */
export const MCP_ERROR_MAX = 500;

/** An advisors' MCP server that failed for them, or works again: the run's history records it. */
export const MCP_EVENTS = {
  method: "POST",
  path: "/v1/mcp-events",
  body: z.strictObject({
    run: z.string().min(1).max(200),
    server: z.string().min(1).max(64),
    ok: z.boolean(),
    error: z.string().max(MCP_ERROR_MAX).optional(),
  }),
  answer: z.looseObject({ ok: z.boolean() }),
} as const satisfies Route;

/** The events of a page of the rig's report when not told how many, and the most. */
export const SNAPSHOT_PAGE_DEFAULT = 500;
export const SNAPSHOT_PAGE_MAX = 5000;

/**
 * A page of the ledger's events after `cursor`, with the rig's summary, signed by the harness:
 * the supervisor passes it on to control untouched (core/link/report.ts reads it there).
 */
export const SNAPSHOT = {
  method: "GET",
  path: "/v1/snapshot",
  what: "snapshot",
  answer: z.looseObject({
    rig: z.string().optional(),
    ledger_id: z.string(),
    cursor: z.number(),
    next: z.number(),
    events: z.array(z.unknown()),
    generated_at: z.string(),
  }),
} as const satisfies Route;

/**
 * A signed command, as control issued it, for the harness to apply. The harness checks control's
 * signature over all of it (verifyCommand), and answers its outcome: 403 when it refused the
 * signature, `in_progress` while another request applies it. The body is the command alone, so it
 * is no larger than the largest command control signs.
 */
export const COMMANDS = {
  method: "POST",
  path: "/v1/commands",
  what: "commands",
  body: SignedCommand,
  answer: z.looseObject({ status: z.string().optional(), accepted: z.boolean().optional() }),
  maxBytes: COMMAND_MAX_BYTES,
} as const satisfies Route;

/** The live lines of a page when not told how many; the most is a batch's (LIVE_BATCH_MAX). */
export const LIVE_PAGE_DEFAULT = 500;

/** The live log's lines after `after`, signed: the supervisor passes them on to control. */
export const LIVE = {
  method: "GET",
  path: "/v1/live",
  what: "live lines",
  answer: z.looseObject({ log_id: z.string(), next: z.number(), entries: z.array(z.unknown()) }),
} as const satisfies Route;

/**
 * The live log's lines after `after`, as the message bus's messages (core/link/live.ts's
 * liveGroups): the lines of each run's source in a batch of their own, each signed as LIVE's batch
 * is. The supervisor publishes each one to its subject, untouched.
 */
export const LIVE_MESSAGES = {
  method: "GET",
  path: "/v1/live/messages",
  what: "live messages",
  answer: z.looseObject({
    log_id: z.string(),
    next: z.number(),
    messages: z.array(
      z.looseObject({
        entries: z
          .array(z.looseObject({ seq: z.number(), source: z.string(), run: z.string().optional() }))
          .min(1),
      }),
    ),
  }),
} as const satisfies Route;

/**
 * Past research for a run's folder, from control's knowledge base: its items, and the collections
 * the run's campaign may read now (one no longer listed is removed).
 */
export const KB = {
  method: "POST",
  path: "/v1/kb",
  body: z.strictObject({
    run: z.string().min(1).max(100),
    items: z.array(z.unknown()),
    collections: z.array(z.string().min(1).max(200)).optional(),
  }),
  answer: z.unknown(),
  maxBytes: 32 * 1024 * 1024,
} as const satisfies Route;

/**
 * The agents' searches and reads of the knowledge base that wait in the harness (goal 175): the
 * supervisor holds this call open up to `wait` seconds (at most 30) until one comes, asks control
 * for each, and hands each answer back with KB_ANSWERS. Each ask is handed over once.
 */
export const KB_ASKS = {
  method: "GET",
  path: "/v1/kb/asks",
  what: "knowledge base asks",
  answer: z.object({
    asks: z.array(
      z.discriminatedUnion("kind", [
        z.object({ id: z.string(), kind: z.literal("search"), ask: KbSearchAsk }),
        z.object({ id: z.string(), kind: z.literal("read"), ask: KbReadAsk }),
      ]),
    ),
  }),
} as const satisfies Route;
/** The longest the supervisor holds KB_ASKS open, in seconds. */
export const KB_ASKS_WAIT_MAX_S = 30;

/** Control's answers to the asks the supervisor took: each by its ask's id. */
export const KB_ANSWERS = {
  method: "POST",
  path: "/v1/kb/answers",
  body: z.strictObject({
    answers: z.array(z.strictObject({ id: z.string().max(64), answer: KbAskAnswer })).max(100),
  }),
  answer: z.object({ taken: z.number() }),
  maxBytes: 8 * 1024 * 1024,
} as const satisfies Route;

/** The advisors' slots in a run of the knowledge base: the roles the supervisor runs. */
export const KB_ADVISOR_SLOTS = [
  "teacher",
  "merged-by",
  "auditor",
  "review-panel",
  "synthesizer",
  "final-writer",
] as const;
export type KbAdvisorSlot = (typeof KB_ADVISOR_SLOTS)[number];

/**
 * An advisor's kb_write (goal 175): the supervisor runs the advisor's call, so it names the
 * advisor's slot (teacher, merged-by, auditor, review-panel, synthesizer, final-writer); the
 * harness records the item there, signed, if the run's contract lets that role write its kind.
 * The rest is the agent's arguments, which name no slot.
 */
export const KB_WRITE = {
  method: "POST",
  path: "/v1/kb/write",
  body: z.strictObject({
    run: z.string().min(1).max(100),
    slot: z.enum(KB_ADVISOR_SLOTS),
    args: z.record(z.string(), z.unknown()),
  }),
  answer: z.object({ text: z.string(), isError: z.boolean().optional() }),
  maxBytes: 8 * 1024 * 1024,
} as const satisfies Route;

/** The kinds an advisor's slot may write in a run, as its contract says: `run` and `slot`. */
export const KB_WRITES = {
  method: "GET",
  path: "/v1/kb/writes",
  what: "knowledge base writers",
  answer: z.object({ kinds: z.array(z.string()) }),
} as const satisfies Route;

/** The exports safe off the rig, which leave the outbox. */
export const EXPORTS_DONE = {
  method: "POST",
  path: "/v1/exports/done",
  body: z.object({ names: z.array(z.string().max(80)).max(5000) }),
  answer: z.unknown(),
  maxBytes: 256 * 1024,
} as const satisfies Route;

/**
 * Which advisors decide (goal 079): whether an auditor decides the rig's audits, its review
 * panel's size, and whether a final writer writes research runs' papers.
 */
export const ADVISORS = {
  method: "PUT",
  path: "/v1/advisors",
  body: z.strictObject({
    auditor: z.boolean(),
    review_panel: z.number().int().min(0).max(100),
    writer: z.boolean().optional(),
  }),
  answer: z.unknown(),
  maxBytes: 16 * 1024,
} as const satisfies Route;
