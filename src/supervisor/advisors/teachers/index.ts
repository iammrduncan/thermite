/**
 * The teachers: a run's round of one or two independent reviews, which give opportunities for its
 * queue and rules for its lanes (round.ts), and the shapes of their answers (answers.ts).
 */

export {
  DirectiveSet,
  Opportunity,
  opportunityExperiment,
  type ProposedExperiment,
  ResearchOpportunity,
  researchOpportunityExperiment,
  TeacherReview,
} from "./answers.ts";
export { type TeacherRun, teacherRound } from "./round.ts";
