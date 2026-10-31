/**
 * A research run's records and the rules over them: answer cards (cards.ts), the research folder
 * (folder.ts), the checks research text shares (checks.ts), where each question and hypothesis
 * stands (shares.ts, progress.ts, hypothesis-evidence.ts), fetches refused for good
 * (refusals.ts), the time the agents could not work (blocked.ts), and what the tools tell a worker
 * (worker-words.ts); with the research service (research/), the review panel (review/) and the
 * paper (paper/).
 */

export {
  briefCards,
  type CardResult,
  Cards,
  cardFile,
  cardHistory,
  cardsOf,
  questionLabel,
} from "./cards.ts";
export { foldText } from "./checks.ts";
export {
  cardPath,
  folderRootOf,
  ResearchFolder,
  readNoFollow,
  SAVED_LANES_DIR,
  sectionPath,
} from "./folder.ts";
export { hypothesisTask } from "./hypothesis-evidence.ts";
export { type PaperPackage, Papers } from "./paper/index.ts";
export { lastImprovement, progressStopped, questionSaturated } from "./progress.ts";
export {
  NOTE_REPEATS,
  Research,
  setHypothesisStatus,
  startingHypotheses,
} from "./research/index.ts";
export {
  briefGaps,
  type CheckedReviewer,
  checkResearchPanel,
  decideItems,
  decisionWords,
  ITEM_REASONS_EVENT,
  ITEM_REASONS_MAX,
  type ItemDecision,
  itemsState,
  questionReasons,
  RESEARCH_REVIEW,
  type ResearchEnd,
  type ResearchPackage,
  type ResearchVerdicts,
  researchEnd,
  researchPackage,
  researchReviewDue,
  reviewerGaps,
  waitingReview,
} from "./review/index.ts";
export {
  gapOf,
  nextGap,
  nextQuestion,
  type QuestionState,
  questionDetails,
  type ResearchState,
  researchState,
  stateBrief,
  stateWords,
  taskDetails,
  took,
} from "./shares.ts";
