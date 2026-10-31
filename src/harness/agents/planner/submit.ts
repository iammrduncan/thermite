import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { Prompt } from "../../../agents/prompt.ts";
import { PLAN_LIMITS, type PlannerInput, renderPlanner } from "../../../agents/roles/index.ts";
import { JOURNAL_FIELD } from "../../../agents/tools/index.ts";

/**
 * What a planner call is told and how it answers: its prompt, from its role's definition (goal
 * 166), and in Pi its one tool, submit_plan (whose description and parameters these are);
 * through another harness it answers with JSON text. The hill climb's and goal campaign's plan
 * and the research plan (research/planner.ts) each have their own.
 */
export interface PlannerCallSpec {
  /** Which call it is, as a planner's own process names it (goal 169). */
  id: "plan" | "research";
  render(i: PlannerInput): Prompt;
  description: string;
  parameters: TSchema;
}

const Position = Type.Union([Type.String(), Type.Number()], {
  description: '"top", "end", or an index among the queued experiments (0 first)',
});

/** submit_plan's parameters (Pi): every limit the checks hold the plan to (goal 079). */
const PLAN_PARAMETERS = Type.Object({
  assignments: Type.Array(
    Type.Object({
      lane: Type.String(),
      experiment: Type.Optional(
        Type.String({
          maxLength: PLAN_LIMITS.id,
          description:
            "An id from queue.up_next or queue.proposed, or the ref of an experiment you add",
        }),
      ),
      parent: Type.Optional(Type.Union([Type.Literal("champion"), Type.Literal("lane_best")])),
      why: Type.Optional(
        Type.String({ maxLength: PLAN_LIMITS.why, description: "Why this lane gets it" }),
      ),
      title: Type.Optional(
        Type.String({ maxLength: PLAN_LIMITS.title, description: "A new experiment, inline" }),
      ),
      focus: Type.Optional(
        Type.String({
          minLength: 3,
          maxLength: PLAN_LIMITS.focus,
          description: "Or what to try, in words: past its title, it goes in details",
        }),
      ),
      family: Type.Optional(Type.String({ maxLength: PLAN_LIMITS.family })),
      details: Type.Optional(Type.String({ maxLength: PLAN_LIMITS.details })),
    }),
  ),
  add: Type.Optional(
    Type.Array(
      Type.Object({
        ref: Type.Optional(Type.String({ maxLength: PLAN_LIMITS.ref })),
        title: Type.String({ minLength: 1, maxLength: PLAN_LIMITS.title }),
        details: Type.Optional(Type.String({ maxLength: PLAN_LIMITS.details })),
        family: Type.Optional(Type.String({ maxLength: PLAN_LIMITS.family })),
        why: Type.String({ minLength: 1, maxLength: PLAN_LIMITS.why }),
        position: Type.Optional(Position),
      }),
    ),
  ),
  move: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ maxLength: PLAN_LIMITS.id }),
        position: Position,
        why: Type.String({ minLength: 1, maxLength: PLAN_LIMITS.why }),
      }),
      { maxItems: PLAN_LIMITS.changes },
    ),
  ),
  drop: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ maxLength: PLAN_LIMITS.id }),
        why: Type.String({ minLength: 1, maxLength: PLAN_LIMITS.why }),
      }),
      { maxItems: PLAN_LIMITS.changes },
    ),
  ),
  accept: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ maxLength: PLAN_LIMITS.id }),
        why: Type.String({ minLength: 1, maxLength: PLAN_LIMITS.why }),
        position: Type.Optional(Position),
      }),
    ),
  ),
  rules: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.String({ description: "avoid | try | mandate" }),
        family: Type.String({
          maxLength: 200,
          description:
            "The rule's direction: one in directions, or a new one you design in new_families. A message's :name: names one exactly",
        }),
        rationale: Type.String({ minLength: 1, maxLength: PLAN_LIMITS.why }),
        from_message: Type.Number(),
      }),
      { maxItems: PLAN_LIMITS.rules },
    ),
  ),
  convert: Type.Optional(
    Type.Array(
      Type.Object({
        rule: Type.Number({ description: "An old rule in words, by its id" }),
        family: Type.String({
          maxLength: 200,
          description:
            "The direction its words mean: one in directions, or a new one you design in new_families",
        }),
      }),
      {
        maxItems: PLAN_LIMITS.convert,
        description: "Each old rule in words in to_convert, with its direction",
      },
    ),
  ),
  new_families: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ description: "A new direction's name, in a few words" }),
        description: Type.String({
          minLength: 3,
          maxLength: PLAN_LIMITS.description,
          description: "What it means, in your words",
        }),
      }),
      {
        maxItems: PLAN_LIMITS.newFamilies,
        description:
          "New directions you design: each one in to_design, and any a rule or a conversion of yours names",
      },
    ),
  ),
  notes: Type.Optional(Type.String({ maxLength: PLAN_LIMITS.notes })),
  journal: JOURNAL_FIELD,
});

/** The hill climb's and goal campaign's planner call. */
export const PLAN_SPEC: PlannerCallSpec = {
  id: "plan",
  render: renderPlanner,
  description: "Submit this round's plan: each lane's experiment, and your changes to the queue.",
  parameters: PLAN_PARAMETERS,
};
