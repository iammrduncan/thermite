import type { AttemptView } from "../../views/index.ts";

/**
 * Plain words for the judge's verdicts and an attempt's states: "confirmed faster: +14.2%" rather
 * than "win_confirmed 0.142". Plain text: callers escape it.
 */

const VERDICT = new Map<string, string>(
  Object.entries({
    win_screened: "looked faster in screening; being confirmed on fresh runs",
    win_confirmed: "confirmed faster on fresh runs",
    not_confirmed: "did not hold up on fresh runs",
    regress: "worse than the champion",
    neutral: "no measurable difference",
    no_progress: "met no new goal",
    inconclusive: "too noisy, or not checkable, to tell",
    invalid: "broken: it failed a correctness check or did not build",
    rejected_v0: "refused before building: it broke a contract rule",
    crash_candidate: "crashed when run",
    crash_infra: "the rig failed while measuring it (not the change's fault)",
    invalidated: "its evidence was invalidated",
    goal_screened: "looked like goal progress; being confirmed on fresh runs",
    goal_progress: "confirmed: it meets more goals and loses none",
    starting_point: "measured: it became the run's starting point",
  }),
);

const LIFECYCLE = new Map<string, string>(
  Object.entries({
    queued: "waiting for the judge",
    building: "being built",
    screening: "being measured",
    confirming: "being confirmed on fresh runs",
    verifying: "being checked",
    awaiting_audit: "held for an audit",
    declined: "declined by you",
    awaiting_approval: "waiting for your approval",
    audit_blocked: "blocked by the auditor",
    promoted: "became the champion",
    judged: "judged",
    duplicate: "the same change as an earlier attempt",
    rejected: "refused",
    errored: "failed in the judge",
    not_judged: "not judged: its run closed first",
  }),
);

/** A verdict in words, with the measured change when there is one. */
export function verdictText(verdict: string, delta?: number | null): string {
  const words = VERDICT.get(verdict) ?? verdict.replace(/_/g, " ");
  return typeof delta === "number" && Number.isFinite(delta)
    ? `${words} (${signed(delta)})`
    : words;
}

/** Where an attempt is, in words: its verdict if it has one, else its state. */
export function attemptState(a: Pick<AttemptView, "verdict" | "lifecycle" | "delta">): string {
  const words = LIFECYCLE.get(a.lifecycle);
  if (words && a.lifecycle !== "judged" && a.lifecycle !== "queued") return words;
  if (a.verdict) return verdictText(a.verdict, a.delta);
  return words ?? a.lifecycle.replace(/_/g, " ");
}

export const signed = (x: number, digits = 1) =>
  `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
