import { z } from "zod";
import { SupervisorFigures } from "../api/control/rigs.ts";
import { RIG_ID } from "../ids.ts";
import { RigSpace } from "../retention/index.ts";
import { SCREENS_WATCHED_MAX, ScreenFrame, WatchedTrials } from "../screens.ts";
import { ReportPlace } from "./report.ts";

/**
 * A rig's asks of control on the message bus (goal 168, step 5c): the supervisor's regular call
 * with its figures, the screens of the trials someone watches, its daily report, a command
 * signed again while its sources stage, and what the rig keeps of the kinds a retention policy
 * may remove. Each is a request on the rig's own subject with its one
 * answer, NATS's request and reply: no stream keeps either, and the answer goes to the rig's inbox
 * alone. A rig's user may publish only on its own subjects
 * (users.ts), so control knows the rig from the subject. A refusal comes back in words.
 */

/** What a rig asks control, each the last token of its subject. */
export const RIG_ASK_KINDS = ["figures", "screens", "daily", "renew", "space"] as const;
export type RigAskKind = (typeof RIG_ASK_KINDS)[number];

/** Every rig's asks, as control serves them: `thermite.rig.<rig>.ask.<kind>`. No stream takes them. */
export const RIG_ASK_SUBJECTS = "thermite.rig.*.ask.*";

/** The subject a rig asks on. */
export function rigAskSubject(rig: string, kind: RigAskKind): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for an ask's subject: ${rig}`);
  return `thermite.rig.${rig}.ask.${kind}`;
}

const SUBJECT = /^thermite\.rig\.([^.*>\s]+)\.ask\.([^.*>\s]+)$/;

/** What a subject asks, and for which rig; undefined for a subject that is not one. */
export function rigAskOf(subject: string): { rig: string; kind: RigAskKind } | undefined {
  const [, rig = "", kind = ""] = SUBJECT.exec(subject) ?? [];
  if (!RIG_ID.test(rig) || !(RIG_ASK_KINDS as readonly string[]).includes(kind)) return undefined;
  return { rig, kind: kind as RigAskKind };
}

/**
 * How long a supervisor waits for control's answer: then the call fails, and the loop that made it
 * tries again at its next round.
 */
export const RIG_ASK_TIMEOUT_MS = 20_000;

/** Why control gave no answer, in words; `code` says which refusal a caller acts on. */
export const RigAskRefusal = z.object({ refused: z.string(), code: z.string().optional() });
export type RigAskRefusal = z.infer<typeof RigAskRefusal>;

/**
 * How often a supervisor tells control what its rig keeps of the kinds a retention policy may
 * remove, in milliseconds: a look walks the build store and the advisors' records.
 */
export const RIG_SPACE_ASK_MS = 10 * 60_000;

/** The longest daily report, in characters: a longer one is cut to it. */
export const REPORT_MAX_CHARS = 200_000;

/**
 * What each ask carries and what control answers it with, a refusal aside:
 * - `figures`: the supervisor's figures, as it registers them over HTTPS but without its keys (its
 *   user on the bus is its key); control answers with its place in the rig's reports, where the
 *   supervisor goes back to after a page control refused (core/link/report.ts).
 * - `screens`: the screens of the trials watched (none when nobody watches, core/screens.ts);
 *   control answers with the trials watched now, whose screens the supervisor sends next.
 * - `daily`: the rig's daily report in Markdown; control answers with its id.
 * - `renew`: a command whose sources still stage, by its id; control answers with it signed again
 *   with a later expiry (`command`), or refuses in words.
 * - `space`: what the rig keeps of each kind a retention policy may remove there (the judge's
 *   builds, from its harness; the advisors' records, its supervisor's own), each item with its
 *   run, time and bytes (core/retention/), every RIG_SPACE_ASK_MS and after each removal;
 *   control keeps the newest for the Space table and each policy's preview, and answers ok.
 */
export const RIG_ASKS = {
  figures: {
    body: SupervisorFigures.omit({ bus_key: true, bus_seal_key: true }),
    answer: z.looseObject({ reports: ReportPlace }),
  },
  screens: {
    body: z.object({ frames: z.array(ScreenFrame).max(SCREENS_WATCHED_MAX) }),
    answer: z.looseObject({ watch: WatchedTrials }),
  },
  daily: {
    body: z.object({ kind: z.enum(["daily"]), body: z.string().min(1).max(REPORT_MAX_CHARS) }),
    answer: z.looseObject({ id: z.number() }),
  },
  space: { body: RigSpace, answer: z.looseObject({ ok: z.literal(true) }) },
  renew: {
    body: z.object({ id: z.uuid() }),
    answer: z.looseObject({
      command: z.looseObject({
        envelope: z.looseObject({ id: z.uuid(), expires_at: z.iso.datetime() }),
      }),
    }),
  },
} as const satisfies Record<RigAskKind, { body: z.ZodType; answer: z.ZodType }>;

export type RigAskBody<K extends RigAskKind> = z.input<(typeof RIG_ASKS)[K]["body"]>;
export type RigAskAnswer<K extends RigAskKind> = z.output<(typeof RIG_ASKS)[K]["answer"]>;
