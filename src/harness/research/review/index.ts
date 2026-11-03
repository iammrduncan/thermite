/**
 * A research run's reviews (goals 112 and 117). The run's items are its questions, each with its
 * answer card, and its required hypotheses (the author's and promoted ones). After the run's
 * minimum running time, at a digest, code asks the supervisor's review panel when every question
 * has an answer card, no review of the run waits, and some item has no standing decision: a
 * question whose newest card is newer than its decision, or a required hypothesis with no
 * decision. The package has every question's newest card with the claims it cites, every required
 * hypothesis with its supporting claims, each item's standing decision, which items to decide,
 * and the run's figures; nothing about which lane or model wrote what.
 *
 * Each reviewer answers each item to decide: a question `answered` (certainty high, moderate or
 * low), `insufficient` (the best answer sources allow; what is missing only a measurement could
 * settle, named as next experiments) or `open` (evidence gaps, named); a hypothesis `supported`,
 * `refuted` or `undecided`. Code checks each answer as it checks a finding. Each item's decision is
 * the verdict that more than half of the reviewers whose answer passed the check gave (a
 * question's certainty: the median of theirs); no such majority, or no answer that passed, is
 * `open` (a hypothesis: `undecided`). The others' verdicts are kept as the decision's dissent. A decision
 * stands until the question's card has a newer version (progress.ts). The review passes when,
 * after it, every question has an end (answered or insufficient) and every required hypothesis
 * one (an undecided with no claim for or against it is none: hypothesis-evidence.ts).
 *
 * A research review is a row of the review table with the reserved goal name `research` (a
 * research contract has no goals) and, in place of a commit, a marker of the items it saw (each
 * question's card version and the required hypotheses): the table's unique index then keeps the
 * run from being asked twice on the same items.
 *
 * The parts are in review/: the run's reviews and items (items.ts), its end (end.ts), whether a
 * review is due (due.ts), the package (package.ts), each reviewer's answers checked by code
 * (checks.ts), the panel's decisions (decide.ts), the workers' brief (brief.ts) and the reports'
 * lines and sections (report.ts); shared.ts holds what they share.
 */

/** A reviewer's verdicts on the wire (their home: core/api/harness/research.ts). */
export { ResearchVerdicts } from "../../../core/api/harness/research.ts";
export { ANSWERED, PROGRESS_STOPPED, RESEARCH_REVIEW } from "../../../core/research-check.ts";
export { briefGaps } from "./brief.ts";
export {
  type CheckedHypothesis,
  type CheckedQuestion,
  type CheckedReviewer,
  checkedPanel,
  checkResearchPanel,
  reviewerGaps,
} from "./checks.ts";
export {
  DISSENT_REASONS,
  type Dissent,
  decideItems,
  decisionWords,
  ITEM_REASONS_EVENT,
  ITEM_REASONS_MAX,
  type ItemDecision,
  medianCertainty,
  questionReasons,
} from "./decide.ts";
export { researchReviewDue } from "./due.ts";
export { type ResearchEnd, researchEnd } from "./end.ts";
export {
  acceptedReview,
  itemsMarker,
  itemsState,
  requiredHypotheses,
  researchReviews,
  waitingReview,
} from "./items.ts";
export {
  type ClaimRow,
  PACKAGE_QUOTE_MAX,
  PACKAGE_QUOTES,
  type PackageClaim,
  type PackageHypothesis,
  type PackageQuestion,
  type PackageStanding,
  RESEARCH_CRITERIA,
  RESEARCH_PACKAGE_MAX,
  type ResearchPackage,
  researchPackage,
  verifiedClaims,
} from "./package.ts";
export { answerSections, checkLine } from "./report.ts";
