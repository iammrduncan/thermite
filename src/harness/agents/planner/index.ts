import type { ModelConfig } from "../../../agents/model/index.ts";
import type { Prompt } from "../../../agents/prompt.ts";
import type { StoredRule } from "../../../core/directives.ts";
import type { NoteInput } from "../../../core/journal.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { Assignment } from "../registry.ts";
import { type Ask, type PlannerTries, plannerTries } from "./call.ts";
import type { PlanTry } from "./causes.ts";
import { type NewFamily, type QueuePlan, validatePlan } from "./check.ts";
import { type PlannerInput, type PlannerPast, plannerContext } from "./context.ts";
import { fallbackPlan } from "./fallback.ts";
import type { PlannerCompaction, PlannerMcp } from "./pi.ts";
import { PLAN_SPEC } from "./submit.ts";

export {
  type Ask,
  type PlannerTries,
  plannerTries,
} from "./call.ts";
export {
  causeWords,
  type PlanCause,
  PlannerCallError,
  type PlanTry,
} from "./causes.ts";
export { type NewFamily, type PlannerRule, type QueuePlan, validatePlan } from "./check.ts";
export {
  type GoalReport,
  lanesOf,
  type PlannerInput,
  type PlannerPast,
  plannerContext,
  queueTargetContext,
  toConvert,
  toDesign,
} from "./context.ts";
export { fallbackPlan, goalsNamed } from "./fallback.ts";
export type { PlannerCompaction, PlannerMcp } from "./pi.ts";
export type { PlannerCallSpec } from "./submit.ts";

/**
 * The planner: the coordinator of a run's lanes. One stateless model call per round, with
 * context built deterministically from the ledger: the run's experiment queue (up next in order,
 * the lanes' ideas, what lanes are on, the newest tried with their results), the rules for the
 * plan and the owner's messages. The queue is its memory; the harness keeps it.
 *
 * Its answer, through one tool call (or JSON through another harness): which experiment each
 * lane works on next and why, changes to the queue (add, move, drop, accept, each with why), and
 * the rules the owner's messages ask for. Code checks it: no two lanes share an experiment, a
 * dropped or finished experiment is never given out, AVOID families are never given out and
 * every MANDATE family is. A rule names a direction (goal 066): one the run has, or a new one the
 * planner designs (new_families, its name and what it means, in its words); a rule in force for a
 * direction the run doesn't have yet must be designed in the answer. Each old rule in words
 * (legacy) in force must be converted in the answer: the model names the direction its words mean
 * (convert), one the run has or one it designs, and code replaces the rule with one on that
 * direction. An answer that fails the checks gets one retry with the errors, then the fallback:
 * lanes take queued experiments in order (the scheduler does that), and the fixed plan below only
 * fills an empty queue; an old rule in words then waits for a later round. Planner trouble never
 * pauses research.
 *
 * Its parts are modules in planner/: what it reads (context.ts), the shape of its answer and its
 * check (check.ts), the fixed plan (fallback.ts), submit_plan's parameters (submit.ts), the call
 * and its tries (call.ts) in Pi (pi.ts), and why a try gave no plan (causes.ts).
 */

export interface PlanResult {
  source: "planner" | "fallback";
  tries: number;
  /** Why each try that gave no usable plan gave none (goal 079). */
  causes?: PlanTry[] | undefined;
  /** True when the model's plan was valid (on any try). */
  valid: boolean;
  /** What was wrong with the model's raw output, per try (the directive-compliance record). */
  rawViolations: string[];
  /** The fixed plan (fallback): a direction for each lane, used when the queue has nothing. */
  assignments: Assignment[];
  newFamilies: NewFamily[];
  notes?: string | undefined;
  /** The model's valid answer. */
  queue?: QueuePlan | undefined;
  /**
   * The field notes the model's answers carried (read leniently), also when the rest of the plan
   * was refused: the scheduler records them as the planner's.
   */
  journal?: NoteInput[] | undefined;
}

/**
 * Attribution: each assignment whose family a MANDATE (first) or TRY directive names records that
 * directive, so a directive's effect on an epoch can be traced to the lanes it steered.
 */
export function attribute(
  assignments: Assignment[],
  directives: { id: number; body: StoredRule }[],
): Assignment[] {
  const find = (kind: string, family: string) =>
    directives.filter((d) => d.body.kind === kind && d.body.family === family).at(-1)?.id;
  return assignments.map((a) => {
    const directive = find("mandate", a.family) ?? find("try", a.family);
    return directive === undefined ? a : { ...a, directive };
  });
}

export async function plan(
  input: PlannerInput,
  model?: ModelConfig,
  signal?: AbortSignal,
  ask?: Ask,
  past?: PlannerPast,
  mcp?: PlannerMcp,
  compaction?: PlannerCompaction,
  /** Each model call's usage in Pi (goal 075); another harness's goes with `ask`. */
  usage?: (u: CallUsage) => void,
  /** Keeps each try's prompt, as it is sent (goal 166). */
  sent?: (p: Prompt) => void,
): Promise<PlanResult> {
  let r: PlannerTries<ReturnType<typeof validatePlan>["plan"]> | undefined;
  if (model) {
    r = await plannerTries({
      context: plannerContext(input),
      addition: input.addition,
      model,
      spec: PLAN_SPEC,
      check: (raw) => validatePlan(raw, input),
      signal,
      ask,
      past,
      mcp,
      compaction,
      usage,
      sent,
    });
    const p = r.plan;
    if (p) {
      const { newFamilies, notes, ...queue } = p;
      return {
        source: "planner",
        tries: r.tries,
        valid: true,
        rawViolations: r.rawViolations,
        ...(r.causes.length ? { causes: r.causes } : {}),
        ...(r.journal.length ? { journal: r.journal } : {}),
        assignments: queue.handout.map((h) => {
          const x = familyAndTitle(h.experiment, input, queue);
          return {
            lane: h.lane,
            family: x.family,
            focus: x.title,
            parent: h.parent,
            experiment: h.experiment,
            why: h.why,
          };
        }),
        newFamilies,
        notes,
        queue,
      };
    }
  }
  const f = fallbackPlan(input);
  return {
    source: "fallback",
    tries: model ? 2 : 0,
    valid: false,
    rawViolations: r?.rawViolations ?? [],
    ...(r?.causes.length ? { causes: r.causes } : {}),
    assignments: f.assignments,
    newFamilies: f.newFamilies,
    ...(r?.journal.length ? { journal: r.journal } : {}),
  };
}

/** An experiment's direction and title, wherever the plan names it from. */
function familyAndTitle(
  id: string,
  input: PlannerInput,
  queue: QueuePlan,
): { family: string; title: string } {
  const q = input.queue;
  const x =
    q?.up_next.find((e) => e.id === id) ??
    q?.proposed.find((e) => e.id === id) ??
    queue.add.find((e) => e.ref === id);
  return { family: x?.family ?? "", title: x?.title ?? id };
}
