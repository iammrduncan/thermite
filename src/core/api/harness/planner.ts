import { z } from "zod";
import type { Route } from "../route.ts";

/**
 * A planner's own process (goal 169; the harness answers in src/harness/api/trials.ts). On a rig
 * whose agents run in their own terminal, a planner in Pi runs in a process of its own, in its Pi
 * view, as the planner's user. It reaches the harness with a credential bound to its call
 * (`call.<token>`), as a worker reaches it with its trial's token, and gives its answer here: the
 * arguments of its submit_plan, which the harness checks as data, or why it gave none.
 */

/** Why a planner's try gave no plan (src/harness/agents/planner/causes.ts says each in words). */
export const PLAN_CAUSES = [
  "timeout",
  "text_only",
  "cut_off",
  "provider_error",
  "cancelled",
  "invalid",
] as const;

/** The most bytes of a planner's plan, as JSON. */
export const PLANNER_ANSWER_MAX = 1024 * 1024;

/** The call's answer: its plan's arguments, or why it gave none. The first answer counts. */
export const PLANNER_ANSWER = {
  method: "POST",
  path: "/v1/planner/answer",
  body: z.union([
    z.strictObject({ plan: z.record(z.string(), z.unknown()) }),
    z.strictObject({ cause: z.enum(PLAN_CAUSES), detail: z.string().max(2000) }),
  ]),
  answer: z.looseObject({ ok: z.literal(true) }),
  maxBytes: PLANNER_ANSWER_MAX + 4096,
} as const satisfies Route;
export type PlannerAnswer = z.infer<typeof PLANNER_ANSWER.body>;
