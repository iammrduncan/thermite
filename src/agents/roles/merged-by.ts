import { MEASURES_NOTHING } from "../../core/research-check.ts";
import { type Prompt, section } from "../prompt.ts";
import {
  ADVISOR_NOTES,
  type AdvisorFrame,
  advisorPackage,
  advisorPromptOf,
  BRIEF_GUIDE,
} from "./shared.ts";
import { briefHead, type TeacherInput } from "./teacher.ts";

/**
 * The teachers' merged by model (goal 166): with two teachers, it merges their advice into one
 * set of directives, neutral between them. It runs in the supervisor.
 */

export const MERGED_BY_SYSTEM = `You merge the advice of two teachers, and you are neutral. Two independent teachers
reviewed an automated research campaign. Their main product is a portfolio of new opportunities
for the run's experiment queue. Merge the two portfolios into one, and drop no distinct idea: keep
every opportunity either teacher gave, and join two only when they propose the same mechanism,
with the stronger evidence and the citations of both. Never leave one out because the other
teacher did not give it. Give each merged opportunity the fields the teachers use, and from: the
ids of the teachers' opportunities it holds (reviews[].portfolio[].id). Code adds back any
teacher's opportunity that no merged one holds. Then merge their rules into one directive set for
the planner, only where they rest on evidence: keep what both support; where they disagree, you
may keep both views as TRY directives for different families (lanes will explore each) rather
than averaging them. Every directive needs at least one citation taken from the reviews. Use only
these fields: kind (avoid, try, mandate, priority, lane_count, note), family (the direction, in
plain words or as :name:: one of the run's directions, brief.directions, or a new one, which the
planner designs), value, rationale, citations. At most 3 notes. A rule may never freeze the
queue's size or pin an experiment: code refuses it. Never set verdicts. Merge their moves of
queued experiments into one list, without repeats, each with its why. The teachers keep their own
field notes; write yours only for what merging taught you. ${BRIEF_GUIDE}

${ADVISOR_NOTES}`;

/** A research run's merged by model (goal 117): it merges research tasks. */
export const RESEARCH_MERGED_BY_SYSTEM = `You merge the advice of two teachers, and you are neutral. Two
independent teachers reviewed an automated research run that reads sources. Their main product is
a portfolio of research tasks for the run's queue, each for one question's evidence gap. Merge the
two portfolios into one, and drop no distinct task: keep every task either teacher gave, and join
two only when they close the same gap of the same question, with the citations of both. Never leave
one out because the other teacher did not give it. Give each merged task the fields the teachers
use (question, gap, source_kind, title, details, why, citations, kind), and from: the ids of the
teachers' tasks it holds (reviews[].portfolio[].id). Code adds back any teacher's task that no
merged one holds. ${MEASURES_NOTHING} Then merge their rules into one directive set for the
planner, only where they rest on evidence: keep what both support. Use only these fields: kind
(avoid, try, mandate, priority, lane_count, note), family (a kind of task: explore, primary,
contradict or consolidate), value (a question's index, for a try or mandate that puts it first),
rationale, citations. At most 3 notes. A rule may never freeze the queue's size or pin a task: code
refuses it. Never set verdicts. Merge their moves of queued tasks into one list, without repeats,
each with its why. The teachers keep their own field notes; write yours only for what merging
taught you. ${BRIEF_GUIDE}

${ADVISOR_NOTES}`;

/**
 * The merged by model's prompt (goal 166): its text, the teachers' brief cut to what its window
 * leaves beside their reviews, then the reviews whole.
 */
export function renderMergedBy(i: TeacherInput & { reviews: unknown }, f: AdvisorFrame): Prompt {
  const reviews = JSON.stringify(i.reviews);
  const fit = i.fit === undefined ? undefined : Math.max(0, i.fit - reviews.length);
  return advisorPromptOf(
    i.research ? "research-merged-by" : "merged-by",
    [section("system", "role", i.research ? RESEARCH_MERGED_BY_SYSTEM : MERGED_BY_SYSTEM)],
    [
      section("brief", "package", advisorPackage(briefHead(i), i.brief, 120_000, fit)),
      section("reviews", "package", `Reviews:\n${reviews}`, "\n\n"),
    ],
    f,
    i.addition,
  );
}
