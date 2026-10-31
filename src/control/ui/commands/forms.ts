import type { CommandKind } from "../../../core/commands.ts";
import { exportForm } from "../exports.ts";

/**
 * The payload of each command a dashboard form sends to /ui/commands, from the form's fields.
 * A kind with none here is not available from the dashboard. Rules come from Tell the planner
 * (goal 066): the dashboard sends no redirect of its own.
 */
export function formPayload(kind: CommandKind, f: Record<string, unknown>): unknown {
  const run = String(f.run ?? "");
  // Withdraw evidence (goal 174): the attempt, or one of its jobs; a preview, until it names one.
  const job = /^job:(\d+)$/.exec(String(f.subject ?? ""))?.[1];
  const payloads: Partial<Record<CommandKind, unknown>> = {
    pause_run: { run, reason: String(f.reason || "paused from the dashboard") },
    resume_run: { run },
    // Resume now, on a run's page while its agents wait for the provider's limit.
    end_wait: { run },
    close_run: { run, reason: String(f.reason ?? "").trim() },
    reset_workers: { run },
    // Export (goal 103): what changed since the last export, or a full one, as the owner chose.
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
      ...(String(f.family ?? "").trim() ? { family: String(f.family).trim() } : {}),
      ...(String(f.why ?? "").trim() ? { why: String(f.why).trim() } : {}),
      position: f.position === "end" ? "end" : "top",
    },
    // Each field as the form has it: emptied details or why are cleared; a title and a
    // direction stay unless given.
    queue_edit: {
      run,
      id: String(f.id ?? ""),
      ...(String(f.title ?? "").trim() ? { title: String(f.title).trim() } : {}),
      details: String(f.details ?? "").trim(),
      ...(String(f.family ?? "").trim() ? { family: String(f.family).trim() } : {}),
      why: String(f.why ?? "").trim(),
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
