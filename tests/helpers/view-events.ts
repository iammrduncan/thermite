import type { ControlStore } from "../../src/control/store/index.ts";
import { PAPER_ACCEPTED, PAPER_REFUSED, PAPER_REQUESTED } from "../../src/core/research-check.ts";
import { seedDemo } from "./control-demo.ts";
import { ingestReport } from "./control-store.ts";
import { researchRunEvents } from "./research-reviews.ts";

/**
 * Rigs' events as control's tests build them, for the tests of control's views (goal 125, T8):
 * the demo's three rigs, a hill climb with promotions, a goal campaign, a research campaign, a
 * reset to a new ledger, judge jobs without an attempt, kinds the views do not fold, and a run
 * longer than every list a view keeps. Each set fills a store as the rigs' reports do.
 */

/** One event as a harness writes it; its time is the set's next minute unless it gives one. */
export interface SetEvent {
  kind: string;
  subject: string | null;
  body: Record<string, unknown>;
  actor?: string;
  at?: string;
}

/** A set of rigs' events: a name for the test's messages, and how it fills a store. */
export interface ViewSet {
  name: string;
  fill(store: ControlStore): Promise<void>;
}

/** The time the sets' events start at, and the time the views are read at. */
export const SET_START = Date.parse("2026-10-20T00:00:00Z");
export const VIEW_NOW = Date.parse("2026-10-22T00:00:00Z");

const ev = (
  kind: string,
  subject: string | null,
  body: Record<string, unknown> = {},
  actor?: string,
): SetEvent => ({ kind, subject, body, ...(actor ? { actor } : {}) });

/** A rig's report of `events` in one ledger, numbered from `from` + 1, a minute apart. */
export async function report(
  store: ControlStore,
  rig: string,
  ledger: string,
  events: SetEvent[],
  summary: Record<string, unknown> = {},
  from = 0,
): Promise<void> {
  await ingestReport(store, {
    rig,
    ledger_id: ledger,
    cursor: from,
    next: from + events.length,
    generated_at: new Date(SET_START).toISOString(),
    events: events.map((e, i) => ({
      id: from + i + 1,
      at: e.at ?? new Date(SET_START + (from + i) * 60_000).toISOString(),
      actor: e.actor ?? "harness",
      kind: e.kind,
      subject: e.subject,
      body: e.body,
    })),
    summary,
  });
}

const SEED = "a".repeat(40);
const FIX = "b".repeat(40);

/** What a rig's harness says it runs, as its report gives it (goals 136 and 143). */
function summaryWith(open: { trial: string; run: string; lane: string }[]) {
  return {
    jobs: { queued: 1, leased: 0, done: 4 },
    settings: { lanes: 2, planner: true, promotion: "owner_approval", trial_minutes: 30 },
    gpu_split: { set: 4, judge: 1 },
    model: { source: "control", name: "route-a", version: 2, model: "m", harness: "codex" },
    work: {
      trials: open.length,
      judge_jobs: 1,
      draining: null,
      open: open.map((o) => ({
        ...o,
        started_at: new Date(SET_START).toISOString(),
        task: "tile the inner loop",
        question: null,
        turns: 3,
        tool_calls: 9,
        tokens_in: 1200,
        claims: null,
        refused_again: null,
        last_line_at: new Date(SET_START + 60_000).toISOString(),
        reply: null,
        repeating: null,
      })),
    },
  };
}

/**
 * A hill climb with promotions: a closed run with a pending promotion before it, then a run whose
 * starting point is set up and measured, with the planner's rounds, rules made from the owner's
 * message, the experiment queue, audits, confirmed and declined wins, champions promoted,
 * published, received from another rig and reopened, notes and checks.
 */
export function hillClimbEvents(run = "h-1"): SetEvent[] {
  const values = {
    metric: "tok_per_s",
    cells: [
      { cell: "wiki", candidate: 4900, reference: 4512 },
      { cell: "code", candidate: 4300, reference: 4000 },
    ],
  };
  return [
    ev("run_created", "h-0", { campaign: "speed", mode: "hill_climb", seed: { commit: SEED } }),
    ev("attempt_recorded", "a-0", { run: "h-0", lane: "lane-1", lifecycle: "queued" }),
    ev("verdict", "a-0", { verdict: "win_confirmed", delta: 0.05 }),
    ev("promotion_pending", "a-0", { run: "h-0", expected_seq: 1, reason: "the owner approves" }),
    ev("run_status", "h-0", { status: "closed", reason: "the owner closed it" }),
    ev("rig_check_started", null, { check: "smoke", id: "chk-1" }),
    ev("run_created", run, {
      campaign: "speed",
      version: 1,
      mode: "hill_climb",
      agents: true,
      promotion: "owner_approval",
      ask_owner: { above_gain: 0.1, declared_flaws: true, reviews: false },
      seed: { repo: "proj", commit: SEED, folder: "kernels", source_commit: "c".repeat(40) },
    }),
    ev("run_status", run, { status: "running", reason: null }),
    ev("rig_check_finished", null, { check: "smoke", ok: true, summary: "ok", note: "noisy" }),
    ev("job_queued", "1", { attempt: null, kind: "baseline", run }),
    ev("job_leased", "1"),
    ev("baseline_failed", run, {
      run,
      job: 1,
      champion_seq: 1,
      commit: SEED,
      reasons: "cell small: exit 3: Error: no kernel yet",
      summary: "the judge could not measure champion #1",
    }),
    ev("job_finished", "1", { state: "done", result: {} }),
    ev("epoch_started", run, {
      n: 1,
      source: "fallback",
      plan: "setup",
      planner_valid: false,
      raw_violations: 0,
      assignments: [{ lane: "lane-1", family: "setup", parent: "champion" }],
    }),
    ev("trial_started", run, { lane: "lane-1", trial: "t-1", family: "setup", focus: "the build" }),
    ev("attempt_recorded", "a-fix", {
      run,
      lane: "lane-1",
      lifecycle: "queued",
      hypothesis: "Add the missing kernel.",
      commit: FIX,
      parent: SEED,
      files: [
        { path: "src/kernel.c", added: 40, removed: 2 },
        { path: "blob.bin", added: null, removed: null },
      ],
      files_total: 2,
    }),
    ev("trial_finished", run, {
      lane: "lane-1",
      trial: "t-1",
      family: "setup",
      attempt: "a-fix",
      stopped: "submitted",
      tokens_in: 1000,
      tokens_out: 200,
    }),
    ev("champion_promoted", run, { seq: 2, attempt: "a-fix", commit: FIX, setup: true }),
    ev("job_queued", "2", { attempt: null, kind: "baseline" }),
    ev("baseline", run, {
      run,
      job: 2,
      champion_seq: 2,
      commit: FIX,
      attempt: "a-fix",
      blocks: 3,
      runs_per_cell: 1,
      primary: { metric: "tok_per_s", direction: "max" },
      guards: [{ metric: "ppl_ratio", direction: "min", max_total_regression: 0.01 }],
      units: { tok_per_s: "tok/s", ppl_ratio: "ratio" },
      cells: {
        wiki: { tok_per_s: { median: 4512.3, mad: 9.1, n: 3 } },
        code: { tok_per_s: { median: 3999.5, mad: 20.2, n: 3 } },
      },
      files: [{ path: "ref/wiki.json", bytes: 2048, sha256: "c".repeat(64) }],
      bytes: 2048,
      summary: "tok_per_s wiki 4512, code 4000",
    }),
    ev("job_finished", "2", { state: "done", result: {} }),
    ev("job_queued", "3", { attempt: null, kind: "calibrate" }),
    ev("calibration", run, { sigma: 0.012, summary: "6 A/A blocks" }),
    ev("job_finished", "3", { state: "done", result: { sigma: 0.012 } }),
    ev("agent_message", run, { id: 1, to: "planner", text: "Try tiling first.", keep: true }),
    ev("agent_message_read", run, { message: 1, by: "planner", round: 2 }),
    ev("agent_message_read", run, { message: 1, by: "lane-1", trial: "t-2" }),
    ev("advisor_answer", run, { message: 1, role: "teacher", text: "Tiling.", advisor: "t-1" }),
    ev("advisor_answer", run, { message: 9, role: "teacher", text: "No such message." }),
    ev("family_added", run, { family: "tiling", description: "Tile the loops.", for_rules: [1] }),
    ev("family_added", run, { family: "tiling", description: "Added twice." }),
    ev("family_added", run, { family: "" }),
    ev(
      "directive",
      run,
      { id: 1, body: { kind: "prefer", family: "tiling", rationale: "it won", from_message: 1 } },
      "planner",
    ),
    ev("directive", run, { id: 2, body: { match: "unroll", from_message: 1 } }, "planner"),
    ev(
      "directive",
      run,
      {
        id: 3,
        body: { kind: "avoid", family: "unrolling", from_message: 1, converted_from: { rule: 2 } },
      },
      "planner",
    ),
    ev("directive_converted", run, { id: 2 }),
    ev("directive", run, { id: 4, body: { match: "old words" } }, "teacher"),
    ev("directive", run, { id: 5, body: { kind: "avoid", family: "vectorize" } }, "owner"),
    ev("directives_left_out", run, {
      rules: [{ kind: "avoid", family: "unrolling", from_message: 1 }, { kind: "x" }, null],
    }),
    ev("directives_superseded", run, { ids: [5, "x"] }),
    ev("directive_dropped", run, { id: 99 }),
    ev("epoch_started", run, {
      n: 2,
      source: "planner",
      planner_valid: true,
      raw_violations: 1,
      assignments: [
        { lane: "lane-1", family: "tiling", parent: "champion", focus: "tile 64" },
        { lane: "lane-2", family: "vectorize", parent: "champion" },
      ],
    }),
    ev("epoch_started", run, { source: "fallback", plan: "research", assignments: null }),
    ev("planner_handout", run, {
      round: 2,
      assignments: [{ lane: "lane-1", experiment: "x-1", why: "tiling won before" }, null],
      notes: "two lanes",
    }),
    ev("experiment_added", run, {
      id: "x-1",
      title: "tile 64",
      family: "tiling",
      why: "it won",
      by: "planner",
    }),
    ev("experiment_added", run, { id: "x-2", title: "vector loads", by: "teacher", position: 0 }),
    ev("experiment_added", run, { id: "x-3", title: "a lane's idea", state: "proposed" }),
    ev("experiment_added", run, { id: "x-1", title: "added twice" }),
    ev("experiment_added", run, { title: "no id" }),
    ev("experiment_moved", run, { id: "x-1", position: "top" }),
    ev("experiment_edited", run, { id: "x-2", title: "vector loads, wide", family: "vectorize" }),
    ev("experiment_accepted", run, { id: "x-3", position: 1 }),
    ev("experiment_assigned", run, { id: "x-1", lane: "lane-1", trial: "t-2" }),
    ev("experiment_dropped", run, { id: "x-3", why: "a rule avoids it", by: "planner" }),
    ev("experiment_moved", run, { id: "x-9", position: 0 }),
    ev("trial_started", run, { lane: "lane-1", trial: "t-2", family: "tiling", focus: "tile 64" }),
    ev("trial_started", run, { lane: "lane-2", trial: "t-3", family: "vectorize" }),
    ev("attempt_recorded", "a-1", {
      run,
      lane: "lane-1",
      lifecycle: "queued",
      hypothesis: "Tile by 64.",
      commit: "d".repeat(40),
      parent: FIX,
      known_flaws: ["skips the tail"],
      violations: ["uses a timer", "x".repeat(400)],
    }),
    ev("trial_finished", run, {
      lane: "lane-1",
      trial: "t-2",
      family: "tiling",
      attempt: "a-1",
      stopped: "submitted",
      tokens_in: 5000,
      tokens_out: 900,
    }),
    ev("experiment_finished", run, {
      id: "x-1",
      lane: "lane-1",
      trial: "t-2",
      attempt: "a-1",
      result: "submitted",
    }),
    ev("job_queued", "4", { attempt: "a-1", kind: "evaluate" }),
    ev("job_leased", "4"),
    ev(
      "verdict",
      "a-1",
      {
        verdict: "win_candidate",
        delta: 0.12,
        ci_low: 0.08,
        ci_high: 0.16,
        reasons: "faster on both cells",
        values,
      },
      "judge",
    ),
    ev("job_finished", "4", { state: "done", result: { waiting: "audit" } }),
    ev("attempt_lifecycle", "a-1", { lifecycle: "awaiting_audit" }),
    ev("audit_requested", "a-1", { run, reason: "declared flaws", expected_seq: 2 }),
    ev("audit_decided", "a-1", { decision: "approve", reasons: "the tail is handled" }),
    ev("job_queued", "5", { attempt: "a-1", kind: "confirm" }),
    ev("job_leased", "5"),
    ev("verdict", "a-1", { verdict: "win_confirmed", delta: 0.1, values }, "judge"),
    ev("held_out_checked", "a-1", {
      pass: true,
      cells: [
        {
          cell: "held",
          goal: "speed",
          ok: true,
          kind: "threshold",
          value: 1.2,
          threshold: 1,
          op: ">=",
          unit: "x",
        },
        { cell: 7 },
      ],
    }),
    ev("job_finished", "5", {
      state: "done",
      result: { gained: ["wiki"], lost: [], unsure: ["code"], waiting: "owner_approval" },
    }),
    ev("attempt_lifecycle", "a-1", { lifecycle: "awaiting_approval" }),
    ev("promotion_pending", "a-1", { run, expected_seq: 2, reason: "gain above 10%" }),
    ev("promotion_pending", "a-1", { run, expected_seq: 2, reason: "asked again" }),
    ev("champion_promoted", run, { seq: 3, attempt: "a-1", commit: "d".repeat(40) }),
    ev("attempt_lifecycle", "a-1", { lifecycle: "promoted" }),
    ev("champion_published", run, {
      seq: 3,
      repo: "proj",
      base_commit: SEED,
      tree: "e".repeat(40),
      sha256: "f".repeat(64),
      path: `champions/${run}/3.patch`,
    }),
    ev("propagation_received", run, {
      attempt: "p-1",
      source_rig: "rig-b",
      source_run: "h-2",
      source_seq: 2,
      tree: "9".repeat(40),
    }),
    ev("propagation_accepted", run, { attempt: "p-1", verdict: "win_confirmed" }),
    ev("propagation_received", run, {
      attempt: "p-2",
      source_rig: "rig-b",
      source_run: "h-2",
      source_seq: 3,
    }),
    ev("propagation_rejected", run, { attempt: "p-2", verdict: "regress" }),
    ev("attempt_recorded", "a-2", {
      run,
      lane: "lane-2",
      lifecycle: "queued",
      hypothesis: "Wide.",
    }),
    ev("trial_finished", run, {
      lane: "lane-2",
      trial: "t-other",
      family: "vectorize",
      attempt: "a-2",
      stopped: "submitted",
    }),
    ev("verdict", "a-2", { verdict: "win_confirmed", delta: 0.3 }, "judge"),
    ev("attempt_lifecycle", "a-2", { lifecycle: "awaiting_approval" }),
    ev("promotion_pending", "a-2", { run, expected_seq: 3 }),
    ev("audit_requested", "a-2", { run, reason: "gain above 25%" }),
    ev("audit_skipped", "a-2", { run }),
    ev("audit_overridden", "a-2", { reasons: "the owner read it" }),
    ev("promotion_declined", "a-2", {}),
    ev("attempt_lifecycle", "a-2", { lifecycle: "rejected" }),
    ev("attempt_recorded", "a-3", { run, lane: "lane-2", lifecycle: "duplicate" }),
    ev("attempt_recorded", "a-4", { run, lane: "lane-2", lifecycle: "queued" }),
    ev("verdict", "a-4", { verdict: "win_confirmed", delta: 0.02 }, "judge"),
    ev("promotion_pending", "a-4", { run, expected_seq: 3, reason: "the owner approves" }),
    ev("champion_reopened", run, { seq: 3 }),
    ev("champion_reopened", run, { seq: 2 }),
    ev("agents_stopped", run, { kind: "credits", words: "no credits left", by: "a trial" }),
    ev("agents_resumed", run),
    ev("agents_stopped", run, { kind: "model_check", words: "the model check fails", by: "check" }),
    ev("conclusion_proposed", run, {
      proposal: 1,
      approaches: [{ family: "tiling", attempts: 3 }, { family: "vectorize" }],
    }),
    ev("conclusion_rejected", run, { proposal: 1 }),
    ev("conclusion_proposed", run, { proposal: 2, approaches: [] }),
    ev("conclusion_accepted", run, { proposal: 2 }),
    ev(
      "journal_note",
      run,
      {
        id: 1,
        by: "lane-1",
        kind: "decision",
        text: "Kept the old path below n = 4096.",
        about: { type: "attempt", id: "a-1" },
        lane: "lane-1",
        trial: "t-2",
      },
      "lane-1",
    ),
    ev("journal_note", run, { id: 2, text: "An old note." }, "lane-2"),
    ev("journal_note", run, { id: 3, text: "" }),
    ev("research_note", run, {
      note: 4,
      text: "The survey names three tilings.",
      sources: ["src-1"],
      by: "lane-1",
      trial: "t-2",
    }),
    ev("research_note", run, { note: 5, text: "A note from the planner.", by: "planner" }),
    ev("rig_settings_changed", null, { change: { lanes: 2 }, settings: { lanes: 2 } }, "owner"),
    ev("agent_message_unkept", run, { message: 1 }),
    ev("job_queued", "6", { attempt: "a-4", kind: "evaluate" }),
    ev("job_lease_expired", "6", { state: "queued" }),
    ev("job_lease_expired", "6", { state: "blocked" }),
    ev("job_unblocked", "6"),
    ev("crash_infra", "6", { state: "blocked" }),
    ev("run_status", run, { status: "paused", reason: "the owner paused it" }),
  ];
}

/**
 * A goal campaign: its goal checks, the judge's goal reports with a validation that failed, was
 * blocked and ran again, the champion's held-out check, and a subjective goal's review.
 */
export function goalEvents(run = "g-1"): SetEvent[] {
  const goals = (realtime: string) => [
    { goal: "builds", description: "it builds", status: "met", reasons: "it builds" },
    {
      goal: "realtime",
      status: realtime,
      reasons: "decodes at 1.2x real time",
      values: [{ cell: "song", ok: true, metrics: { speed: 1.2, bad: "x" } }, { cell: 3 }],
    },
  ];
  return [
    ev("job_queued", "1", { attempt: null, kind: "validate" }),
    ev("run_created", run, { campaign: "decoder", mode: "goal", seed: { commit: SEED } }),
    ev("goal_checks", run, {
      kit: { name: "decoder-kit", repo: "kits", commit: "k".repeat(40) },
      run_command: ["make", "check"],
      timeout_s: 600,
      goals: [
        {
          goal: "realtime",
          how: "threshold",
          cells: [
            { name: "song", params: { rate: 48000 }, timeout_s: 30 },
            { name: "held", held_out: true, params: { secret: 1 } },
          ],
        },
        { goal: "readable", how: "review" },
        { goal: "skipped", how: "guess" },
      ],
    }),
    ev("job_queued", "2", { attempt: null, kind: "validate" }),
    ev("goal_report", run, {
      goals: goals("met"),
      champion_seq: 2,
      complete: true,
      confirming: true,
    }),
    ev("job_finished", "2", { state: "failed", result: { error: "the cell crashed" } }),
    ev("goal_report", run, {
      goals: goals("met"),
      champion_seq: 2,
      complete: true,
      confirming: true,
    }),
    ev("job_queued", "3", { attempt: null, kind: "validate", run }),
    ev("job_lease_expired", "3", { state: "blocked" }),
    ev("job_unblocked", "3"),
    ev("job_leased", "3"),
    ev("held_out_checked", run, {
      run,
      champion_seq: 2,
      pass: false,
      cells: [{ cell: "held", ok: false, kind: "below", value: 0.8, threshold: 1, op: "~" }],
      cells_total: 3,
    }),
    ev("job_finished", "3", { state: "done", result: {} }),
    ev("goal_report", run, { goals: goals("unmet"), champion_seq: 2, complete: false }),
    ev("review_requested", run, {
      review: 1,
      goal: "readable",
      commit: FIX,
      questions: 0,
      hypotheses: 0,
      verified_claims: 0,
    }),
    ev("review_panel", run, { review: 1, result: "pass", reviewers: 3, decided: 1, tries: 2 }),
    ev("review_decided", run, { review: 1, decision: "accept", note: "reads well" }),
    ev("review_decided", run, { review: 7, decision: "accept" }),
    ev("goal_report", run, { goals: goals("met"), champion_seq: 3, complete: true }),
    ev("run_status", run, { status: "closed", reason: "complete" }),
  ];
}

/**
 * A research run (the research tests' own), with its answer cards' edge cases, a final report and
 * its paper.
 */
export function researchEvents(): SetEvent[] {
  const run = "s-1";
  return [
    // A minute apart, as the set's other events: the research tests' own times follow the clock.
    ...researchRunEvents().map(({ kind, subject, body }) => ({ kind, subject, body })),
    ev("card_written", run, { question: -1, version: 1, answer: "not a question" }),
    ev("card_refused", run, { question: 2, by: "synthesizer", problems: ["no claim", 3, "y"] }),
    ev("card_refused", run, { question: "x" }),
    ev("hypothesis_revised", run, { hypothesis: "h-none", text: "no such one" }),
    ev(PAPER_REQUESTED, run, {}),
    ev(PAPER_REFUSED, run, { problems: ["too long", "no references"] }),
    ev(PAPER_ACCEPTED, run, {
      writer: "final-writer",
      ste: { checked: true },
      experiments: [{ kind: "hill_climb" }, { kind: "goal" }, { kind: "goal" }, null],
      paper: "# The paper\n\nIt says what was found.",
    }),
    ev(PAPER_REFUSED, run, { problems: ["after it was in"] }),
    ev("research_final", run, { questions: 3, answered: 2, report: "the final report" }),
    ev("run_status", run, { status: "closed", reason: "the research is done" }),
  ];
}

/** Judge jobs without an attempt: before any run, under the running run, for a named run. */
export function jobEvents(): SetEvent[] {
  return [
    ev("job_queued", "1", { attempt: null, kind: "calibrate" }),
    ev("job_leased", "1"),
    ev("run_created", "j-1", { campaign: "jobs", mode: "hill_climb", seed: { commit: SEED } }),
    ev("job_queued", "2", { attempt: null, kind: "baseline" }),
    ev("job_queued", "3", { attempt: null, kind: "validate", run: "j-2" }),
    ev("run_status", "j-1", { status: "paused", reason: "owner" }),
    ev("job_queued", "4", { attempt: null, kind: "calibrate" }),
    ev("run_status", "j-1", { status: "running", reason: null }),
    ev("job_leased", "2"),
    ev("job_leased", "9"),
    ev("job_finished", "9", { state: "done" }),
    ev("crash_infra", "2", { state: "queued" }),
    ev("crash_infra", "2", { state: "blocked" }),
    ev("job_finished", "4", { state: "failed", result: "not an object" }),
    ev("job_queued", "2", { attempt: null, kind: "baseline" }),
    ev("job_queued", "5", { kind: "evaluate", attempt: "a-gone" }),
    ev("job_finished", "5", {}),
  ];
}

/** Kinds no view folds: each is only an event, of its run's timeline when it names the run. */
export function otherKindEvents(): SetEvent[] {
  return [
    ev("run_created", "o-1", { campaign: "other", mode: "goal" }),
    ev("build_recorded", "o-1", { commit: SEED }),
    ev("dev_run", null, { run: "o-1", lane: "lane-1" }),
    ev("contract_stored", "o-2", {}),
    ev("model_call", "o-1", { agent: "planner" }),
    ev("command", "cmd-1", { accepted: true, kind: "pause" }),
  ];
}

/** A run longer than each list a view keeps: timeline, trials, hand-outs, messages, jobs. */
export function longEvents(): SetEvent[] {
  const run = "l-1";
  const out: SetEvent[] = [ev("run_created", run, { campaign: "long", mode: "hill_climb" })];
  for (let i = 1; i <= 220; i++) {
    out.push(ev("agent_message", run, { id: i, to: "lane-1", text: `message ${i}` }));
    if (i % 2) out.push(ev("agent_message_read", run, { message: i, by: "lane-1" }));
  }
  for (let i = 1; i <= 120; i++) {
    out.push(ev("trial_started", run, { lane: `lane-${i % 3}`, trial: `t-${i}`, family: "f" }));
    out.push(ev("trial_finished", run, { lane: `lane-${i % 3}`, trial: `t-${i}`, stopped: "x" }));
  }
  for (let i = 1; i <= 60; i++) out.push(ev("planner_handout", run, { round: i, assignments: [] }));
  for (let i = 1; i <= 230; i++) {
    out.push(ev("job_queued", String(i), { attempt: null, kind: "calibrate" }));
    if (i % 3) out.push(ev("job_leased", String(i)));
    if (i % 5 === 0) out.push(ev("job_finished", String(i), { state: "done" }));
  }
  return out;
}

/** Every set: what the tests of control's views fold. */
export const VIEW_SETS: ViewSet[] = [
  {
    name: "the demo: a goal campaign of two runs, a hill climb waiting for approval, judge jobs",
    fill: (s) => seedDemo(s, VIEW_NOW),
  },
  {
    name: "a hill climb with promotions",
    fill: (s) =>
      report(
        s,
        "rig-h",
        "ledger-h",
        hillClimbEvents(),
        summaryWith([{ trial: "t-3", run: "h-1", lane: "lane-2" }]),
      ),
  },
  { name: "a goal campaign", fill: (s) => report(s, "rig-g", "ledger-g", goalEvents()) },
  { name: "a research campaign", fill: (s) => report(s, "rig-r", "ledger-r", researchEvents()) },
  {
    name: "a reset to a new ledger",
    fill: async (s) => {
      await report(s, "rig-a", "ledger-1", hillClimbEvents("r-1"));
      await report(s, "rig-a", "ledger-2", goalEvents("r-1").slice(0, 8), summaryWith([]));
    },
  },
  {
    name: "judge jobs without an attempt",
    fill: (s) => report(s, "rig-j", "ledger-j", jobEvents()),
  },
  {
    name: "kinds no view folds",
    fill: (s) => report(s, "rig-o", "ledger-o", otherKindEvents()),
  },
  {
    name: "a run longer than every list a view keeps",
    fill: (s) => report(s, "rig-l", "ledger-l", longEvents()),
  },
];
