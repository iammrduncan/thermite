import { z } from "zod";
import { LoopAges } from "../../health.ts";
import { KbAskAnswer, KbReadAsk, KbSearchAsk } from "../../link/kb.ts";
import { LIVE_FIGURE_SUBJECTS } from "../../link/live.ts";
import { SignedReport } from "../../link/report.ts";
import { LiveBatchWire } from "../../live.ts";
import { McpConnection, McpUnavailable } from "../../mcp.ts";
import {
  SCREENS_MAX_BYTES,
  SCREENS_WATCHED_MAX,
  ScreenFrame,
  WatchedTrials,
} from "../../screens.ts";
import { MCP_SERVERS_MAX } from "../harness/supervisor.ts";
import type { Route } from "../route.ts";

/**
 * Control's API for a rig's supervisor (src/control/api/ answers it), each route with the rig's
 * own token and only for that rig (`:rig`): its reports, live lines, screens and figures, the
 * commands waiting for it and their outcomes, the model routes and MCP servers control gives it,
 * past research for its runs, its results (champion patches and exports, for a rig with no results
 * repository), its daily report, and the Git access and kits its campaigns name. In pull mode the
 * same calls cross the tunnel (control/tunnel.ts lets these routes through, and no other).
 */

/**
 * A page of the rig's events, exactly as its harness signed it (core/link/report.ts). Control
 * answers 409 with the cursor it expects (CursorElsewhere) when the page does not follow on from
 * the last it took, and 413 when the page is too large: the supervisor halves it.
 */
export const INGEST = {
  method: "POST",
  path: "/v1/rigs/:rig/ingest",
  what: "reports",
  body: SignedReport,
  answer: z.looseObject({ added: z.number() }),
  maxBytes: 32 * 1024 * 1024,
} as const satisfies Route;

/** Control's answer to a page that does not follow on from its place: where to send from. */
export const CursorElsewhere = z.looseObject({ expected_cursor: z.number().int().min(0) });

/** A command as the supervisor reads it; it goes on to the harness as it came, signature and all. */
const PendingCommand = z.looseObject({
  envelope: z.looseObject({ id: z.string(), kind: z.string() }),
});

/**
 * The commands waiting for the rig, each whole the first time; after that only its id, in
 * `held`, while it waits (`?have=` the ids the supervisor holds, `?staging=` those whose sources it
 * still fetches: control renews those before they expire).
 */
export const PENDING_COMMANDS = {
  method: "GET",
  path: "/v1/rigs/:rig/commands/pending",
  what: "pending commands",
  answer: z.looseObject({
    commands: z.array(PendingCommand),
    held: z.array(z.string()).optional(),
  }),
} as const satisfies Route;

/** A command's outcome, as the harness gave it. 404: control holds the command pending no more. */
export const ACK = {
  method: "POST",
  path: "/v1/rigs/:rig/commands/:id/ack",
  what: "command's outcome",
  body: z.object({
    status: z.enum(["delivered", "rejected", "failed"]),
    outcome: z.unknown(),
  }),
  answer: z.looseObject({ ok: z.boolean() }),
  maxBytes: 256 * 1024,
} as const satisfies Route;

/**
 * The supervisor's figures (unsigned: it reports itself) hold numbers and short strings only. The
 * longest string; the most export names in a list; the most model downloads it reports.
 */
export const FIGURE_TEXT_MAX = 1000;
export const FIGURE_EXPORTS_MAX = 50;
export const FIGURE_MODELS_MAX = 20;
/** The longest model name, source host and run of a download, as the figures carry them. */
export const FIGURE_MODEL_NAME_MAX = 200;
export const FIGURE_MODEL_FROM_MAX = 300;
export const FIGURE_RUN_MAX = 80;

/**
 * One advisor of a rig's advisors file, as its supervisor reports it (goal 074): where it runs
 * (pi, claude-code, opencode, codex, or cli for a command-line agent), its model (null: a
 * command-line agent names none), its provider's name and kind (its API, or claude), its window
 * (null: none) and its compaction point (null: the default). The supervisor sends no key, token or
 * address. Read loosely: a field this control does not know is dropped.
 */
const AdvisorSetupSchema = z.object({
  harness: z.string().min(1).max(40),
  model: z.string().max(FIGURE_MODEL_NAME_MAX).nullable(),
  provider: z.string().max(FIGURE_MODEL_NAME_MAX).nullable(),
  api: z.string().max(40).nullable(),
  context_window: z.number().int().min(0).max(100_000_000).nullable(),
  compact_at: z.number().int().min(0).max(100).nullable(),
});
export type AdvisorSetupView = z.infer<typeof AdvisorSetupSchema>;

/** The most teachers an advisors file or control gives a rig, and the most reviewers in a file. */
export const TEACHERS_MAX = 2;
export const FILE_REVIEWERS_MAX = 5;

/**
 * What a rig's advisors file sets up for each advisor, as its supervisor reports it in
 * `advisors.file` (goal 074): the teachers (none, one or two), their merged by model, the auditor
 * and the review panel (two to five reviewers). An advisor with no model from control uses the
 * file's; with none there either, it is off.
 */
export const AdvisorsFileSchema = z.object({
  teachers: z.array(AdvisorSetupSchema).max(TEACHERS_MAX),
  merged_by: AdvisorSetupSchema.nullable(),
  auditor: AdvisorSetupSchema.nullable(),
  review_panel: z.array(AdvisorSetupSchema).max(FILE_REVIEWERS_MAX),
});
export type AdvisorsFileView = z.infer<typeof AdvisorsFileSchema>;

const Count = z.number().finite().min(0).max(1e12);
const Bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Short = z.string().max(FIGURE_TEXT_MAX);
const ExportNames = z.array(z.string().regex(/^[0-9A-Za-z-]{1,80}$/)).max(FIGURE_EXPORTS_MAX);

/** Lines published to the bus and dropped there. */
const LiveLines = z.object({ published: Count, dropped: Count });

/**
 * The live lines a supervisor on the message bus published there and dropped, since it started
 * (goal 168): in all, and by subject for the LIVE_FIGURE_SUBJECTS it used last.
 */
export const LiveFigures = LiveLines.extend({
  subjects: z
    .record(z.string().max(200), LiveLines)
    .refine((r) => Object.keys(r).length <= LIVE_FIGURE_SUBJECTS, "too many subjects"),
});
export type LiveFigures = z.infer<typeof LiveFigures>;

/** The most config subjects the supervisor's figures count by name: its rig's keys. */
export const FIGURE_CONFIG_SUBJECTS = 20;

/** Config updates taken from the bus and refused there. */
const ConfigUpdates = z.object({ taken: Count, refused: Count });

/**
 * The config updates a supervisor on the message bus took and refused, since it started (goal
 * 168): in all, and by subject, one for each of its rig's keys. An update taken is a value it did
 * not hold yet; one refused, a message it could not take (its value known stays).
 */
export const ConfigFigures = ConfigUpdates.extend({
  subjects: z
    .record(z.string().max(200), ConfigUpdates)
    .refine((r) => Object.keys(r).length <= FIGURE_CONFIG_SUBJECTS, "too many subjects"),
});
export type ConfigFigures = z.infer<typeof ConfigFigures>;

/**
 * What a supervisor may say about itself. A field this control does not know, at any level, is
 * dropped, never stored or shown: a newer supervisor that reports more still has the rest of its
 * figures taken (goal 012). The fields it knows keep their checks.
 */
export const SupervisorFigures = z.object({
  at: Short,
  relay: z.object({ cursor: Count }).optional(),
  export: z
    .object({
      remote: z.boolean(),
      /** Where its exports go: the results repository, control, or nowhere off the rig. */
      to: z.enum(["repository", "control", "none"]).optional(),
      exports: Count,
      pushed: ExportNames,
      pushed_commit: z
        .string()
        .regex(/^[0-9a-f]{40,64}$/)
        .nullable()
        .optional(),
      last_push_at: Short.nullable(),
      /** The newest exports it sent to control in full. */
      uploaded: ExportNames.optional(),
      last_upload_at: Short.nullable().optional(),
      /** Exports on the rig that have not left it yet, and champion patches not yet on control. */
      waiting: Count.optional(),
      champions_waiting: Count.optional(),
      last_error: Short.nullable(),
    })
    .optional(),
  /** Model files it downloads or downloaded for the harness (model-download.ts), newest first. */
  models: z
    .array(
      z.object({
        name: z.string().max(FIGURE_MODEL_NAME_MAX),
        path: Short,
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        from: z.string().max(FIGURE_MODEL_FROM_MAX),
        state: z.enum(["downloading", "done", "refused", "failed"]),
        bytes: Bytes,
        total: Bytes.nullable(),
        resumed_from: Bytes,
        started_at: Short,
        updated_at: Short,
        error: Short.optional(),
        run: z.string().max(FIGURE_RUN_MAX).optional(),
      }),
    )
    .max(FIGURE_MODELS_MAX)
    .optional(),
  advisors: z
    .object({
      teacher_runs: Count,
      directive_sets: Count,
      directives: Count,
      audits: Count,
      reviews: Count,
      errors: Count,
      tokens_in: Count,
      tokens_out: Count,
      usd: Count,
      last_error: Short.optional(),
      /** Which advisor roles the rig has configured (so control knows if an auditor decides). */
      roles: z
        .object({
          teachers: Count,
          merged_by: z.boolean(),
          auditor: z.boolean(),
          review_panel: Count,
        })
        .optional(),
      /**
       * What the rig's advisors file sets up for each role (goal 074): Edit rig says what an
       * advisor with no model from control uses. A malformed one is dropped, not the report.
       */
      file: AdvisorsFileSchema.optional().catch(undefined),
    })
    .nullable()
    .optional(),
  /** The public part of the rig's key on the message bus (goal 168), checked by control. */
  bus_key: z.string().max(100).optional(),
  /** The public part of the key control seals the rig's config to on the bus, checked by control. */
  bus_seal_key: z.string().max(100).optional(),
  /** Its live lines on the message bus. A malformed one is dropped, not the figures. */
  live: LiveFigures.optional().catch(undefined),
  /** Its config updates from the message bus. A malformed one is dropped, not the figures. */
  config: ConfigFigures.optional().catch(undefined),
  /** Its loops' ages, as its health route gives them (goal 173). A malformed one is dropped. */
  loops: LoopAges.optional().catch(undefined),
});

/**
 * The supervisor's figures, its regular call. Control's answer names its place in the rig's
 * events (`reports`, core/link/report.ts's ReportPlace): on the message bus, the supervisor goes
 * back there after a page control refused.
 */
export const FIGURES = {
  method: "POST",
  path: "/v1/rigs/:rig/supervisor",
  what: "figures",
  body: SupervisorFigures,
  answer: z.looseObject({ reports: z.unknown().optional() }),
  maxBytes: 256 * 1024,
} as const satisfies Route;

/** The most of the supervisor's own live lines one call carries. */
export const OWN_LINES_MAX = 500;

/**
 * The rig's live lines: the harness's batch, signed, and the supervisor's own (its advisors),
 * unsigned. Lines this control does not know are left out and counted (`left_out`).
 */
export const LIVE = {
  method: "POST",
  path: "/v1/rigs/:rig/live",
  what: "live lines",
  body: z.object({
    batch: LiveBatchWire,
    supervisor: z
      .object({
        log_id: z.string().min(1).max(64),
        entries: z.array(z.unknown()).max(OWN_LINES_MAX),
      })
      .optional(),
  }),
  answer: z.looseObject({ left_out: z.record(z.string(), z.number()).optional() }),
  maxBytes: 4 * 1024 * 1024,
} as const satisfies Route;

/**
 * The screens of the rig's trials that someone watches on control (goal 169; core/screens.ts),
 * none when nobody does; control's answer names the trials watched now, whose screens the
 * supervisor sends next. Control keeps the newest of each in memory while it is watched.
 */
export const SCREENS = {
  method: "POST",
  path: "/v1/rigs/:rig/screens",
  what: "screens",
  body: z.object({ frames: z.array(ScreenFrame).max(SCREENS_WATCHED_MAX) }),
  answer: z.looseObject({ watch: WatchedTrials }),
  maxBytes: SCREENS_MAX_BYTES,
} as const satisfies Route;

/** A model route as the supervisor reads it: it passes the route on to its harness untouched. */
const RouteSeen = z.looseObject({ name: z.string(), version: z.number(), revision: z.string() });

/**
 * The model route of the rig's agents, with its key (null: none, the rig's own settings), and
 * the planner's own route when the owner gave the planner a model (core/api/model-route.ts has
 * what a route holds). 409 when control can't open the provider's key.
 */
export const MODEL_ROUTE = {
  method: "GET",
  path: "/v1/rigs/:rig/model-route",
  what: "model route",
  answer: z.looseObject({
    route: RouteSeen.nullable(),
    planner: RouteSeen.nullable().optional(),
  }),
} as const satisfies Route;

/** An advisor's route as the supervisor runs it: what it reads of a ControlRoute. */
export const AdvisorRoute = z.looseObject({
  name: z.string(),
  type: z.string(),
  base_url: z.string(),
  model: z.string(),
  /** The route's window: the provider's, or the owner's cap on the role's model (goal 070). */
  context_window: z.number(),
  /** The role's compaction point, when the owner set one (goal 070). */
  compact_at: z.number().optional(),
  /** The model's maximum output from the provider's list; 0 or none: none sent (goal 079). */
  max_tokens: z.number().optional(),
  reasoning: z.string().nullable(),
  effort: z.string().nullable().optional(),
  /** The harness the role runs in (older controls: none, Pi or what the model needs). */
  harness: z.string().optional(),
  api_key: z.string(),
});
export type AdvisorRoute = z.infer<typeof AdvisorRoute>;

/**
 * The advisors' routes, by role, when the owner gave them models: the teachers' one or two, their
 * merged by model, the auditor and the review panel (null: the rig's advisors file decides), and
 * the synthesizer and the final writer (goal 166; null: the first teacher's model).
 */
export const ADVISOR_ROUTES = {
  method: "GET",
  path: "/v1/rigs/:rig/advisor-routes",
  what: "advisor routes",
  answer: z.looseObject({
    teacher_models: z.array(AdvisorRoute).optional(),
    merged_by: AdvisorRoute.nullable().optional(),
    auditor: AdvisorRoute.nullable().optional(),
    review_panel: AdvisorRoute.nullable().optional(),
    synthesizer: AdvisorRoute.nullable().optional(),
    final_writer: AdvisorRoute.nullable().optional(),
  }),
} as const satisfies Route;

/** The MCP servers the kits of the rig's runs name, each with its sign-in as headers (goal 068). */
export const MCP_SERVERS = {
  method: "GET",
  path: "/v1/rigs/:rig/mcp-servers",
  what: "MCP servers",
  answer: z.object({
    servers: z.array(McpConnection).max(MCP_SERVERS_MAX),
    unavailable: z.array(McpUnavailable).max(MCP_SERVERS_MAX).default([]),
  }),
} as const satisfies Route;

/**
 * Past research for a run (goal 065): the items of the collections its campaign may read, after the
 * supervisor's cursor (core/kb.ts reads a page). A 404 names its code: `not_assigned` when control
 * did not assign the run to this rig (asked again an hour later); with none, control has not heard
 * of the run from the rig yet (asked again at the next sync).
 */
export const KB = {
  method: "GET",
  path: "/v1/rigs/:rig/kb",
  what: "knowledge base",
  answer: z.unknown(),
} as const satisfies Route;
export const KB_NOT_ASSIGNED = "not_assigned";

/**
 * A search or a read of the knowledge base for one of the rig's runs (goal 175), over HTTP, for a
 * rig not on the message bus: the same ask and answer as on the bus (core/link/kb.ts). Control
 * answers only for a run it assigned to this rig, from the run's scope, and refuses in words.
 */
export const KB_SEARCH_ASK = {
  method: "POST",
  path: "/v1/rigs/:rig/kb/search",
  what: "knowledge base search",
  body: KbSearchAsk,
  answer: KbAskAnswer,
  maxBytes: 16 * 1024,
} as const satisfies Route;
export const KB_READ_ASK = {
  method: "POST",
  path: "/v1/rigs/:rig/kb/read",
  what: "knowledge base read",
  body: KbReadAsk,
  answer: KbAskAnswer,
  maxBytes: 16 * 1024,
} as const satisfies Route;

/**
 * The largest champion's patch. Control keeps one only when its SHA-256 is the one the rig's
 * signed champion_published event names: 409 while it has no such event yet (sent again), 422 when
 * the patch is another (not sent again).
 */
export const CHAMPION_PATCH_MAX = 64 * 1024 * 1024;
export const CHAMPION_PATCH = {
  method: "POST",
  path: "/v1/rigs/:rig/champions/:run/:seq/patch",
  what: "champion patch",
  answer: z.looseObject({ stored: z.boolean() }),
  maxBytes: CHAMPION_PATCH_MAX,
} as const satisfies Route;

/** An export's name, as the harness makes them: a time and 8 hexadecimal characters. */
export const EXPORT_NAME = /^[0-9TZ]{8,20}-[0-9a-f]{8}$/;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A file's place in an export: plain names, no "." or ".." parts (as the exporter checks). */
const RelPath = z
  .string()
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._()-]+)*$/)
  .refine((p) => p.split("/").every((s) => s !== "." && s !== ".."), "a plain path");

/** An export's manifest, as the harness wrote it: every file with its SHA-256. */
export const ExportManifest = z.looseObject({
  rig: z.string().max(200).optional(),
  full: z.boolean().optional(),
  from_event: z.number().int().min(0),
  through_event: z.number().int().min(0),
  files: z.record(RelPath, Sha256),
});

/** What control has of an export: the bytes of each file, the files kept, and whether all are. */
const ExportHave = z.looseObject({
  received: z.record(z.string(), z.number()),
  done: z.array(z.string()),
  complete: z.boolean(),
});

/**
 * The start of an export: its manifest and the files the rig sends, each with its size in bytes.
 * A field this control does not know is dropped (a newer supervisor may send more, goal 012): the
 * manifest's SHA-256s, checked on every file, are what guard it. 400: control refuses it; 409:
 * control has another export of that name from the rig.
 */
export const EXPORT_BEGIN = {
  method: "POST",
  path: "/v1/rigs/:rig/exports/:name",
  what: "export",
  body: z.object({
    manifest: ExportManifest,
    files: z.record(RelPath, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
  }),
  answer: ExportHave,
  maxBytes: 8 * 1024 * 1024,
} as const satisfies Route;

/** The largest piece of an export's file one request carries. */
export const EXPORT_PIECE_MAX = 16 * 1024 * 1024;

/**
 * One piece of an export's file (`?path=`), at the place control has (`?offset=`). 409, with what
 * it has in `received`: go on from there.
 */
export const EXPORT_FILE = {
  method: "POST",
  path: "/v1/rigs/:rig/exports/:name/file",
  what: "export",
  answer: z.looseObject({
    received: z.number(),
    done: z.boolean().optional(),
    complete: z.boolean().optional(),
  }),
  maxBytes: EXPORT_PIECE_MAX,
} as const satisfies Route;

/**
 * Git access for a private repository, to a rig while a live assignment of it names the access,
 * with the host it is for: the rig's supervisor uses it for that host only.
 */
export const GIT_ACCESS = {
  method: "GET",
  path: "/v1/rigs/:rig/git-access/:name",
  what: "Git access",
  answer: z.looseObject({
    kind: z.string().optional(),
    private_key: z.string().optional(),
    token: z.string().optional(),
    username: z.string().optional(),
    host: z.string().optional(),
  }),
} as const satisfies Route;

/** A kit control keeps, as plain-HTTP git for the rig's supervisor to fetch: `source` is kits/<name>. */
export function gitRepoPath(rig: string, source: string): string {
  return `/v1/rigs/${encodeURIComponent(rig)}/git/${source}.git`;
}

/** The longest daily report, in characters: a longer one is cut to it. */
export const REPORT_MAX_CHARS = 200_000;

/** The rig's daily report, in Markdown (supervisor/report.ts writes it from the harness's briefs). */
export const REPORTS = {
  method: "POST",
  path: "/v1/rigs/:rig/reports",
  what: "daily report",
  body: z.object({ kind: z.enum(["daily"]), body: z.string().min(1).max(REPORT_MAX_CHARS) }),
  answer: z.looseObject({ id: z.number() }),
  maxBytes: 1024 * 1024,
} as const satisfies Route;
