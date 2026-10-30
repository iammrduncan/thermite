import type { AdvisorRole, Harness, MessageHow } from "../agents.ts";
import type { Mode } from "../contract.ts";
import type { GoalCellValues, GoalCheck } from "../goal/index.ts";
import type { HeldOutCell } from "../held-out.ts";
import type { KbItemBody } from "../kb.ts";
import type { AgentPromptBody } from "../prompts.ts";
import type { RigSettings } from "../rig-settings.ts";
import type { TerminalOutcome } from "../terminal-input.ts";
import type { EventKind } from "./kinds.ts";

/**
 * Each event kind's body, as a ledger records it (goal 125, T1): the writer must give this shape,
 * and the compiler checks it (the owner's answer to the guide's question 5: compile time first,
 * control's intake later). A field whose shape only the harness defines yet, such as a baseline's
 * cells or a review's items, is `unknown` here until its words move to core.
 */
export interface EventBodies {
  // ---------------------------------------------------------------- runs and contracts
  contract_stored: { version: number; sha: string; mode: Mode };
  run_created: {
    campaign: string;
    version: number;
    mode: Mode;
    seed: { repo: string; commit: string; folder?: string | undefined; source_commit?: string };
    direction: string | null;
    agents: boolean;
    promotion: "auto" | "owner_approval" | null;
    ask_owner?:
      | {
          above_gain?: number | undefined;
          declared_flaws?: boolean | undefined;
          reviews?: boolean | undefined;
          not_possible?: boolean | undefined;
        }
      | undefined;
    briefing?: number | undefined;
    agents_context?: { context_window?: number | undefined; compact_at?: number } | undefined;
  };
  run_status: { status: "closed" | "paused" | "running"; reason: string | null };
  import_verified: { name: string | null; sha256: string | null; commit: string | null };
  export_written: { through_event: number; path: string };
  wipe_requested: { export: string };

  // ---------------------------------------------------------------- commands
  command: { kind: string; accepted: boolean; result: unknown };
  command_rejected: { reason: string; kind: string | null; id: string | null };

  // ---------------------------------------------------------------- attempts and the judge
  attempt_recorded: {
    run: string;
    lane: string | null;
    lifecycle: string;
    commit: string;
    parent: string;
    hypothesis: string | null;
    known_flaws: string[];
    files?: { path: string; added: number | null; removed: number | null }[] | undefined;
    files_total?: number | undefined;
    violations?: string[] | undefined;
    violations_total?: number | undefined;
  };
  attempt_lifecycle: { lifecycle: string };
  submission_refused: { lane: string | null; parent: string; diff_sha: string; reason: string };
  build_recorded: { commit: string; kit_commit: string; ok: boolean };
  job_queued: { attempt: string | null; kind: string; run?: string | undefined };
  job_leased: { fence: number; until: string };
  job_finished: { state: "done" | "failed"; result: unknown };
  job_lease_expired: JobRequeued;
  crash_infra: JobRequeued;
  job_unblocked: { expiries: number; reason: string };
  verdict: {
    id: number;
    verdict: string;
    delta: number | null;
    ci_low: number | null;
    ci_high: number | null;
    reasons: string;
    supersedes: number | null;
    values?: unknown;
  };
  /**
   * The owner withdrew evidence (goal 174): the invalidation's id, its subject, the attempts it
   * reached, the `invalidated` verdicts it recorded and the champions it reopened.
   */
  invalidation: {
    id?: number | undefined;
    run?: string | null | undefined;
    kind: "attempt" | "job";
    reason: string;
    attempts: string[];
    verdicts?: number[] | undefined;
    champions?: number[] | undefined;
  };
  /** A job cancelled before it ran or while it ran: its attempt's evidence was withdrawn. */
  job_cancelled: {
    run: string | null;
    attempt: string | null;
    kind: string;
    was: string;
    reason: string;
    invalidation?: number | undefined;
  };
  baseline: {
    run: string;
    job: number;
    commit: string;
    attempt: string | null;
    blocks: number;
    runs_per_cell: number;
    primary: { metric: string; direction: "max" | "min" };
    guards: { metric: string; direction: "max" | "min"; max_total_regression: number }[];
    units: Record<string, string>;
    cells: Record<string, Record<string, unknown>>;
    files: unknown[];
    bytes: number;
    summary: string;
    champion_seq: number;
  };
  baseline_failed: {
    run: string;
    job: number;
    champion_seq: number;
    commit: string;
    reasons: string;
    summary: string;
  };
  calibration: {
    run: string;
    champion_seq: number;
    blocks: number;
    sigma: number;
    mean: number;
    ci: number[];
    summary: string;
    card?: string | undefined;
    card_index?: number | undefined;
  };
  held_out_checked: {
    run: string;
    job: number;
    champion_seq?: number | undefined;
    pass: boolean;
    cells: HeldOutCell[];
    cells_total: number;
  };
  parent_screened: {
    verdict: string;
    delta: number | null;
    champion_seq: number | null;
    effect: string;
  };
  goal_checks: {
    kit: { name: string; repo: string; commit: string } | null;
    run_command: string[] | null;
    timeout_s: number | null;
    goals: GoalCheck[];
  };
  goal_report: {
    run: string;
    champion_seq: number;
    goals: {
      goal: string;
      description: string | null;
      status: "met" | "unmet" | "inconclusive" | "not_runnable";
      reasons: string;
      values?: GoalCellValues[] | undefined;
    }[];
    complete: boolean;
    confirming?: boolean | undefined;
    not_confirmed?: string | undefined;
  };
  goal_complete: { champion_seq: number };
  lane_best: { lane: string; attempt: string | null; reason?: string | undefined };
  port_queued: { run: string; onto_seq: number; experiment: string; why: string };

  // ---------------------------------------------------------------- champions and promotion
  champion_promoted: { seq: number; attempt: string; commit: string; setup?: boolean };
  champion_published: {
    seq: number;
    repo: string | null;
    base_commit: string;
    tree: string;
    sha256: string;
    path: string;
    export: string;
  };
  champion_ref_failed: { seq: number; error: string };
  champion_reopened: { seq: number; attempt: string; reason: string };
  /** The run's champion moved back to the newest that stands, after an invalidation (goal 174). */
  champion_moved_back: {
    from: number;
    to: number;
    attempt: string | null;
    commit: string;
    invalidation: number;
    reason: string;
  };
  promotion_pending: { run: string; expected_seq: number; commit: unknown; reason: string };
  promotion_blocked: { reason: string };
  promotion_declined: { run: string; was: string; note?: string | undefined };
  flaws_accepted: { by: string | undefined };
  propagation_received: {
    source_rig: string;
    source_run: string;
    source_seq: number;
    tree: string;
    attempt: string | null;
    result?: string | undefined;
    lifecycle?: "duplicate" | "queued" | "rejected_v0" | "judged" | undefined;
  };
  propagation_accepted: PropagationJudged;
  propagation_rejected: PropagationJudged;

  // ---------------------------------------------------------------- advisors
  audit_requested: { audit: number; run: string; reason: string; expected_seq: number };
  audit_decided: { audit: number; decision: "clear" | "block" | "needs_owner"; reasons: string };
  audit_skipped: { audit?: number | undefined; run: string; reason: string; why: string };
  audit_overridden: { lifecycle: string };
  advisor_answer: {
    message: number;
    role: AdvisorRole;
    text: string;
    advisor?: string | undefined;
  };
  directive: { id: number; body: unknown };
  directive_converted: { id: number; to: number; kind: unknown; family: string; words: unknown };
  directive_dropped: { id: number };
  directives_superseded: { ids: number[] };
  directives_left_out: { rules: unknown[]; why: string; reason?: string | undefined };
  conclusion_proposed: {
    proposal: number;
    kind: string;
    approaches: { family: string; attempts: number }[];
  };
  conclusion_accepted: ConclusionDecided;
  conclusion_rejected: ConclusionDecided;
  review_requested: {
    review: number;
    goal: string;
    commit: string;
    questions?: number | undefined;
    hypotheses?: number | undefined;
    verified_claims?: number | undefined;
  };
  review_try_failed: { review: number; try: number; error: string };
  review_panel: {
    review: number;
    goal: unknown;
    result: string;
    reviewers: number;
    questions?: unknown[] | undefined;
    gaps?: string[] | undefined;
    more_gaps?: number | undefined;
    decided?: number | undefined;
    open?: number[] | undefined;
  };
  review_decided: { review: number; goal: unknown; decision: string; note?: string | undefined };
  review_items: { review: number; reviewer: string; items: unknown[] };
  item_decided: {
    review: number;
    kind: "hypothesis" | "question";
    key: string;
    card_version: number | null;
    decision: string;
    certainty: "high" | "low" | "moderate" | null;
    dissent: unknown[];
  };

  // ---------------------------------------------------------------- the agents' work
  epoch_started: {
    n: number;
    source: "fallback" | "planner";
    plan?: "research" | "setup" | undefined;
    notes?: string | undefined;
    planner_tries: number;
    planner_valid: boolean;
    raw_violations: number;
    refused?: string[] | undefined;
    causes?: { try: number; cause: string; detail: string }[] | undefined;
    directives: number[];
    assignments: {
      lane: string;
      family: string;
      focus: string;
      parent: "champion" | "lane_best";
      directive?: number | undefined;
      experiment?: string | undefined;
    }[];
  };
  epoch_ended: { n: number };
  fork_round: { epoch: number; round: number };
  planner_handout: {
    round: number;
    assignments: { lane: string; experiment: string; why: string }[];
    notes: string;
  };
  queue_low: {
    round: number;
    ready: number;
    target: number;
    lanes: number;
    source: "fallback" | "planner";
  };
  family_added: { family: string; description: string; for_rules?: number[] | undefined };
  family_status: { family: string; status: string; reason: string };
  experiment_added: {
    id: string;
    title: string;
    details?: string | undefined;
    family?: string | undefined;
    why?: string | undefined;
    question?: number | undefined;
    by: string;
    state: "proposed" | "queued";
    position?: QueuePosition | undefined;
    from_run?: string | undefined;
    from_id?: string | undefined;
    trial?: string | undefined;
    requeued_from?:
      | { experiment: string; trial: string; lane: string | null; result: "interrupted" | "error" }
      | undefined;
  };
  experiment_accepted: {
    id: string;
    by: string;
    position?: QueuePosition | undefined;
    why?: string | undefined;
  };
  experiment_moved: { id: string; by: string; position: QueuePosition; why?: string | undefined };
  experiment_edited: {
    id: string;
    by: string;
    title?: string | undefined;
    details?: string | undefined;
    family?: string | undefined;
    why?: string | undefined;
  };
  experiment_dropped: { id: string; by: string; why: string };
  experiment_assigned: { id: string; lane: string; trial: string; by: string; why?: string };
  experiment_finished: {
    id: string;
    lane: string | null;
    trial: string;
    attempt?: string | undefined;
    result: string;
    cause?: string | undefined;
    yield?: unknown;
  };
  experiment_returned: {
    id: string;
    lane: string | null;
    trial: string;
    result: string;
    cause: string;
    returns: number;
    position: string;
  };
  trial_started: {
    trial: string;
    lane: string;
    epoch: number;
    family: string;
    focus?: string | undefined;
  };
  trial_finished: {
    trial: string;
    lane: unknown;
    epoch: unknown;
    family: unknown;
    attempt: unknown;
    stopped: string;
    turns: number;
    tokens_in: number;
    tokens_out: number;
    compactions?: number | undefined;
    usage_unrecorded?: number | undefined;
    error: string | null;
  };
  trial_stop_asked: { trial: string; lane: string; reason?: string | undefined };
  trial_stopped: { lane: string; trial?: string | undefined; reason: string };
  trial_repeating: {
    trial: string;
    lane: string | null;
    count: number;
    different: number;
    calls: { call: string; times: number }[];
  };
  dev_run: {
    wall_ms: number;
    exit: number | null;
    killed: "timeout" | "memory" | "disk" | null;
    peak_rss_mib: number;
    command: string;
  };
  context_compacted: {
    trial: string | null;
    lane: string;
    harness: Harness;
    number: number;
    tokens_before: number | null;
    tokens_after: number | null;
    how: "summary" | "trimmed" | "harness";
    snapshot: string | null;
    bytes?: number | undefined;
    text?: string | undefined;
    clipped?: boolean | undefined;
    summary: string | null;
    error: string | null;
  };
  workers_reset: Record<string, never>;
  agents_stopped: { kind: string; words: string; by: string; said: string };
  agents_resumed: { why: string };
  agents_wait_for_limit: {
    until: string;
    trial: string;
    reason: string;
    in_trial?: boolean | undefined;
  };
  journal_note: {
    id: number;
    by: string;
    kind: string;
    text: string;
    about: { type: string; id: string };
    lane?: string | undefined;
    trial?: string | undefined;
  };
  agent_message: { id: number; to: string; keep: boolean; text: string; chars: number };
  agent_message_read: {
    message: number;
    by: string;
    trial?: string | undefined;
    round?: number | undefined;
    /** How a trial's agent was given it (goal 169). */
    how?: MessageHow | undefined;
  };
  agent_message_unkept: { message: number };
  /**
   * The owner's input to a trial's terminal (goal 169), word for word, and what became of it: one
   * when the command is applied, and one more when an input queued for a usage window's reset is
   * typed or dropped.
   */
  terminal_input: {
    command: string;
    trial: string;
    lane: string;
    text?: string | undefined;
    keys?: string[] | undefined;
    wait: "queue" | "now";
    outcome: TerminalOutcome;
    why?: string | undefined;
    until?: string | undefined;
  };
  /** A prompt a run's agent was sent (goal 166): its sections and sources (core/prompts.ts). */
  agent_prompt: AgentPromptBody;

  // ---------------------------------------------------------------- models and MCP servers
  model_call: {
    calls: number | null;
    at: string;
    tokens_in: number;
    cached_in: number | null;
    uncached_in: number | null;
    tokens_out: number;
    reasoning: number | null;
    first_token_ms: number | null;
    call_ms: number | null;
    trial: string | null;
    round: string | null;
    agent: string;
    harness: Harness;
    provider: string | null;
    model: string;
  };
  model_route_set: ModelRouteInfo;
  model_route_cleared: ModelRouteInfo;
  mcp_servers: {
    servers: {
      name: string;
      agents: McpAgents[];
      tools?: { workers?: string[]; planner?: string[]; advisors?: string[] } | undefined;
    }[];
  };
  mcp_servers_wait: {
    since?: string | undefined;
    waited_s: number;
    missing: { name: string; why: string }[];
  };
  mcp_server_failed: { server: string; agents: McpAgents; error: string };
  mcp_server_back: { server: string; agents: McpAgents };

  // ---------------------------------------------------------------- the rig
  rig_check_started: { id: string; check: string; force: boolean };
  rig_check_finished: {
    id: string;
    check: string;
    ok: boolean;
    summary: string;
    note?: string | undefined;
    detail?: string | Record<string, unknown> | undefined;
  };
  /** The rig's disk reached its floor, or has room again (goal 173). */
  rig_disk: {
    low: boolean;
    floor_gib: number;
    places: { name: string; free_gib: number; total_gib: number }[];
    reason?: string | undefined;
  };
  /**
   * A drain began, went on or ended; `deadline` is when it stops waiting by itself, and
   * `deadline_reached` marks the step at that time, which leaves the choice to the owner (goal 173).
   */
  rig_drain: {
    drain: boolean;
    reason?: string | undefined;
    trials?: number | undefined;
    judge_jobs?: number | undefined;
    draining?: unknown;
    deadline?: string | undefined;
    deadline_reached?: boolean | undefined;
  };
  rig_settings_changed: { change: Record<string, unknown>; settings: RigSettings };
  /**
   * The harness did not run from `since` to `until`: the host slept, its container was paused or
   * stopped, or it crashed. `restarted` when it found the gap as it started again. A research
   * run's clock leaves the gap out.
   */
  harness_gap: { since: string; until: string; restarted: boolean };

  // ---------------------------------------------------------------- research
  source_fetched: {
    source: string;
    domain: string;
    status: number;
    bytes: number;
    url: string;
    title: string | null;
    text: string;
  };
  fetch_refused: { url: string; reason: string; asked?: number | undefined };
  claim_added: {
    claim: string;
    verified: boolean;
    question: number | null;
    text: string;
    quote: string;
    sources: string[];
    problems: string[];
    more_problems?: number | undefined;
  };
  finding_added: {
    finding: string;
    supported: boolean;
    claims: number;
    statement: string;
    summary: string;
    why: string;
  };
  research_note: {
    note: number;
    by: string;
    text: string;
    sources: string[];
    url?: string | undefined;
    trial?: string | undefined;
  };
  research_doc: {
    lane: string;
    trial: string | null;
    path: string;
    change: string;
    bytes?: number | undefined;
    sha256?: string | undefined;
    text?: string | undefined;
    clipped?: boolean | undefined;
  };
  research_files_saved: { trial: string | null; written: number; removed: number; files: number };
  hypothesis_added: {
    hypothesis: string;
    lane: string | null;
    text: string;
    supporting: string[];
    from?: string | undefined;
    question: number | null;
    status: string;
  };
  hypothesis_revised: {
    hypothesis: string;
    lane: string | null;
    text: string;
    question: number | null;
    supporting: string[];
    status: string;
  };
  hypothesis_merged: {
    hypothesis: string;
    into: string;
    lane: string | null;
    text: string;
    question: number | null;
    supporting: string[];
  };
  hypothesis_status: {
    hypothesis: string;
    status: "pool" | "promoted" | "retired";
    from: string;
    by: string;
    reason: string;
    question: number | null;
    text: string;
  };
  card_written: {
    question: number;
    version: number;
    certainty: string;
    claims: number;
    gaps: number;
    by: string;
    through: string | null;
    answer: string;
    cited: string[];
    gap_list: { kind: string; text: string }[];
  };
  card_refused: { question: number; by: string; count: number; problems: string[] };
  research_digest: ResearchReport;
  research_final: ResearchReport;
  research_progress: {
    open: number[];
    saturated: number[];
    last_improvement: string | null;
    since_ms: number;
    needed_ms: number;
    stopped: boolean;
  };
  research_stopped: {
    saturated: number[];
    last_improvement: string | null;
    since_ms: number;
    needed_ms: number;
    reason: string;
    open: { questions: number[]; hypotheses: string[] };
  };
  research_paper_requested: { review: number; figures: unknown; end: string };
  /** One version of one item in its writer's slot of the knowledge base (core/kb.ts). */
  kb_item: KbItemBody;
  research_paper_refused: {
    review: number;
    writer: string;
    count: number;
    problems: string[];
    ste_checked: boolean;
  };
  research_paper_accepted: {
    review: number;
    writer: string;
    ste: unknown;
    cited_claims: number;
    citations: Record<string, number[]>;
    references: number;
    experiments: unknown[];
    chars: number;
    paper: string;
  };
}

/** A job put back in the queue, or blocked after too many expiries. */
interface JobRequeued {
  fence: number;
  expiries: number;
  state: string;
}

/** A champion from another rig, judged here. */
interface PropagationJudged {
  attempt: string;
  source_rig: unknown;
  source_run: unknown;
  source_seq: unknown;
  tree: unknown;
  verdict: string;
}

interface ConclusionDecided {
  proposal: number;
  kind: string;
}

type QueuePosition = number | "end" | "top";
type McpAgents = "advisors" | "planner" | "workers";

/** The agents' model route, as the harness took it. */
interface ModelRouteInfo {
  source: "control" | "environment" | "none";
  name?: string | undefined;
  version?: number | undefined;
  revision?: string | undefined;
  harness?: Harness | undefined;
  model?: string | undefined;
  base_url?: string | undefined;
  key_hint?: string | undefined;
}

/** A research run's digest, or its final report. */
interface ResearchReport {
  sources: number;
  domains: number;
  verified: number;
  corroborated: number;
  drafts: number;
  hypotheses: number;
  findings: number;
  draft_findings: number;
  questions: { question: string; verified: number }[];
  last_hour: { sources: number; verified: number; questions_covered: number };
  elapsed_ms: number;
  min_ms: number;
  max_ms: number | null;
  min_verified_claims: number | null;
  paper?: boolean | undefined;
  no_paper?: string | undefined;
  unsupported_numbers: number;
  report: string;
}

/** A kind's body. */
export type EventBody<K extends EventKind> = EventBodies[K];

/** Records one event of a kind with that kind's body (the ledger's appendEvent): its id. */
export type AppendEvent = <K extends EventKind>(
  actor: string,
  kind: K,
  subject: string | null,
  body: EventBodies[K],
) => number;

/** An event of one of `K`'s kinds, with that kind's body. */
export type EventOf<K extends EventKind = EventKind> = {
  [P in K]: { kind: P; body: EventBodies[P] };
}[K];

/** An event to record: its kind, what it is about, and the kind's body. */
export type EventToRecord = EventOf & { subject: string };

/** Every kind has a body, and every body a kind: this fails to compile otherwise. */
type None<T extends never> = T;
export type EveryKindHasABody = None<
  Exclude<EventKind, keyof EventBodies> | Exclude<keyof EventBodies, EventKind>
>;
