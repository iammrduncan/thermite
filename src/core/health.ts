import { z } from "zod";

/**
 * What a part says about its health (goal 173): each of its long-running loops, with the time
 * since it last came around, the limit past which it is late, and the work it waits on when that
 * work has no time limit of its own (a judge's job, the planner's call). A part answers its health
 * route with these, 503 when a loop is late; a rig's report and its supervisor's figures carry
 * them to control, whose `/metrics` gives them. And a rig's disk against its floor, as its report
 * gives it.
 */

/** One loop, as a health answer gives it. */
export const LoopAge = z.object({
  /** Seconds since it last came around. */
  age_seconds: z.number().min(0),
  /** Late after this many seconds. */
  limit_seconds: z.number().min(0),
  late: z.boolean(),
  /** The work it waits on that has no time limit: it is never late meanwhile. */
  busy: z.string().max(200).optional(),
});
export type LoopAge = z.infer<typeof LoopAge>;

/** A part's loops by name: at most a few dozen (a judge's loop for each card, up to 8). */
export const LoopAges = z.record(z.string().max(64), LoopAge);
export type LoopAges = z.infer<typeof LoopAges>;

/** A health route's answer: `ok` false (and status 503) when a loop is late. */
export const HealthAnswer = z.looseObject({ ok: z.boolean(), loops: LoopAges.optional() });

/**
 * A loop is late after ten of its periods, and never before 30 minutes: a round that pushes an
 * export, uploads one or copies the ledger must have time to end, and a probe that restarts a busy
 * part is worse than one that waits. The limit is mechanical: a judge's job and the planner's call,
 * whose length is research's, are never counted (`busy`).
 */
export const LATE_AFTER_PERIODS = 10;
export const LATE_AFTER_AT_LEAST_MS = 30 * 60_000;

/** The limit of a loop that comes around every `periodMs`. */
export const loopLimitMs = (periodMs: number): number =>
  Math.max(LATE_AFTER_PERIODS * periodMs, LATE_AFTER_AT_LEAST_MS);

/**
 * The check a deployment runs inside a part's container: `node -e` with this program, which asks
 * the part's health route and exits 0 only on a 2xx answer within 5 seconds. Compose, the release
 * bundle and the machines' units run it; Kubernetes asks the harness's route itself.
 */
export const healthProbe = (url: string): string =>
  `fetch('${url}',{signal:AbortSignal.timeout(5000)}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))`;

/** Where each part answers its health route inside its container. */
export const HEALTH_URLS = {
  control: "http://127.0.0.1:8800/v1/health",
  harness: "http://127.0.0.1:8700/v1/health",
  supervisor: "http://127.0.0.1:8701/v1/health",
} as const;

/** The supervisor's health route's address by default: its own container only. */
export const SUPERVISOR_HEALTH_LISTEN = "127.0.0.1:8701";

/**
 * A rig's disk against its floor (THERMITE_DISK_FLOOR_GIB), as its report's summary carries it
 * (`disk`): each place the harness writes to, with its free and total space, and since when the
 * rig holds new work for it.
 */
export interface RigDisk {
  /** The floor, in GiB; 0: none. */
  floor_gib: number;
  /** A place has less free space than the floor: no new trial, judge's job or export starts. */
  low: boolean;
  /** When it reached the floor; null while it is above. */
  since: string | null;
  checked_at: string;
  places: { name: string; free_gib: number; total_gib: number }[];
}
