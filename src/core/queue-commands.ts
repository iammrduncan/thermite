import { z } from "zod";
import { RunAcceptance, RunLaneLimits } from "./contract.ts";
import { directionName } from "./directions.ts";
import { ExperimentId, RunId } from "./ids.ts";

/**
 * The owner's commands for a run's experiment queue (goal 064), with the words an experiment is
 * given in and where it goes, a running run's lane limits (goal 221) and its acceptance (goal
 * 233). commands.ts holds them among every kind's payload.
 */

/** Where an experiment goes among the queued ones: first, last, or at an index (0 first). */
export const QueuePosition = z.union([
  z.literal("top"),
  z.literal("end"),
  z.number().int().min(0).max(100_000),
]);
export type QueuePosition = z.infer<typeof QueuePosition>;

/** An experiment's text: what to try, its details, its direction and why it is worth trying. */
/** The most characters of an experiment's details. */
export const EXPERIMENT_DETAILS = 4000;

export const ExperimentText = {
  title: z.string().trim().min(1).max(200),
  details: z.string().max(EXPERIMENT_DETAILS),
  /**
   * The direction: a direction's name, or words, whose direction is the name
   * they make (directionOf). Written `:name:`, it is kept without the colons.
   */
  direction: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((s) => {
      const inner = /^:(.+):$/.exec(s)?.[1]?.trim();
      return inner && directionName(inner) ? inner : s;
    }),
  why: z.string().max(2000),
  /** How many trials it gets before it counts as tried (goal 214): each on another lane if one can. */
  tries: z.number().int().min(1).max(10),
};

export const QUEUE_PAYLOADS = {
  /**
   * The run's experiment queue (goal 064), the owner's changes (owner only; an operator may issue
   * them for the owner). Add an experiment (by default at the end of up next), move a queued one,
   * edit or drop one still waiting, or queue a lane's proposed idea.
   */
  queue_add: z.strictObject({
    run: RunId,
    title: ExperimentText.title,
    details: ExperimentText.details.optional(),
    direction: ExperimentText.direction.optional(),
    why: ExperimentText.why.optional(),
    tries: ExperimentText.tries.optional(),
    position: QueuePosition.default("end"),
  }),
  queue_move: z.strictObject({ run: RunId, id: ExperimentId, position: QueuePosition }),
  queue_edit: z
    .strictObject({
      run: RunId,
      id: ExperimentId,
      title: ExperimentText.title.optional(),
      details: ExperimentText.details.optional(),
      direction: ExperimentText.direction.optional(),
      why: ExperimentText.why.optional(),
      tries: ExperimentText.tries.optional(),
    })
    .refine((p) => Object.keys(p).some((k) => k !== "run" && k !== "id"), {
      message: "change at least one of title, details, direction, why and tries",
    }),
  queue_drop: z.strictObject({
    run: RunId,
    id: ExperimentId,
    why: z.string().trim().min(1).max(2000),
  }),
  queue_accept: z.strictObject({
    run: RunId,
    id: ExperimentId,
    position: QueuePosition.optional(),
  }),
  /**
   * A running run's lane limits changed in place (goal 221): from the next lane command or
   * development run, over the contract's, each within its bounds; null goes back to the contract's.
   */
  lane_limits: z.strictObject({
    run: RunId,
    limits: RunLaneLimits,
    reason: z.string().trim().min(1).max(2000),
    /** True: what it would set and reach, with nothing changed. */
    preview: z.boolean().optional(),
  }),
  /**
   * A running run's acceptance changed in place (goal 233): each metric's minimum effect, a
   * confirmation's blocks and the early stop, over the contract's, from the judge's next screen or
   * confirmation; null goes back to the contract's.
   */
  acceptance: z.strictObject({
    run: RunId,
    acceptance: RunAcceptance,
    reason: z.string().trim().min(1).max(2000),
    /** True: what it would set and reach, with nothing changed. */
    preview: z.boolean().optional(),
  }),
  /**
   * A tried experiment back to up next (goal 221), such as one that a fault of Thermite's cut
   * short: its trial kept as an earlier try, one more try when its tries are used, with why.
   */
  queue_retry: z.strictObject({
    run: RunId,
    id: ExperimentId,
    why: z.string().trim().min(1).max(2000),
    position: QueuePosition.default("top"),
    /** True: what it would do, with nothing changed. */
    preview: z.boolean().optional(),
  }),
};
