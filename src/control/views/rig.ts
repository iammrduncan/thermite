import { buildInfo } from "../../common/build-info.ts";
import { readHardware } from "../../core/hardware.ts";
import type { BuildInfo } from "../../core/version.ts";
import { type RunpodRigView, runpodRigView } from "../runpod/index.ts";
import type { ControlStore } from "../store/index.ts";
import { type RigVersions, rigVersions } from "../versions.ts";
import { runDirections } from "./directions.ts";
import type { FoldedRig } from "./fold/index.ts";
import { readGpuSplit, readModelInfo, readSettings, reportingState } from "./report.ts";
import { standingOf } from "./research.ts";
import { ownCopier } from "./sharing.ts";
import type { RigView, RunView } from "./types.ts";
import { doingsOf, type TrialDoing } from "./work.ts";

/**
 * A rig's view: its current ledger's events, folded (views/fold/), then read with what else the
 * view shows: the rig's row and last report, the clock, control's build, the supervisor's figures
 * and a RunPod rig's pod. rigView (views/cache.ts) does both, with the folds control keeps.
 */

/** How many of the judge's jobs a rig's view shows. */
const SHOWN_JOBS = 200;

/** How rigView reads a rig's view: when a rig is stale and offline, the time, control's build. */
export interface ViewOptions {
  staleAfterMs: number;
  /** After this long without a report the rig is offline (default OFFLINE_AFTER_MS). */
  offlineAfterMs?: number | undefined;
  now?: number;
  /** Control's own build, which the rig's are compared with (default: this process's). */
  control?: BuildInfo | undefined;
}

/** The rig's row in control's store: when it last reported, its ledger and its last report. */
export interface RigRow {
  id: string;
  last_seen: string;
  ledger_id: string | null;
  summary: unknown;
}

/**
 * What a rig's view reads besides its events: the rig's row, the time it is read at and the
 * windows for stale and offline, the rig's builds against control's, the supervisor's figures, and
 * a RunPod rig's pod.
 */
export interface RigInputs {
  row: RigRow;
  now: number;
  staleAfterMs: number;
  offlineAfterMs?: number | undefined;
  version: RigVersions;
  supervisor: Record<string, unknown> | null;
  runpod: RunpodRigView | undefined;
}

/** What a rig's view reads besides its events, from the store, the clock and control's build. */
export function rigInputs(store: ControlStore, row: RigRow, opts: ViewOptions): RigInputs {
  const now = opts.now ?? Date.now();
  const launched = store.runpod.rig(row.id);
  return {
    row,
    now,
    staleAfterMs: opts.staleAfterMs,
    offlineAfterMs: opts.offlineAfterMs,
    version: rigVersions(store, row.id, opts.control ?? buildInfo()),
    supervisor: store.reportedRigs.supervisor(row.id),
    runpod: launched ? runpodRigView(launched, store.tunnels.get(row.id), now) : undefined,
  };
}

/**
 * A rig's view from its folded events and what else it shows. It never changes the fold: the view
 * is a copy of its own (views/sharing.ts), and what is worked out from a whole run is set on it.
 */
export function readRig(f: FoldedRig, x: RigInputs): RigView {
  const u = x.row;
  const own = ownCopier();
  const runs = own(f.runs);
  // What each lane's trial is doing, from the rig's last report (goal 143).
  const doings = doingsOf(u.summary);
  for (const v of runs) readRun(v, doings);
  const summary = u.summary as
    | {
        jobs?: Record<string, number>;
        hardware?: unknown;
        model?: unknown;
        settings?: unknown;
        gpu_split?: unknown;
      }
    | undefined;
  return {
    id: u.id,
    last_seen: u.last_seen,
    stale: x.now - Date.parse(u.last_seen) > x.staleAfterMs,
    state: reportingState(u.last_seen, x),
    version: x.version,
    ledger_id: u.ledger_id,
    summary: u.summary,
    supervisor: x.supervisor,
    hardware: readHardware(summary?.hardware),
    model: readModelInfo(summary?.model),
    settings: readSettings(summary?.settings),
    gpu_split: readGpuSplit(summary?.gpu_split),
    jobs: summary?.jobs ?? {},
    runs,
    recent: own(f.recent).toReversed(),
    judge: {
      now: own(f.jobs.filter((j) => j.state === "running").at(-1) ?? null),
      queued: own(f.jobs.filter((j) => j.state === "queued")),
      jobs: own(f.jobs.slice(-SHOWN_JOBS)),
    },
    checks: own(f.checks),
    ...(x.runpod ? { runpod: x.runpod } : {}),
  };
}

/** What is worked out from a whole run, set on the view's own copy of it. */
function readRun(v: RunView, doings: Map<string, TrialDoing>): void {
  v.verdicts = {};
  for (const a of v.attempts) {
    const k = a.verdict ?? a.lifecycle;
    v.verdicts[k] = (v.verdicts[k] ?? 0) + 1;
  }
  v.agents.attempts = v.attempts.length;
  v.agents.duplicates = v.attempts.filter((a) => a.lifecycle === "duplicate").length;
  v.directions = runDirections(v);
  v.standing = standingOf(v);
  // A closed run waits for no one (goal 087; the owner, 2026-10-22): the rig refuses approvals
  // of its changes, so none is pending. Each attempt keeps its own lifecycle.
  if (v.status === "closed") v.pending_promotions = [];
  // A promoted, declined or withdrawn change waits no more: only pending ones keep their why.
  for (const id of Object.keys(v.promotion_waits))
    if (!v.pending_promotions.includes(id)) delete v.promotion_waits[id];
  for (const w of Object.values(v.at_work)) Object.assign(w, doings.get(w.trial) ?? {});
}

/** A RunPod rig whose pod is stopped: it can't report, and that is expected, not stale. */
export const podStopped = (u: Pick<RigView, "runpod">): boolean =>
  Boolean(u.runpod?.active && u.runpod.status === "EXITED");
