import { z } from "zod";
import type { CommandPayloads } from "./commands.ts";
import { MAX_LANES, RIG_ID } from "./ids.ts";

/**
 * The rig's own settings, changed from its Edit page through a signed owner command
 * (rig_settings): which parts run, how many workers at once, a trial's length and turns, how its
 * agent programs run, and the promotion policy. The harness keeps them in its private state, applies them to its loops at
 * once, and reports them; the supervisor applies its own parts (auditor, teachers, review
 * panel) from that report, and control shows them. A part turned off keeps all its data. The GPU
 * split is applied by the broker when the harness starts, so changing it restarts the harness.
 */
export interface RigSettings {
  /** The judge builds and measures; off: changes wait in its queue. */
  judge: boolean;
  /** Workers start trials; off: no new trial starts. */
  workers: boolean;
  /** Trials at the same time. */
  lanes: number;
  /** The planner gives each worker its direction; off: the fixed fallback plan. */
  planner: boolean;
  /** The advisors (in the supervisor), used only where configured. */
  auditor: boolean;
  teachers: boolean;
  review: boolean;
  /** Each run's export when it ends, for the supervisor to push or send; off: none. */
  exports: boolean;
  /** A trial's length when its contract sets none, in minutes; null: none (goal 079). */
  trial_minutes: number | null;
  /** A cap on each trial's turns; null: none. */
  max_turns: number | null;
  /**
   * After how many minutes without a line a trial is quiet, and asks the owner under Needs you
   * (goal 143); null: never. It only shows: nothing ends a trial for it.
   */
  quiet_minutes: number | null;
  /**
   * How long the model check waits for the model's answer, in seconds (goal 150); null: 120. It
   * limits the check only, never a trial or a model call.
   */
  check_seconds: number | null;
  /**
   * How a trial's agent program runs (goal 169): in its own terminal, held by the terminal host
   * (a worker in Pi draws its Pi view there), or headless.
   */
  program_mode: ProgramMode;
  promotion: "auto" | "owner_approval";
  /**
   * On a rig configured with its GPU set (THERMITE_GPUS): how many cards are the judge's; the
   * rest are the agents'. Null: the rig's default. A change restarts the harness to regroup them.
   */
  judge_gpus: number | null;
  /**
   * The rig's runner processes on its other machines (goal 206), each with the pool of each runner
   * it serves, in its order. The core takes a change at once: a runner added joins its pools when
   * it answers, and one taken away fails its run, which the judge tries again and a lane is told
   * of. Empty: the core runs on its own machine alone.
   */
  runners: RunnerSetting[];
}

/**
 * A runner's pool (goal 206): the judge's, one lane's (`lane-2`), shared by the judge and every
 * lane, or the lanes' (goal 229), shared by every lane and never the judge; first come, first
 * served.
 */
export type RunnerPool = "judge" | "shared" | "lanes" | `lane-${number}`;

/** A pool's name: judge, shared, lanes or lane-1 to lane-MAX_LANES. */
const POOL = new RegExp(
  `^(?:judge|shared|lanes|lane-(?:${Array.from({ length: MAX_LANES }, (_, i) => i + 1).join("|")}))$`,
);

/** The most runners one runner process serves, and runner processes one rig has. */
export const RUNNERS_PER_PROCESS = 8;
export const RUNNER_PROCESSES = 16;

/** A runner process of the rig and the pool of each runner it serves, in its order. */
export const RunnerSetting = z.strictObject({
  name: z.string().regex(RIG_ID),
  pools: z
    .array(z.string().regex(POOL, `a pool is judge, shared, lanes or lane-1 to lane-${MAX_LANES}`))
    .min(1)
    .max(RUNNERS_PER_PROCESS),
});
export interface RunnerSetting {
  name: string;
  pools: RunnerPool[];
}

/** A rig's runner processes, each named once. */
export const RunnerSettings = z
  .array(RunnerSetting)
  .max(RUNNER_PROCESSES)
  .refine((l) => new Set(l.map((r) => r.name)).size === l.length, "a runner process is named once");

/** How a trial's agent program may run: in its own terminal UI, or headless. */
export const PROGRAM_MODES = ["terminal", "headless"] as const;
export type ProgramMode = (typeof PROGRAM_MODES)[number];

/**
 * A rig's mode until someone sets one: the terminal, the owner's choice where a program can run
 * one (2026-10-26); headless is an advanced option. A rig's settings file keeps only what someone
 * set, so every rig nobody set follows this default. A harness that reports no mode is older than
 * the terminal mode and runs headless (control's readSettings).
 */
export const PROGRAM_MODE_DEFAULT: ProgramMode = "terminal";

/** The rig_settings payload: only the fields that change. */
export type RigSettingsChange = z.infer<(typeof CommandPayloads)["rig_settings"]>;
