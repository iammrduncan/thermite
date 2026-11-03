/**
 * A rig on RunPod as control's API answers it (control/runpod/: the routes in owner.ts), with the
 * stop, start, restart or terminate under way on it: what control keeps and what the command line
 * reads.
 */

export type OpKind = "stop" | "start" | "restart" | "terminate";
export type OpPhase = "quiescing" | "exporting" | "leaving" | "stopping" | "starting";
/** Why control stops a pod: a limit the owner set, or the owner (or a restart) asked. */
export type StopWhy = "spend_limit" | "idle_stop" | "owner";

/** A change under way on a RunPod rig. */
export interface RigOp {
  kind: OpKind;
  /** Who asked: the owner's channel (owner:api, owner:mcp), or control for a limit. */
  by: string;
  why: StopWhy | null;
  phase: OpPhase;
  at: string;
  phase_at: string;
  /** The export_now command it issued, and the export that came of it. */
  command: string | null;
  export: string | null;
  /** The runs it paused. */
  paused: string[];
  /** What a start is for, in words, when a run's assignment started it ("to assign run x"). */
  note?: string | null | undefined;
}

/**
 * A rig the owner launched on a GPU cloud, as control keeps it (control/runpod/rigs.ts): what it was
 * launched with, its pod as control last saw it, its price, what it has cost, and the owner's
 * spend limit and idle stop. Neither has a default today: each applies only when the owner set
 * it (control/runpod/rigs.ts's DEFAULT_IDLE_STOP_MINUTES keeps the idle stop's default: none).
 */
export interface RigState {
  image: string;
  /** RunPod's id of the GPU type, and its name. */
  gpu: string;
  gpu_name: string;
  gpu_count: number;
  cloud_type: "SECURE" | "COMMUNITY";
  /** The data center asked for, or the one RunPod chose (null until it says). */
  datacenter: string | null;
  container_disk_gb: number;
  volume_gb: number;
  /** USD per hour for the whole pod: RunPod's price for it, else the GPU's list price. */
  price_per_hr: number | null;
  /** The pod's status at RunPod as control last read it (RUNNING, EXITED, ...). */
  status: string;
  status_at: string | null;
  launched_at: string;
  /** What the pod cost up to billed_since, in USD, at the prices control saw. */
  spent_usd: number;
  /** Since when it runs and costs price_per_hr; null while it is stopped. */
  billed_since: string | null;
  /** Since when it runs without a break (its idle time counts from here at the earliest). */
  running_since: string | null;
  /** The owner's limits; null: none. */
  spend_limit_usd: number | null;
  idle_stop_minutes: number | null;
  /** When the idle stop was set: idle time counts from here at the earliest. */
  idle_from: string | null;
  /** The last time a run was at work on the rig, as control saw it (control/runpod/rigs.ts's lastWork). */
  busy_at: string | null;
  /** A run was at work on the rig at control's last check: no idle time counts now. */
  at_work?: boolean | undefined;
  /** When control stopped the pod, and why: a limit the owner set, or the owner's stop. */
  stopped_at: string | null;
  stopped_by: "spend_limit" | "idle_stop" | "owner" | null;
  /** When RunPod no longer had the pod. */
  ended_at: string | null;
  /** What went wrong at control's last read of the pod, in words; the next good read clears it. */
  error: string | null;
  /**
   * A change control refused (a terminate that could not go on), in words, and how many steps the
   * rig's history had then. It stays until the owner's next stop, start, restart or terminate, or
   * until a newer step in the rig's history (a full reset, say).
   */
  refusal?: { words: string; steps: number } | null | undefined;
  notes: string[];
  /** The stop, start, restart or terminate under way (control/runpod/lifecycle.ts); null: none. */
  op?: RigOp | null | undefined;
  /** The runs the last stop paused: the next start resumes them. */
  paused_runs?: string[] | undefined;
  /** The export the last stop made, and whether it had left the pod when the pod stopped. */
  last_export?: string | null | undefined;
  last_export_left?: boolean | undefined;
}

export interface RunpodRigView extends Omit<RigState, "refusal"> {
  /** What went wrong last, in words: the last read's error, else the refusal while it stays. */
  error: string | null;
  /** The change control refused last, in words, while it stays (RigState's refusal). */
  refusal: string | null;
  rig: string;
  cloud: string;
  pod: string;
  /** Control still follows the pod. */
  active: boolean;
  created_by: string;
  /** What the pod has cost so far, in USD, to the cent; null without a price. */
  spend_usd: number | null;
  /** When the pod enrolled with control (pull mode); null: not yet. */
  enrolled_at: string | null;
  /**
   * Where control's bus reaches the pod's leaf node: the public address and port RunPod gives it
   * while the pod runs; null while it has none, or for a pod launched without the leaf.
   */
  bus_leaf: string | null;
  /**
   * Since when the rig counts as idle for the idle stop (idleSince); null without an idle stop,
   * before enrollment, while the pod is not running, or while a run is at work on it.
   */
  idle_since: string | null;
  /** The change under way in words (opWords); null: none. */
  op_words: string | null;
}
