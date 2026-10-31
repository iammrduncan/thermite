import { z } from "zod";

/**
 * What a rig's report says still runs (`summary.work`): its open trials, the judge's jobs and a
 * drain. Each open trial comes with its task and counters (goal 136) and, from a harness with goal
 * 143, what it is doing: when it last sent a line, its open model call (Pi) and a streak of the
 * same calls. The report is the harness's; these schemas read it leniently, field by field.
 */

const Reply = z.object({
  since: z.string().max(40),
  text: z.number(),
  thinking: z.number(),
  tool_args: z.number(),
  reported_at: z.string().max(40),
});

const Repeating = z.object({
  count: z.number(),
  since: z.string().max(40),
  different: z.number(),
  calls: z.array(z.object({ call: z.string().max(400), times: z.number() })).max(20),
});

export const OpenTrial = z.object({
  trial: z.string().max(64),
  run: z.string().max(80),
  lane: z.string().max(32),
  started_at: z.string().max(40),
  task: z.string().max(4000).nullable(),
  question: z.number().int().nullable(),
  turns: z.number(),
  tool_calls: z.number(),
  tokens_in: z.number(),
  claims: z.number().nullable(),
  refused_again: z
    .object({
      url: z.string().max(1000),
      reason: z.string().max(1000),
      asked: z.number(),
      at: z.string().max(40),
      times: z.number(),
    })
    .nullable(),
  // From a harness with goal 143; absent from an older one.
  last_line_at: z.string().max(40).nullable().optional(),
  reply: Reply.nullable().optional(),
  repeating: Repeating.nullable().optional(),
});
export type OpenTrial = z.infer<typeof OpenTrial>;

export const Work = z.object({
  trials: z.number(),
  judge_jobs: z.number(),
  draining: z
    .object({
      since: z.string().max(40),
      reason: z.string().max(1000),
      by: z.string().max(200).optional(),
      // From a harness with goal 173: when it stops waiting by itself, and when it did.
      deadline: z.string().max(40).optional(),
      deadline_reached: z.string().max(40).optional(),
    })
    .nullable(),
  open: z.array(OpenTrial).max(64).optional(),
  // From a harness with goal 169's planner in its terminal: the calls outside a trial in theirs.
  terminals: z
    .array(z.object({ id: z.string().max(100), run: z.string().max(80), role: z.string().max(40) }))
    .max(16)
    .optional(),
});
export type Work = z.infer<typeof Work>;

/** The report's `work`, when it reads; undefined from a harness too old to send it. */
export function workOf(summary: unknown): Work | undefined {
  const w = Work.safeParse((summary as { work?: unknown } | null | undefined)?.work);
  return w.success ? w.data : undefined;
}

/**
 * What a lane's trial is doing, as at_work gives it (goal 143): when it last sent a line, its open
 * model call and a streak of the same calls, from a harness with goal 143 (absent from an older
 * one); and a page the run refused that it asks for again (goal 136), from a harness with goal 136.
 */
export interface TrialDoing {
  last_line_at?: string | null;
  reply?: z.infer<typeof Reply> | null;
  repeating?: z.infer<typeof Repeating> | null;
  refused_again?: OpenTrial["refused_again"];
}

/** Each open trial's doings, by trial, with what its harness reports. */
export function doingsOf(summary: unknown): Map<string, TrialDoing> {
  const out = new Map<string, TrialDoing>();
  for (const t of workOf(summary)?.open ?? []) {
    const d: TrialDoing = { refused_again: t.refused_again };
    if (t.last_line_at !== undefined)
      Object.assign(d, {
        last_line_at: t.last_line_at,
        reply: t.reply ?? null,
        repeating: t.repeating ?? null,
      });
    out.set(t.trial, d);
  }
  return out;
}

const Disk = z.object({
  floor_gib: z.number(),
  low: z.boolean(),
  since: z.string().max(40).nullable(),
  checked_at: z.string().max(40),
  places: z
    .array(z.object({ name: z.string().max(32), free_gib: z.number(), total_gib: z.number() }))
    .max(16),
});
export type RigDiskView = z.infer<typeof Disk>;

/**
 * The report's `disk` (goal 173): the rig's free space on each place it writes to, against its
 * floor; undefined from a harness too old to send it.
 */
export function diskOf(summary: unknown): RigDiskView | undefined {
  const d = Disk.safeParse((summary as { disk?: unknown } | null | undefined)?.disk);
  return d.success ? d.data : undefined;
}
