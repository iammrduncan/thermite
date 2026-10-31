import { z } from "zod";
import {
  PROMPT_RECORD_MAX_CHARS,
  PROMPT_TURN_MAX,
  PromptRecord,
  PromptSection,
} from "../../prompts.ts";
import type { Route } from "../route.ts";

/**
 * The harness's API for the prompts its run's agents were sent (goal 166; src/harness/api/
 * prompts.ts answers it): the supervisor keeps its advisors' prompts there, and reads a run's
 * prompts, one prompt whole, and a preview of the next one, on the rig. Those routes take the
 * supervisor's token; a Pi worker keeps its later turns with its trial's (src/harness/api/
 * trials.ts).
 */

/** A prompt's sections as a sender hands them over to keep: at most PROMPT_RECORD_MAX_CHARS. */
const KeptSections = z
  .array(PromptSection)
  .min(1)
  .max(200)
  .refine(
    (ss) => ss.reduce((n, s) => n + s.text.length, 0) <= PROMPT_RECORD_MAX_CHARS,
    `a prompt kept has at most ${PROMPT_RECORD_MAX_CHARS.toLocaleString("en-US")} characters`,
  );

/** The roles whose prompts the supervisor sends: its advisors. The harness keeps the rest. */
export const ADVISOR_PROMPT_ROLES = [
  "teacher",
  "research-teacher",
  "merged-by",
  "research-merged-by",
  "auditor",
  "reviewer",
  "research-reviewer",
  "synthesizer",
  "final-writer",
] as const;

/** An advisor's prompt, as the supervisor sent it, for the harness to keep with its run. */
export const KEEP_PROMPT = {
  method: "POST",
  path: "/v1/prompts",
  body: PromptRecord.extend({
    run: z.string().min(1).max(100),
    role: z.enum(ADVISOR_PROMPT_ROLES),
    sections: KeptSections,
  }),
  answer: z.looseObject({ id: z.number() }),
  maxBytes: 16 * 1024 * 1024,
} as const satisfies Route;

/** The roles whose later turns a trial's worker in Pi keeps, and a planner's own process. */
export const TRIAL_PROMPT_ROLES = ["worker", "research-worker"] as const;
export const CALL_PROMPT_ROLES = ["planner", "research-planner"] as const;

/**
 * A later turn a worker in Pi sent inside its trial (a nudge, a warning, a continuation), as its
 * own code rendered it, for the harness to keep as it keeps the trial's first prompt: the trial's
 * token decides the run, the lane and the trial. A planner in Pi in its own process (goal 169)
 * keeps its later turns the same way, its call's credential deciding the run and the call.
 */
export const KEEP_TRIAL_PROMPT = {
  method: "POST",
  path: "/v1/trial/prompt",
  body: z.strictObject({
    role: z.enum([...TRIAL_PROMPT_ROLES, ...CALL_PROMPT_ROLES]),
    program: z.literal("pi"),
    turn: z.number().int().min(1).max(PROMPT_TURN_MAX),
    sections: KeptSections,
  }),
  answer: z.looseObject({ id: z.number() }),
  maxBytes: 16 * 1024 * 1024,
} as const satisfies Route;

/** A prompt kept, without its text. */
export const PromptInfo = z.looseObject({
  id: z.number(),
  run: z.string(),
  role: z.string(),
  program: z.string(),
  turn: z.number(),
  lane: z.string().nullable(),
  trial: z.string().nullable(),
  call: z.string().nullable(),
  version: z.string(),
  at: z.string(),
  chars: z.number(),
  bytes: z.number(),
});

/** A run's prompts, oldest first, without their text. */
export const RUN_PROMPTS = {
  method: "GET",
  path: "/v1/runs/:run/prompts",
  answer: z.looseObject({ prompts: z.array(PromptInfo) }),
} as const satisfies Route;

/** One prompt of a run, whole: its sections, each with its source and its text. */
export const RUN_PROMPT = {
  method: "GET",
  path: "/v1/runs/:run/prompts/:id",
  answer: PromptInfo.extend({ sections: z.array(PromptSection) }),
} as const satisfies Route;

/**
 * The prompt a role would be sent next in a run, rendered now on the rig with no side effect:
 * nothing is kept, no message is marked as given and no file is written (`?role=worker&lane=`
 * or `?role=planner`).
 */
export const PROMPT_PREVIEW = {
  method: "GET",
  path: "/v1/runs/:run/prompt-preview",
  answer: z.looseObject({
    role: z.string(),
    program: z.string(),
    sections: z.array(PromptSection),
  }),
} as const satisfies Route;
