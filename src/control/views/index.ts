/**
 * Control's read model: what the dashboard, the API and MCP show. It is computed from the
 * events rigs reported (the harness ledger is the source of truth; control only mirrors it),
 * so it is the same after any restart of control, a supervisor or a harness.
 *
 * Its parts are in views/: the view's types, the fold of a rig's events (fold/, one module for
 * each area of events), the read of a rig's view (rig.ts) with what the rig's report says
 * (report.ts), the folds control keeps up to date as the events stream's apply hands them its
 * events, and a run's view wherever it ran (cache.ts), control's reads of the events stream
 * (stream.ts), and the views made from rigs' views: the leaderboard, the campaigns and a run's
 * directions.
 */

export { agentEvent, agentRun, readerRun, withoutPromptText } from "./agent.ts";
export {
  campaignRuns,
  closedRuns,
  EARLIER_FOLDS,
  FoldCache,
  findRun,
  findRunOn,
  keepFolds,
  rigChecks,
  rigEventsPage,
  rigView,
  rigViews,
  runEvents,
  runMessages,
} from "./cache.ts";
export { type CampaignView, campaignModes, campaignViews, newestRun } from "./campaigns.ts";
export { runDirections } from "./directions.ts";
export { championsInForce, currentChampion, runCampaign } from "./facts.ts";
export type { RigCheckView } from "./fold/index.ts";
export { type LeaderEntry, leaderboard } from "./leaderboard.ts";
export type { MetricValues } from "./metric-values.ts";
export {
  championValues,
  championWords,
  figure,
  pairWords,
  valuesByCase,
  valuesWords,
} from "./metric-values.ts";
export {
  OFFLINE_AFTER_MS,
  type ReportingState,
  type RigModelView,
  readModelInfo,
  reportingState,
  rigSettingsOf,
} from "./report.ts";
export {
  type HypothesisView,
  type ItemDecisionView,
  questionKey,
  questionYield,
  type ReviewItemView,
  recentShares,
  type StandingView,
  type TaskYieldView,
} from "./research.ts";
export { podStopped } from "./rig.ts";
export type { EventBus, RawEvent, StreamEvent } from "./stream.ts";
export { streamEvent } from "./stream.ts";
export type {
  AttemptView,
  BaselineView,
  CardView,
  ChampionHeldOutView,
  ChampionStep,
  DirectionView,
  Earlier,
  ExperimentView,
  HeldOutView,
  InvalidationView,
  JournalNoteView,
  JudgeJob,
  MessageView,
  RigView,
  RunOnRig,
  RunView,
  SetupView,
  StoredEvent,
} from "./types.ts";
export { diskOf, type OpenTrial, type RigDiskView, workOf } from "./work.ts";
