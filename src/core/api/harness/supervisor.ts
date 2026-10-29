import { z } from "zod";
import { COMMAND_MAX_BYTES, SignedCommand } from "../../commands.ts";
import { HealthAnswer } from "../../health.ts";
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
