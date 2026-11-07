/**
 * Target drivers connect the judge to whatever a campaign measures on: a GPU, a CPU set, a board.
 * They identify the target, say whether it is ready for timing, and record its state. The work
 * itself runs through the broker, which owns the clock: nothing the candidate prints is the
 * score of record.
 */

export interface TargetIdentity {
  type: string;
  class: string;
  /** Stable identity used as the comparability key (never compare across different ids). */
  id: string;
  details: Record<string, unknown>;
}

export interface Readiness {
  ready: boolean;
  reasons: string[];
  details: Record<string, unknown>;
}

/** A target's use now (goal 231). */
export interface TargetUse {
  util_pct: number;
  mem_used_mib: number | null;
  mem_total_mib: number | null;
}

export interface TargetDriver {
  readonly type: string;
  identify(): Promise<TargetIdentity>;
  /** Idle, healthy and at expected settings: required before every timed block. */
  readyForTiming(): Promise<Readiness>;
  envSnapshot(): Promise<Record<string, unknown>>;
  /**
   * How busy the target is now, for the rig's page (goal 231): a GPU's use and memory, as
   * nvidia-smi gives them; a memory it can't give (a GPU that shares the machine's) is null.
   * Undefined: a target that can't say.
   */
  use?(): Promise<TargetUse | undefined>;
  /**
   * Problems that make the block just measured invalid (for a GPU: throttling or thermal events,
   * overheating). Checked after every block; an empty list means the block stands.
   */
  afterBlock(): Promise<string[]>;
  /** Physical-limit checks; returns problems (empty when plausible). */
  plausibility(metrics: Record<string, number>): string[];
  recover(): Promise<Readiness>;
}
