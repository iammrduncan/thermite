import type { Handlers } from "./index.ts";

/** The rig's checks: each one's newest run, as the rig's view and a check's row show it. */

export interface RigCheckView {
  check: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  summary: string | null;
  /** A check that passed with a caveat says it here (the smoke check on noisy timing). */
  note: string | null;
  /** The rig's id for this run of the check (rig_check's answer names it), or null. */
  id: string | null;
}

/**
 * Each check's newest run, from the rig's rig_check_started and rig_check_finished events: the
 * rig's view, and a check's row on the dashboard, which reads only these (goal 080).
 */
function foldCheck(
  checks: Record<string, RigCheckView>,
  e: { at: string; kind: string; body: unknown },
): void {
  const b = (e.body ?? {}) as Record<string, unknown>;
  const check = String(b.check ?? "");
  const id = typeof b.id === "string" ? b.id : null;
  if (e.kind === "rig_check_started")
    checks[check] = {
      check,
      started_at: e.at,
      finished_at: null,
      ok: null,
      summary: null,
      note: null,
      id,
    };
  else if (e.kind === "rig_check_finished")
    checks[check] = {
      check,
      started_at: checks[check]?.started_at ?? e.at,
      finished_at: e.at,
      ok: b.ok === true,
      summary: typeof b.summary === "string" ? b.summary : null,
      note: typeof b.note === "string" ? b.note : null,
      id: id ?? checks[check]?.id ?? null,
    };
}

export const CHECKS: Handlers = {
  rig_check_started: (f, e) => foldCheck(f.checks, e),
  rig_check_finished: (f, e) => foldCheck(f.checks, e),
};
