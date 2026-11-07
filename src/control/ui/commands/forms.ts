import type { CommandKind } from "../../../core/commands.ts";
import { exportForm } from "../exports.ts";

/**
 * A queue form's Tries (goal 214): sent when it is filled in and differs from the number the edit
 * form started with (`tries_was`). A value that is not a whole number goes as it is, for the
 * payload's check to refuse in words.
 */
function triesField(f: Record<string, unknown>): { tries?: number } {
  const given = String(f.tries ?? "").trim();
  if (!given || given === String(f.tries_was ?? "").trim()) return {};
  return { tries: Number(given) };
}

/**
 * The payload of each command a dashboard form sends to /ui/commands, from the form's fields.
 * A kind with none here is not available from the dashboard. Rules come from Tell the planner
 * (goal 066): the dashboard sends no redirect of its own, but for how many changes may wait for
 * the judge, which is the owner's alone (goal 230).
 */
export function formPayload(kind: CommandKind, f: Record<string, unknown>): unknown {
  const run = String(f.run ?? "");
  // Withdraw evidence (goal 174): the attempt, or one of its jobs; a preview, until it names one.
  const job = /^job:(\d+)$/.exec(String(f.subject ?? ""))?.[1];
  const payloads: Partial<Record<CommandKind, unknown>> = {
    pause_run: { run, reason: String(f.reason || "paused from the dashboard") },
    redirect:
      f.open_attempts === undefined
        ? undefined
        : {
            run,
            directives: [
              {
                kind: "open_attempts",
                value: Number(f.open_attempts),
                rationale: "set on the run's page",
              },
            ],
            replace: false,
          },
    resume_run: { run },
    // Resume now, on a run's page while its agents wait for the provider's limit.
    end_wait: { run },
    close_run: { run, reason: String(f.reason ?? "").trim() },
    reset_workers: { run },
    // Start a teachers' round (goal 194), from a run's ⋯ menu.
    start_teachers_round: { run },
    // Add hours (goal 198), on a run its hours paused.
    add_run_hours: { run, hours: Number(f.hours) },
    // Export (goal 103): the run alone, or a full one, as the owner chose (goal 180: no export of
    // what changed).
    export_now: exportForm(f).payload,
    rig_check: { check: String(f.check ?? ""), ...(f.force === "true" ? { force: true } : {}) },
    approve_promotion: { run, attempt: String(f.attempt ?? "") },
    decline_promotion: { run, attempt: String(f.attempt ?? "") },
    accept_review: { run, review: Number(f.review), accept: f.accept === "true" },
    conclude: { run, proposal: Number(f.proposal), accept: f.accept === "true" },
    // A research run's hypothesis (goal 117): promoted, back to the pool or retired, with why.
    hypothesis_status: {
      run,
      id: String(f.id ?? ""),
      status: String(f.status ?? ""),
      reason: String(f.reason ?? "").trim(),
    },
    // The experiment queue (goal 064).
    queue_add: {
      run,
      title: String(f.title ?? "").trim(),
      ...(String(f.details ?? "").trim() ? { details: String(f.details).trim() } : {}),
      ...(String(f.direction ?? "").trim() ? { direction: String(f.direction).trim() } : {}),
      ...(String(f.why ?? "").trim() ? { why: String(f.why).trim() } : {}),
      ...triesField(f),
      position: f.position === "end" ? "end" : "top",
    },
    // Each field as the form has it: emptied details or why are cleared; a title and a
    // direction stay unless given.
    queue_edit: {
      run,
      id: String(f.id ?? ""),
      ...(String(f.title ?? "").trim() ? { title: String(f.title).trim() } : {}),
      details: String(f.details ?? "").trim(),
      ...(String(f.direction ?? "").trim() ? { direction: String(f.direction).trim() } : {}),
      why: String(f.why ?? "").trim(),
      ...triesField(f),
    },
    queue_move: {
      run,
      id: String(f.id ?? ""),
      position:
        f.position === "top" || f.position === "end"
          ? f.position
          : Math.max(0, Math.trunc(Number(f.position)) || 0),
    },
    queue_drop: {
      run,
      id: String(f.id ?? ""),
      why: String(f.why ?? "").trim() || "dropped by the owner",
    },
    queue_accept: { run, id: String(f.id ?? "") },
    // Send back to up next (goal 221), on a tried experiment, with why.
    queue_retry: { run, id: String(f.id ?? ""), why: String(f.why ?? "").trim() },
    drop_directive: { run, id: Number(f.id) },
    invalidate_evidence: {
      run,
      ...(job ? { job: Number(job) } : { attempt: String(f.attempt ?? "") }),
      reason: String(f.reason ?? "").trim(),
      ...(String(f.reach ?? "") ? { reach: String(f.reach) } : { preview: true }),
    },
    unkeep_message: { run, message: Number(f.message) },
    // A drain's card and its trials under At work (goal 136): End the drain, and Stop the trial.
    // A stuck trial's card (goal 143) gives why, and the trial's stop records it.
    drain_rig: { drain: false, reason: "the owner ended the drain" },
    stop_trial: {
      run,
      trial: String(f.trial ?? ""),
      ...(String(f.reason ?? "").trim() ? { reason: String(f.reason).trim() } : {}),
    },
  };
  return payloads[kind];
}
