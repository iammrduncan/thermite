import { z } from "zod";
import { DirectionRef } from "./directions.ts";

/**
 * Low-power steering. Strict: a directive cannot carry anything but these fields, so it cannot
 * set a verdict, a contract or text for workers. AVOID, TRY and MANDATE name a direction (goal
 * 066), in plain words or as `:name:`, kept as its name; code keeps them at every hand-out. A
 * direction the run doesn't have yet is the planner's to design at its next round. PRIORITY ranks a
 * direction; LANE_COUNT sets the lanes (up to the contract's count); TRIAL_MINUTES sets how long
 * one trial lasts, in minutes (value, 1 to 1,440), over the contract's; KEEP_WORKING turns the
 * run's lanes keeping working while the judge works on or off (value, on or off), over the
 * contract's; OPEN_ATTEMPTS sets how many changes the judge has not settled before the lanes start
 * no new trial (value, a whole number from 1), over the contract's (goal 230), the owner's and an
 * operator's alone; PLANNER_NOTE is free text for the
 * planner only. The planner sees rationales and notes; workers never do. A rule in words that
 * names no direction (`match`) is no longer made: one already in a ledger stays in force as
 * legacy (isLegacyRule) until the planner's next round converts it to a named direction.
 */
/** The most changes an open_attempts rule lets wait for the judge (goal 230). */
export const OPEN_ATTEMPTS_MAX = 1000;

/** The kinds of directive. None of them is ever a direction's name (a lane "on try"). */
export const DIRECTIVE_KINDS = [
  "avoid",
  "try",
  "mandate",
  "priority",
  "lane_count",
  "trial_minutes",
  "keep_working",
  "open_attempts",
  "planner_note",
] as const;

export const StructuredDirective = z
  .strictObject(
    {
      kind: z.enum(DIRECTIVE_KINDS),
      /** The direction the directive is about: plain words or `:name:`, kept as its name. */
      direction: DirectionRef.optional(),
      value: z.union([z.string().max(1000), z.number()]).optional(),
      /** Why, with citations; shown to the planner, never to workers. */
      rationale: z.string().min(1).max(2000),
      citations: z.array(z.string().min(1).max(500)).max(20).default([]),
    },
    {
      error: (iss) =>
        iss.code === "unrecognized_keys" && iss.keys.includes("match")
          ? "a rule no longer takes match: give its direction in direction, in plain words or as :name:"
          : undefined,
    },
  )
  // A research run's TRY or MANDATE may name a question by its number (value) instead.
  .refine(
    (d) =>
      !["avoid", "try", "mandate"].includes(d.kind) ||
      d.direction !== undefined ||
      (d.kind !== "avoid" && d.value !== undefined),
    {
      message: "an avoid, try or mandate rule names a direction",
      path: ["direction"],
    },
  )
  .refine(
    (d) =>
      d.kind !== "trial_minutes" ||
      (Number.isInteger(d.value) && Number(d.value) >= 1 && Number(d.value) <= 1440),
    {
      message: "a trial_minutes rule gives value: minutes, a whole number from 1 to 1440",
      path: ["value"],
    },
  )
  .refine((d) => d.kind !== "keep_working" || d.value === "on" || d.value === "off", {
    message: "a keep_working rule gives value: on or off",
    path: ["value"],
  })
  .refine(
    (d) =>
      d.kind !== "open_attempts" ||
      (Number.isInteger(d.value) && Number(d.value) >= 1 && Number(d.value) <= OPEN_ATTEMPTS_MAX),
    {
      message: `an open_attempts rule gives value: how many changes may wait for the judge, a whole number from 1 to ${OPEN_ATTEMPTS_MAX}`,
      path: ["value"],
    },
  );
export type StructuredDirective = z.infer<typeof StructuredDirective>;

/**
 * A rule as a ledger holds it: a directive, the owner's message a planner's rule came from, and,
 * for an old rule in words (legacy), its words. A rule the planner converted from an old rule in
 * words names that rule and its words (`converted_from`).
 */
export type StoredRule = StructuredDirective & {
  from_message?: number | undefined;
  match?: string | undefined;
  converted_from?: { rule: number; words: string } | undefined;
};
