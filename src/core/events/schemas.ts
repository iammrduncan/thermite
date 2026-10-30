import { z } from "zod";
import type { EventBodies } from "./bodies.ts";
import type { EventKind } from "./kinds.ts";

/**
 * Each event kind's body as control's views read it: the fold of a rig's events
 * (control/views/fold), the words of its history (control/ui/words) and the pages that read an
 * event's body. A schema names every field those read, with the type its writer gives it
 * (bodies.ts). A field may be missing or null, as in an event of an older ledger, unless the views
 * can't do without it. Other fields are not looked at. A kind the views read through a parser of
 * its own, such as `goal_checks` (core/goal), and a kind they read nothing of, have none.
 *
 * Control checks each event against its kind's schema before its views fold it. An event that
 * fails, or whose actor is longer than EVENT_ACTOR_MAX, is kept in its run's history with why, and
 * its views fold nothing from it (whyUnreadable). The event itself is kept as the rig sent it.
 */

/** The longest actor an event may name, in characters: the views fold no event with a longer one. */
export const EVENT_ACTOR_MAX = 200;

const str = z.string().nullish();
const num = z.number().nullish();
const bool = z.boolean().nullish();
const strs = z.array(z.string()).nullish();
const nums = z.array(z.number()).nullish();
/** A count given as a number, or as the list of what it counts. */
const count = z.union([z.number(), z.array(z.unknown())]).nullish();
/** A review's number, or a key, as a number or as digits. */
const numOrText = z.union([z.number(), z.string()]).nullish();
const list = <S extends z.core.$ZodLooseShape>(shape: S) => z.array(z.object(shape)).nullish();

/** The experiment queue's events (goal 064) share their fields: each has those it needs. */
const experiment = z.object({
  id: str,
  title: str,
  details: str,
  family: str,
  why: str,
  by: str,
  state: str,
  position: numOrText,
  lane: str,
  trial: str,
  attempt: str,
  result: str,
  stopped: str,
  cause: str,
  from_run: str,
  question: num,
  returns: num,
  requeued_from: z.object({ result: str }).nullish(),
  yield: z
    .object({
      verified_claims: num,
      by_question: list({ question: num, verified_claims: num, new_domain_claims: num }),
      new_domains: num,
      domains: z.array(z.union([z.string(), z.number()])).nullish(),
      findings: num,
      card_changes: num,
    })
    .nullish(),
});

/** A research run's hypotheses (goal 117): added, revised, merged and their status. */
const hypothesis = z.object({
  hypothesis: str,
  lane: str,
  text: str,
  question: num,
  status: str,
  from: str,
  into: str,
  by: str,
  reason: str,
  supporting: z.array(z.union([z.string(), z.number()])).nullish(),
});

/** A research run's digest, or its final report. */
const researchReport = z.object({
  sources: num,
  domains: num,
  verified: num,
  corroborated: num,
  drafts: num,
  hypotheses: num,
  findings: num,
  draft_findings: num,
  questions: list({ question: str, verified: num }),
  last_hour: z.object({ sources: num, verified: num, questions_covered: num }).nullish(),
  elapsed_ms: num,
  min_ms: num,
  max_ms: num,
  min_verified_claims: num,
  paper: bool,
  no_paper: str,
  unsupported_numbers: num,
  report: str,
});

const auditEnd = z.object({ decision: str, reasons: str, note: str });
const ruleEnded = z.object({ id: num, ids: nums });

const BODIES = {
  // ---------------------------------------------------------------- runs and commands
  run_created: z.object({
    campaign: str,
    mode: str,
    agents: bool,
    promotion: str,
    seed: z.object({ repo: str, commit: str, folder: str, source_commit: str }).nullish(),
    ask_owner: z
      .object({ above_gain: num, declared_flaws: bool, reviews: bool, not_possible: bool })
      .nullish(),
  }),
  run_status: z.object({ status: z.string(), reason: str }),
  command: z.object({ kind: str, accepted: bool }),
  command_rejected: z.object({ reason: str, kind: str, id: str }),

  // ---------------------------------------------------------------- attempts and the judge
  attempt_recorded: z.object({
    run: z.string(),
    lane: str,
    lifecycle: str,
    hypothesis: str,
    commit: str,
    parent: str,
    known_flaws: strs,
    files: list({ path: z.string(), added: num, removed: num }),
    files_total: num,
    violations: strs,
    violations_total: num,
  }),
  attempt_lifecycle: z.object({ lifecycle: z.string() }),
  job_queued: z.object({ attempt: str, kind: str, run: str }),
  job_finished: z.object({
    state: str,
    result: z
      .object({ gained: strs, lost: strs, unsure: strs, waiting: str, error: str })
      .nullish(),
  }),
  job_lease_expired: z.object({ state: str }),
  crash_infra: z.object({ state: str }),
  job_unblocked: z.object({ state: str }),
  job_cancelled: z.object({ attempt: str, run: str, reason: str }),
  verdict: z.object({
    verdict: z.string(),
    delta: num,
    ci_low: num,
    ci_high: num,
    reasons: str,
    values: z
      .object({ metric: str, cells: list({ cell: str, candidate: num, reference: num }) })
      .nullish(),
  }),
  invalidation: z.object({
    id: num,
    run: str,
    kind: str,
    reason: str,
    attempts: strs,
    verdicts: nums,
    champions: nums,
  }),
  baseline: z.object({
    champion_seq: num,
    commit: str,
    attempt: str,
    blocks: num,
    runs_per_cell: num,
    primary: z.object({ metric: str, direction: str }).nullish(),
    guards: list({ metric: str, direction: str, max_total_regression: num }),
    units: z.record(z.string(), z.string()).nullish(),
    cells: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
    files: z.array(z.unknown()).nullish(),
    bytes: num,
    summary: str,
  }),
  baseline_failed: z.object({ champion_seq: num, commit: str, reasons: str, summary: str }),
  calibration: z.object({ sigma: num, summary: str }),
  held_out_checked: z.object({
    run: str,
    champion_seq: num,
    pass: bool,
    cells: list({
      cell: str,
      goal: str,
      verifier: str,
      ok: bool,
      kind: str,
      value: num,
      low: num,
      high: num,
      threshold: num,
      op: str,
      measure: str,
      unit: str,
    }),
    cells_total: num,
  }),
  parent_screened: z.object({ effect: str }),
  goal_report: z.object({
    champion_seq: num,
    goals: list({
      goal: z.string(),
      description: str,
      status: z.string(),
      reasons: z.string(),
      values: z.unknown().optional(),
    }),
    complete: bool,
    confirming: bool,
    not_confirmed: str,
  }),
  port_queued: z.object({ onto_seq: num, why: str }),

  // ---------------------------------------------------------------- champions and promotion
  champion_promoted: z.object({ seq: num, attempt: str, commit: str, setup: bool }),
  champion_published: z.object({
    seq: num,
    repo: str,
    base_commit: str,
    tree: str,
    sha256: str,
    path: str,
  }),
  champion_reopened: z.object({ seq: num }),
  champion_moved_back: z.object({ from: num, to: num, attempt: str, invalidation: num }),
  promotion_pending: z.object({ run: z.string(), expected_seq: num, reason: str }),
  promotion_declined: auditEnd,
  flaws_accepted: z.object({ by: str }),
  propagation_received: z.object({
    source_rig: str,
    source_run: str,
    source_seq: num,
    tree: str,
    attempt: str,
    result: str,
  }),
  propagation_accepted: z.object({ attempt: str, verdict: str }),
  propagation_rejected: z.object({ attempt: str, verdict: str }),

  // ---------------------------------------------------------------- advisors
  audit_requested: z.object({ run: z.string(), reason: str, expected_seq: num }),
  audit_decided: auditEnd,
  audit_skipped: z.object({ run: z.string(), reason: str, why: str }),
  audit_overridden: auditEnd,
  advisor_answer: z.object({ message: num, role: str, text: str, advisor: str }),
  directive: z.object({
    id: num,
    body: z
      .object({
        kind: str,
        family: str,
        match: str,
        value: z.union([z.string(), z.number(), z.boolean()]).nullish(),
        rationale: str,
        from_message: num,
        converted_from: z.object({ rule: num, words: str }).nullish(),
      })
      .nullish(),
  }),
  directive_converted: z.object({
    id: num,
    ids: nums,
    to: num,
    kind: str,
    family: str,
    words: str,
  }),
  directive_dropped: ruleEnded,
  directives_superseded: ruleEnded,
  directives_left_out: z.object({
    rules: list({ kind: str, family: str, match: str, from_message: num }),
    why: str,
    reason: str,
  }),
  conclusion_proposed: z.object({
    proposal: num,
    approaches: list({ family: str, attempts: num }),
  }),
  conclusion_accepted: z.object({ proposal: num }),
  conclusion_rejected: z.object({ proposal: num }),
  review_requested: z.object({
    review: num,
    goal: str,
    commit: str,
    questions: num,
    hypotheses: num,
    verified_claims: num,
  }),
  review_try_failed: z.object({ review: numOrText, try: numOrText, error: str }),
  review_panel: z.object({
    review: num,
    goal: str,
    result: str,
    reviewers: count,
    decided: count,
    open: count,
    tries: num,
    questions: z.array(z.unknown()).nullish(),
    gaps: z.array(z.unknown()).nullish(),
  }),
  review_decided: z.object({ review: num, goal: str, decision: str, note: str }),
  review_items: z.object({
    review: numOrText,
    reviewer: str,
    items: z.array(z.unknown()).nullish(),
  }),
  item_decided: z.object({
    review: numOrText,
    kind: str,
    key: numOrText,
    card_version: num,
    decision: str,
    certainty: str,
    dissent: z.array(z.unknown()).nullish(),
  }),

  // ---------------------------------------------------------------- the agents' work
  epoch_started: z.object({
    n: num,
    source: str,
    plan: str,
    notes: str,
    planner_tries: num,
    planner_valid: bool,
    raw_violations: num,
    refused: strs,
    causes: list({ try: num, cause: str, detail: str }),
    assignments: list({ lane: str, family: str, focus: str, parent: str }),
  }),
  planner_handout: z.object({
    round: num,
    assignments: list({ lane: str, experiment: str, why: str }),
    notes: str,
  }),
  queue_low: z.object({ round: num, ready: num, target: num }),
  family_added: z.object({ family: str, description: str, for_rules: nums }),
  experiment_added: experiment,
  experiment_accepted: experiment,
  experiment_moved: experiment,
  experiment_edited: experiment,
  experiment_dropped: experiment,
  experiment_assigned: experiment,
  experiment_finished: experiment,
  experiment_returned: experiment,
  trial_started: z.object({ trial: str, lane: str, family: str, focus: str }),
  trial_finished: z.object({
    trial: str,
    lane: str,
    epoch: num,
    family: str,
    attempt: str,
    stopped: str,
    turns: num,
    tokens_in: num,
    tokens_out: num,
    compactions: num,
    error: str,
  }),
  trial_repeating: z.object({ lane: str, count: num, different: num }),
  context_compacted: z.object({
    trial: str,
    lane: str,
    harness: str,
    number: num,
    tokens_before: num,
    tokens_after: num,
    how: str,
    snapshot: str,
  }),
  agents_stopped: z.object({ kind: str, words: str, by: str, said: str }),
  agents_resumed: z.object({ why: str }),
  agents_wait_for_limit: z.object({ until: str, reason: str }),
  agents_wait_ended: z.object({ until: str }),
  journal_note: z.object({
    id: num,
    by: str,
    kind: str,
    text: str,
    about: z.object({ type: str, id: numOrText }).nullish(),
    lane: str,
    trial: str,
  }),
  agent_message: z.object({ id: num, to: str, keep: bool, text: str }),
  agent_message_read: z.object({ message: num, by: str, trial: str, round: num }),
  agent_message_unkept: z.object({ message: num }),
  terminal_input: z.object({
    command: str,
    trial: str,
    lane: str,
    text: str,
    keys: strs,
    outcome: str,
    why: str,
    until: str,
  }),

  // ---------------------------------------------------------------- models and MCP servers
  model_route_set: z.object({ source: str, name: str, version: num, model: str }),
  model_route_cleared: z.object({ source: str, name: str, version: num, model: str }),
  mcp_servers: z.object({ servers: list({ name: str, agents: strs }) }),
  mcp_servers_wait: z.object({ waited_s: num, missing: list({ name: str, why: str }) }),
  mcp_server_failed: z.object({ server: str, agents: str, error: str }),
  mcp_server_back: z.object({ server: str, agents: str }),

  // ---------------------------------------------------------------- the rig
  rig_check_started: z.object({ id: str, check: str, force: bool }),
  rig_check_finished: z.object({ id: str, check: str, ok: bool, summary: str, note: str }),
  rig_settings_changed: z.object({
    change: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).nullish()),
  }),

  // ---------------------------------------------------------------- research
  claim_added: z.object({ verified: bool, text: str, problems: strs, more_problems: num }),
  research_note: z.object({ note: num, by: str, text: str, sources: strs, trial: str }),
  hypothesis_added: hypothesis,
  hypothesis_revised: hypothesis,
  hypothesis_merged: hypothesis,
  hypothesis_status: hypothesis,
  card_written: z.object({
    question: num,
    version: num,
    certainty: str,
    claims: num,
    gaps: num,
    by: str,
    answer: str,
    cited: strs,
    gap_list: list({ kind: str, text: str }),
  }),
  card_refused: z.object({ question: num, by: str, count: num, problems: strs }),
  research_digest: researchReport,
  research_final: researchReport,
  research_progress: z.object({
    open: nums,
    saturated: nums,
    last_improvement: str,
    since_ms: num,
    needed_ms: num,
  }),
  research_stopped: z.object({ open: z.object({ questions: nums, hypotheses: strs }).nullish() }),
  research_paper_refused: z.object({ count: num, problems: strs }),
  research_paper_accepted: z.object({
    writer: str,
    ste: z.object({ checked: bool }).nullish(),
    cited_claims: num,
    experiments: z.array(z.unknown()).nullish(),
    paper: str,
  }),
} satisfies { [K in EventKind]?: z.ZodType };

/** Each kind's schema, by kind: a kind with none is not checked. */
const SCHEMAS = new Map<string, z.ZodType>(Object.entries(BODIES));

/** The most of a body's problems the words name, and the most characters they take. */
const PROBLEMS_NAMED = 3;
const WHY_MAX = 300;

/**
 * Why control's views can't read an event, in words, or undefined when they can: its actor is
 * longer than EVENT_ACTOR_MAX, or its body is not one its kind's schema takes. The words name
 * the body's fields and what each should be, never what it holds.
 */
export function whyUnreadable(e: {
  kind: string;
  actor: string;
  body: unknown;
}): string | undefined {
  if (e.actor.length > EVENT_ACTOR_MAX)
    return `its actor is ${e.actor.length} characters long, longer than the ${EVENT_ACTOR_MAX} control takes`;
  const r = SCHEMAS.get(e.kind)?.safeParse(e.body ?? {});
  if (!r || r.success) return undefined;
  const issues = r.error.issues;
  const named = issues
    .slice(0, PROBLEMS_NAMED)
    .map((i) => `${i.path.length ? i.path.join(".") : "its body"}: ${i.message}`);
  const more = issues.length - named.length;
  const why = `${named.join("; ")}${more ? `; and ${more} more` : ""}`;
  return why.length > WHY_MAX ? `${why.slice(0, WHY_MAX - 1)}…` : why;
}

/**
 * A writer's field with what it leaves `unknown`, or a list of `unknown`, taken as anything: a
 * schema decides what such a field is.
 */
type Typed<T> = unknown extends T
  ? never
  : T extends readonly (infer E)[]
    ? unknown extends E
      ? never[]
      : T
    : T;
/** The fields a schema needs: those that may be neither missing nor undefined. */
type Needed<I> = { [P in keyof I]-?: undefined extends I[P] ? never : P }[keyof I];
/**
 * The fields of a writer's body (W) a schema's input (I) refuses: one the writer gives of a type
 * the schema does not take, and one the schema needs that the writer does not give.
 */
type Refused<W, I> =
  | { [P in keyof W & keyof I]-?: Typed<W[P]> extends I[P] ? never : P }[keyof W & keyof I]
  | Exclude<Needed<I>, keyof W>;
type None<T extends never> = T;
/**
 * Every body its writer gives (bodies.ts) is one its kind's schema takes: else this fails to
 * compile, and names each kind and field that would be refused.
 */
export type EveryWrittenBodyIsRead = None<
  {
    [K in keyof typeof BODIES]: `${K}.${Refused<EventBodies[K], z.input<(typeof BODIES)[K]>> & string}`;
  }[keyof typeof BODIES]
>;
