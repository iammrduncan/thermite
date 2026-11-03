import type { RigState, RunpodRigView } from "../../core/api/control/runpod.ts";
import type { StoredRunpodRig, TunnelRig } from "../store/index.ts";
import type { RigOp } from "./lifecycle.ts";

export type { RigState, RunpodRigView };

/** The change under way on a rig, in words: what it is and what it waits for. */
export function opWords(op: Pick<RigOp, "kind" | "phase">): string {
  const doing = {
    stop: "stopping",
    start: "starting",
    restart: "restarting",
    terminate: "terminating",
  }[op.kind];
  const waits = {
    quiescing: "waiting until no judge job and no command waits on the rig",
    exporting: op.kind === "terminate" ? "waiting for its full export" : "waiting for its export",
    leaving:
      op.kind === "terminate"
        ? "waiting for every result to leave the pod"
        : "waiting for its results to leave the pod",
    stopping: "waiting for the pod to stop",
    starting: "waiting for the pod to run",
  }[op.phase];
  return `${doing}: ${waits}`;
}

/** What the pod has cost by `now`, in USD (not rounded). */
export function spentBy(s: RigState, now: number): number {
  if (s.price_per_hr === null) return s.spent_usd;
  const ms = s.billed_since ? Math.max(0, now - Date.parse(s.billed_since)) : 0;
  return s.spent_usd + (s.price_per_hr * ms) / 3_600_000;
}

/**
 * Since when the rig is idle for its idle stop: the latest of when the stop was set, when the
 * pod enrolled, when it last started running and when a run was last at work. Null without an idle
 * stop, before enrollment, while the pod is not running, or while a run is at work on it (as
 * control last saw): the idle stop and the rig's page use this one rule.
 */
export function idleSince(s: RigState, enrolledAt: string | null): string | null {
  if (s.idle_stop_minutes === null || !enrolledAt || !s.running_since || s.at_work) return null;
  const times = [s.idle_from, enrolledAt, s.running_since, s.busy_at].filter((t): t is string =>
    Boolean(t),
  );
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/** A RunPod rig as shown over REST and MCP, and in the rig's view. */
export function runpodRigView(
  r: StoredRunpodRig,
  tunnel: TunnelRig | undefined,
  now: number,
): RunpodRigView {
  const s = r.state as RigState;
  const enrolledAt = tunnel?.enrolled_at ?? null;
  return {
    ...s,
    error: s.error ?? s.refusal?.words ?? null,
    refusal: s.refusal?.words ?? null,
    op: s.op ?? null,
    op_words: s.op ? opWords(s.op) : null,
    paused_runs: s.paused_runs ?? [],
    last_export: s.last_export ?? null,
    last_export_left: s.last_export_left ?? false,
    rig: r.rig,
    cloud: r.cloud,
    pod: r.pod,
    active: r.active,
    created_by: r.created_by,
    spend_usd: s.price_per_hr === null ? null : Math.round(spentBy(s, now) * 100) / 100,
    enrolled_at: enrolledAt,
    bus_leaf: tunnel?.leaf_address ?? null,
    idle_since: idleSince(s, enrolledAt),
  };
}
