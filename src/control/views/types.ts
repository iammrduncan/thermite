import type { Hardware } from "../../core/hardware.ts";
import type { RigSettings } from "../../core/rig-settings.ts";
import type { RunpodRigView } from "../runpod/index.ts";
import type { RigVersions } from "../versions.ts";
import type { GoalChecks, GoalValues, RigCheckView } from "./fold/index.ts";
import type { MetricValues } from "./metric-values.ts";
import type { ReportingState, RigModelView } from "./report.ts";
import type {
  HypothesisView,
  ItemDecisionView,
  ProgressView,
  ReviewFigures,
  StandingView,
  TaskYieldView,
} from "./research.ts";
import type { TrialDoing } from "./work.ts";

/**
 * What a rig's view holds, as the dashboard, the API and MCP read it: the rig, its runs with
 * their attempts, champions, research, queue, rules and messages, the judge's jobs, and the
 * events they come from.
 */

/** An event a rig reported, as control keeps it; `seq` is its place in the events stream. */
export interface StoredEvent {
  seq: number;
  ledger_id: string;
  id: number;
  at: string;
  actor: string;
  kind: string;
  subject: string | null;
  body: Record<string, unknown>;
}

/** A rig as control shows it: its report, runs, judge's jobs, checks and newest events. */
export interface RigView {
  id: string;
  last_seen: string;
  /** True when the rig is stale or offline. */
  stale: boolean;
  state: ReportingState;
  /** The rig's builds against control's: behind or ahead, refused and why, or unknown. */
  version: RigVersions;
  ledger_id: string | null;
  summary: unknown;
  /** The supervisor's own figures (git sync, advisors); reported by the supervisor, unsigned. */
  supervisor: Record<string, unknown> | null;
  /** What the rig runs on, from its signed report (harnesses before it was added send none). */
  hardware: Hardware | null;
  jobs: Record<string, number>;
  runs: RunView[];
  recent: StoredEvent[];
  /** The judge: its job in progress, its queue and its recent jobs (newest last). */
  judge: { now: JudgeJob | null; queued: JudgeJob[]; jobs: JudgeJob[] };
  /** Each rig check's latest result (model route, isolation, smoke), or that it is running. */
  checks: Record<string, RigCheckView>;
  /** Which model route its agents use, from its signed report (older harnesses send none). */
  model: RigModelView | null;
  /** The rig's own settings (Edit rig), from its signed report; null from an older harness. */
  settings: RigSettings | null;
  /** A rig whose GPU split control may change (its GPU set and the judge's share now). */
  gpu_split: { set: number; judge: number } | null;
  /** A rig the owner launched on a GPU cloud: its pod, its price and what it has cost so far. */
  runpod?: RunpodRigView | undefined;
}

/**
 * Why a run is an earlier one (goal 170): its rig was retired, or it ran before its rig's full
 * reset. Control keeps its events; the run takes no more commands.
 */
export type Earlier = "retired" | "reset";

/**
 * A run with the view of the rig it ran on, as of the ledger it ran in: the rig's own view for its
 * current ledger, else a view of that ledger's events alone.
 */
export interface RunOnRig {
  rig: RigView;
  run: RunView;
  /** Null for a run of a rig's current ledger, the rig not retired. */
  earlier: Earlier | null;
}

export interface AttemptView {
  id: string;
  run: string;
  lane: string | null;
  lifecycle: string;
  verdict: string | null;
  delta: number | null;
  /** The main metric's values its latest verdict's gain comes from (goal 133). */
  values: MetricValues | null;
  hypothesis: string | null;
  recorded_at: string;
  updated_at: string;
  /** The commit it proposes, and the commit it was made on. */
  commit: string | null;
  parent: string | null;
  /** Flaws its author declared when submitting it (they trigger an audit). */
  known_flaws: string[];
  /** The planner's direction for the trial that made it. */
  family: string | null;
  trial: string | null;
  /** Goal campaigns: what the judge's latest finished job found against the champion. */
  gained: string[] | null;
  lost: string[];
  unsure: string[];
  /** Every verdict it received, oldest first. */
  history: { at: string; verdict: string; delta: number | null }[];
  /** What it waits for after its last job: "audit" or "owner_approval". */
  waiting: string | null;
  /** Its latest verdict's interval (relative gain, low and high) and the judge's reasons. */
  ci: [number, number] | null;
  reasons: string | null;
  /** The files it changes, with their line counts (null for a binary file), and how many. */
  files: { path: string; added: number | null; removed: number | null }[];
  files_total: number;
  /**
   * Why the static checks refused it before building (goal 082): the first 20 violations, each
   * cut to 300 characters, and how many there were. Empty, and 0, when it was not refused or its
   * rig's harness is older.
   */
  violations: string[];
  violations_total: number;
  /**
   * Its newest confirmation's held-out check, for the owner (goal 082): whether every held-out
   * cell passed, and each cell's name, kind of failure and value against its threshold. Null when
   * no held-out check ran, or its rig's harness is older.
   */
  held_out: HeldOutView | null;
}

/** One held-out check of an attempt, from the judge's `held_out_checked` event. */
export interface HeldOutView {
  at: string;
  pass: boolean;
  cells: {
    cell: string;
    goal: string | null;
    verifier: string | null;
    ok: boolean;
    kind: string | null;
    value: number | null;
    low: number | null;
    high: number | null;
    threshold: number | null;
    op: string | null;
    measure: string | null;
    unit: string | null;
  }[];
  /** How many cells the check had; the event names at most 50. */
  cells_total: number;
}

/** A held-out check of a goal run's champion (goal 086), from the judge's event. */
export type ChampionHeldOutView = HeldOutView & { champion_seq: number };

/** A judge job, from its queued, leased and finished events. */
export interface JudgeJob {
  id: string;
  kind: string;
  attempt: string | null;
  /** The run it serves (an attempt's run, or the run that was running when it was queued). */
  run: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  state: string | null;
  result: Record<string, unknown>;
}

export interface ChampionStep {
  seq: number;
  attempt: string | null;
  commit: string;
  at: string;
  /** Step gain from the confirming verdict (a fraction), when known. */
  delta: number | null;
  /**
   * Product of step gains since the run's starting point: the relative gain against it. A setup
   * change that became the starting point (goal 115) starts it again at 1.
   */
  cumulative: number;
  reopened: boolean;
  /** A setup change the judge could measure: the run's starting point from here (goal 115). */
  setup?: boolean | undefined;
}

/**
 * The owner withdrew evidence in a run (goal 174), from the rig's `invalidation` event: its subject
 * (an attempt, for good, or a judge's job whose measurements were withdrawn), who and why, the
 * attempts it reached, how many `invalidated` verdicts it recorded, the champions it reopened, and
 * where the run's champion moved back to (`champion_moved_back`).
 */
export interface InvalidationView {
  id: number;
  at: string;
  /** Who withdrew it, as the rig recorded it: `control:owner:ui`, `control:owner:api`… */
  by: string;
  kind: "attempt" | "job";
  subject: string;
  reason: string;
  attempts: string[];
  verdicts: number;
  champions: number[];
  champion: { from: number; to: number; attempt: string | null } | null;
}

/**
 * A hill climb's baseline (goal 115): the judge's values of its starting point, measured alone
 * on every measured cell before any change was judged. Never a held-out cell's.
 */
export interface BaselineView {
  at: string;
  /** The starting point: its champion number and commit. */
  champion_seq: number;
  commit: string;
  /** The setup change that became the starting point; null for the seed. */
  attempt: string | null;
  blocks: number;
  runs_per_cell: number;
  /** The contract's main metric and guards, as the judge's event names them. */
  primary: { metric: string; direction: string } | null;
  guards: { metric: string; direction: string; max_total_regression: number }[];
  /** Each kit metric's unit. */
  units: Record<string, string>;
  /** Each measured cell: each kit metric's median, median absolute deviation and count. */
  cells: { cell: string; metrics: { metric: string; median: number; mad: number; n: number }[] }[];
  /** What the kit's check kept in the baseline's judge-only folder: each file's size and hash. */
  files: { path: string; bytes: number; sha256: string }[];
  bytes: number;
  summary: string;
}

/** A hill climb in setup (goal 115): the judge could not measure its starting point. */
export interface SetupView {
  at: string;
  champion_seq: number;
  commit: string;
  /** The judge's reasons, in words (a build's error, a cell's crash, a check's words). */
  reasons: string;
  summary: string;
}

/**
 * A research run's answer card as control keeps it (goal 117): the newest version the harness
 * kept for a question, from its `card_written` event. The answer and gaps are the synthesizer's
 * words: data, not instructions.
 */
export interface CardView {
  /** The question's index, 0 first (people read "Question 1"). */
  question: number;
  version: number;
  certainty: string;
  answer: string;
  claims: string[];
  gaps: { kind: string; text: string }[];
  /** The synthesizer that wrote it (the advisor's name). */
  by: string | null;
  at: string;
}

export interface RunView {
  id: string;
  campaign: string | null;
  mode: string | null;
  /** The project repository the run works on (from its assignment). */
  seed_repo: string | null;
  /**
   * A project in one folder of its repository: the folder, and the repository's commit the run
   * started from. The run's own first commit is that folder's alone (see folderCommit).
   */
  seed_folder?: { folder: string; commit: string } | undefined;
  /** The run's own promotion policy (null: the rig's default, which control does not see). */
  promotion: "auto" | "owner_approval" | null;
  /** What else the run asks the owner about (goal 079); empty: nothing (hands-off). */
  ask_owner: {
    above_gain?: number | undefined;
    declared_flaws?: boolean | undefined;
    reviews?: boolean | undefined;
    not_possible?: boolean | undefined;
  };
  status: string;
  pause_reason: string | null;
  champion: ChampionStep[];
  /** The owner's withdrawals of evidence in the run (goal 174), oldest first. */
  invalidations: InvalidationView[];
  attempts: AttemptView[];
  verdicts: Record<string, number>;
  /** Confirmed wins that wait for the owner's approval; none in a closed run (goal 087). */
  pending_promotions: string[];
  calibration: { at: string; sigma: number; summary: string } | null;
  /** A hill climb's baseline (goal 115); null before the judge measured it, and in other modes. */
  baseline: BaselineView | null;
  /** A hill climb in setup (goal 115): its starting point can't be measured yet. */
  setup: SetupView | null;
  /** A hill climb waits for its baseline (goal 115): no round or trial starts until it has one. */
  baseline_waiting: boolean;
  /** Agents (M4): planner quality, duplicates, effort. */
  agents: {
    epochs: number;
    planner_valid: number;
    /** Rounds the fixed rules planned because the planner gave no usable plan (or was off). */
    fallbacks: number;
    /** A research run's rounds: planned by the research plan, never by the planner (goal 079). */
    research_rounds: number;
    epochs_with_violations: number;
    trials: number;
    submitted: number;
    tokens_in: number;
    tokens_out: number;
    duplicates: number;
    attempts: number;
  };
  /**
   * The run's agents stopped (goal 079): the provider refused (no credits, a refused key, an
   * unserved model) or the workers' model check fails. Null while they can run.
   */
  agents_stopped: {
    kind: string;
    /** The provider's or the check's own words. */
    words: string;
    /** The kind in plain words. */
    said: string;
    /** What found it: a trial, the model check. */
    by: string;
    since: string;
  } | null;
  /** Research mode: the newest digest's figures and report. */
  research: Record<string, unknown> | null;
  /**
   * A research run's answer cards (goal 117): each question's newest card the harness kept, by
   * question index (0 first), from its `card_written` events. Empty until the synthesizer writes
   * one, and in other modes.
   */
  cards: CardView[];
  /**
   * The newest refused card of each question since its card (goal 117), with the harness's
   * problems (the first 5, short): the synthesizer writes it again at its next round.
   */
  card_refusals: { question: number; at: string; by: string | null; problems: string[] }[];
  /**
   * A research run's hypotheses (goal 117), oldest first: the author's, the pool's, promoted,
   * merged and retired ones, with their questions and the newest change of their status.
   */
  hypotheses: HypothesisView[];
  /** The review panel's decision on each item in each review (goal 117), oldest first. */
  decisions: ItemDecisionView[];
  /**
   * Each item's newest decision (goal 117), and whether it stands: a question's stands until its
   * card has a newer version than the one decided on.
   */
  standing: StandingView[];
  /** The progress rule's state at the newest digest (goal 117); null until a harness sends one. */
  progress: ProgressView | null;
  goals: {
    goal: string;
    description: string | null;
    status: string;
    reasons: string;
    /**
     * A code verifier's goal (goal 086): each public cell's values as the judge measured them, met
     * or not; null for another goal, or a report from an older harness. Never a held-out cell's.
     */
    values: GoalValues[] | null;
  }[];
  /** When the judge last checked the goals, and on which champion. */
  goals_at: string | null;
  goals_seq: number | null;
  /**
   * The judge's check of the champion found every required goal met, and its second, confirming
   * check is still to come (goal 086): the run's lanes start no new trial until it is done.
   */
  goals_confirming: boolean;
  /**
   * The newest goal report found the goals met for good: every required goal (or the k of n the
   * contract asks for) met, and confirmed by the judge's second check (goal 086). A closed goal
   * run with it reads Completed on the dashboard (goal 099).
   */
  goals_complete: boolean;
  /**
   * The newest held-out check of the run's champion, for the owner (goal 086): the second
   * validation of a champion that met every required goal runs the held-out cells of the goals
   * met. As an attempt's `held_out`, with the champion it checked. Null when none ran.
   */
  champion_held_out: ChampionHeldOutView | null;
  /**
   * How each goal is really checked, as the rig's kit runs it (goal 082): from the rig's
   * `goal_checks` event when the run started. Null for a run an older harness started.
   */
  goal_checks: GoalChecks | null;
  /** Audits (M5): what is held for one, and how each ended. */
  audits: {
    attempt: string;
    reason: string;
    decision: string | null;
    at: string;
    /** The champion the attempt was measured against. */
    expected_seq: number | null;
    /** The auditor's reasons, once it decided. */
    reasons: string | null;
  }[];
  /** Why each pending promotion waits, and against which champion it was measured. */
  promotion_waits: Record<
    string,
    { expected_seq: number | null; reason: string | null; at: string }
  >;
  /**
   * Subjective-goal reviews: the panel's result, then the owner's. A research run's reviews (goal
   * 112) have the goal `research`; `gaps` holds what its reviewers found missing, short, and
   * `answers` each question's first answer that passed the harness's check, short (questions
   * numbered from 0); both null until the review panel decided, and for a goal's review. Each
   * also has its times and figures (goal 116): when it was asked and posted, what it saw, each
   * reviewer's answers per item and the panel's decision per item (goal 117).
   */
  reviews: ({
    review: number;
    goal: string;
    commit: string;
    panel: string | null;
    owner: string | null;
    gaps: string[] | null;
    answers: { question: number; answer: string }[] | null;
  } & ReviewFigures)[];
  /**
   * A research run's paper (goal 112): asked of the supervisor's final writer once the review
   * panel's pass was accepted (`writing`), with the newest refusal of a draft while it is still
   * written, then accepted (`in`), with the paper itself. Null until it is asked for.
   */
  paper: {
    state: "writing" | "in";
    requested_at: string;
    refused: { at: string; problems: string[] } | null;
    at: string | null;
    writer: string | null;
    ste_checked: boolean | null;
    experiments: number;
    /** Its next experiments by the run each is for (goal 119); both 0 for a paper that tagged none. */
    next_for: { hill_climb: number; goal: number };
    /** The paper, with the references the harness appended, as its event carries it. */
    text: string | null;
  } | null;
  /** "Not possible" proposals and the owner's decisions. */
  conclusions: {
    proposal: number;
    decision: string | null;
    approaches: number;
    at: string;
    /** The refuted approach families, each with its judged attempts. */
    families: { family: string; attempts: number }[];
  }[];
  /** The newest champion published for propagation (what another rig can import). */
  published: {
    seq: number;
    repo: string | null;
    base_commit: string;
    tree: string;
    sha256: string;
    path: string;
  } | null;
  /** Every champion tree this run published, by seq (cross-verification checks it). */
  published_trees: Record<number, string>;
  /**
   * Every champion this run published, oldest first: its seq, and its patch's SHA-256, base commit
   * and repository. Control keeps a champion's patch only if its SHA-256 is the newest one here
   * for its seq.
   */
  published_patches: {
    seq: number;
    sha256: string;
    base_commit: string;
    repo: string | null;
    path: string;
  }[];
  /** Champions received from other rigs, and how this rig's judge decided them. */
  propagations: {
    attempt: string | null;
    source_rig: string;
    source_run: string;
    source_seq: number;
    tree: string | null;
    result: string;
  }[];
  directives: number;
  /** When the run started, and its latest epoch's plan. */
  created_at: string | null;
  epoch: {
    n: number;
    at: string;
    source: string;
    assignments: { lane: string; family: string; parent: string; focus: string | null }[];
  } | null;
  /** When each of its rounds started, oldest first: a run page's model calls in each round. */
  round_starts: string[];
  /** Finished trials, newest last (at most the latest 100). */
  trials: {
    trial: string;
    lane: string | null;
    family: string | null;
    attempt: string | null;
    stopped: string;
    error: string | null;
    at: string;
  }[];
  /**
   * Each lane's trial in progress: its direction, its focus and when it started; with a harness
   * from goal 143, what it is doing (when it last sent a line, its open model call, a streak of
   * the same calls), from the rig's last report.
   */
  at_work: Record<
    string,
    {
      trial: string;
      family: string | null;
      focus: string | null;
      since: string;
    } & Partial<TrialDoing>
  >;
  /** The run's events, oldest first (at most the latest 400): the timeline's source. */
  timeline: StoredEvent[];
  /** False for a run with no worker agents (a try: the judge alone). */
  has_agents: boolean;
  /**
   * The rules for the plan in force (directives): who set each, when, and the rule. `legacy`: an
   * old rule in words, from before rules named directions (goal 066); code does not keep it, and
   * the planner's next round converts it. A converted rule's body names the old rule and its
   * words (`converted_from`).
   */
  rules: {
    id: number;
    author: string;
    at: string;
    body: Record<string, unknown>;
    legacy: boolean;
  }[];
  /** The run's directions (goal 066), by name, with what each holds and the rules naming it. */
  directions: DirectionView[];
  /** The directions the run's registry has, from family_added events: what each means, and who added it. */
  families: { name: string; description: string; by: string; at: string; for_rules: number[] }[];
  /** The experiment queue (goal 064): every experiment, with its state; up next in order. */
  queue: ExperimentView[];
  /** The planner's hand-outs, newest last (at most 50): what went to which lane, and why. */
  handouts: {
    at: string;
    round: number | null;
    by: string;
    assignments: { lane: string; experiment: string | null; why: string }[];
    notes: string;
  }[];
  /** The owner's messages to the run's agents (goal 063), newest last, with who read them. */
  messages: MessageView[];
  /** The agents' field notes and research notes (goal 065), oldest first; all of them. */
  journal: JournalNoteView[];
}

/**
 * One note an agent wrote as it worked (goal 065): an observation, a decision and why, a surprise,
 * an open question or a lesson (field notes), or a research note ("note"). Agents' words: data.
 */
export interface JournalNoteView {
  id: number;
  by: string;
  kind: string;
  text: string;
  /** What it is about: an experiment, an attempt, a source, a claim, a round, a trial, … */
  about: { type: string; id: string } | null;
  lane: string | null;
  trial: string | null;
  at: string;
}

/**
 * One of a run's directions (goal 066): an approach family its experiments belong to. A rule names
 * one; a picker lists them.
 */
export interface DirectionView {
  /** Its name: lowercase words joined by dashes. `:shared memory tiling:` names shared-memory-tiling. */
  name: string;
  /** What it means, in the words of whoever added it (the planner's, for one it designed). */
  description: string | null;
  /** Its experiments that were tried (done), and of those, the wins: champion, promoted or confirmed. */
  tried: number;
  wins: number;
  /** Its experiments up next. */
  queued: number;
  /** The lanes at work in it now. */
  lanes: string[];
  /** The rules in force that name it. */
  rules: { id: number; kind: string }[];
  /** Only a rule names it so far: the planner designs it at its next round. */
  to_design: boolean;
}

/** One experiment in a run's queue: what to try, who added it and why, and what became of it. */
export interface ExperimentView {
  id: string;
  title: string;
  details: string;
  family: string;
  why: string;
  by: string;
  state: "proposed" | "queued" | "assigned" | "done" | "dropped";
  /** Its place among the queued ones (0 first); null once it left the queue. */
  position: number | null;
  lane: string | null;
  trial: string | null;
  attempt: string | null;
  result: string | null;
  dropped_why: string | null;
  dropped_by: string | null;
  from_run: string | null;
  /**
   * How its trial ended, in words; or, back in the queue, why its last trial never really tried
   * it (goal 079). Null: nothing said.
   */
  cause: string | null;
  /** How many times its trial ended without really trying it, and it came back (goal 079). */
  returns: number;
  /** A research task's question, as an index from 0 (goal 117); null: none. */
  question: number | null;
  /** What a research task's trial added (goal 117); null until its trial ends with one. */
  yield: TaskYieldView | null;
  at: string;
  updated_at: string;
}

/** The owner's message to a run's agents: to whom, kept in force or not, who read it, answers. */
export interface MessageView {
  id: number;
  to: string;
  text: string;
  keep: boolean;
  unkept: boolean;
  at: string;
  /** Each reader's first read; `round` is the planner's round that read it (goal 066). */
  reads: { by: string; trial: string | null; at: string; round: number | null }[];
  /** Each advisor's answer: its role, and the advisor by name when the supervisor says. */
  answers: { role: string; text: string; at: string; advisor?: string | undefined }[];
  /**
   * The rules the planner made from it (goal 066): each directive whose `from_message` is this
   * message, in force or removed since, with its direction and why.
   */
  rules: {
    id: number;
    kind: string;
    family: string | null;
    rationale: string;
    by: string;
    at: string;
  }[];
  /**
   * Rules the planner made from it that the harness left out: rules the owner removed, which
   * only the owner's own `redirect` sets again (`directives_left_out`).
   */
  left_out: { kind: string; family: string | null; at: string }[];
}
