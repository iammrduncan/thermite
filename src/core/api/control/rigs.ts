import { z } from "zod";
import { LoopAges } from "../../health.ts";
import { LIVE_FIGURE_SUBJECTS } from "../../link/live.ts";
import type { Route } from "../route.ts";

/**
 * Control's API for a rig's supervisor (src/control/api/ answers it), each route with the rig's
 * own token and only for that rig (`:rig`): the registration of its keys on the message bus, its
 * results (champion patches and exports, for a rig with no results repository), and the kits its
 * campaigns name, by git. Everything else between a rig and control goes on the bus
 * (core/link/). In pull mode these calls cross the tunnel (control/runpod/tunnel.ts lets these
 * routes through, and no other).
 */

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
 * The registration of the rig's keys on the message bus, over HTTPS: the supervisor's first call
 * at each start, with its figures, and the only one it makes this way. Its keys' public parts are
 * required: control gives the rig's key its user on the bus before it answers, and seals the rig's
 * config to the seal key; a key another rig or control holds is refused. Everything after it goes
 * on the bus, the figures too (core/link/asks.ts). Control's answer names its place in the rig's
 * reports (`reports`, core/link/report.ts's ReportPlace).
 */
export const REGISTER = {
  method: "POST",
  path: "/v1/rigs/:rig/supervisor",
  what: "keys' registration",
  body: SupervisorFigures.extend({
    bus_key: z.string().max(100),
    bus_seal_key: z.string().max(100),
  }),
  answer: z.looseObject({ reports: z.unknown().optional() }),
  maxBytes: 256 * 1024,
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

/** A kit control keeps, as plain-HTTP git for the rig's supervisor to fetch: `source` is kits/<name>. */
export function gitRepoPath(rig: string, source: string): string {
  return `/v1/rigs/${encodeURIComponent(rig)}/git/${source}.git`;
}
