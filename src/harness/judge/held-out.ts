import type { EventToRecord } from "../../core/events/bodies.ts";
import {
  HELD_OUT_EVENT_CELLS,
  HELD_OUT_KINDS,
  HELD_OUT_OWNER_WORDS,
  HELD_OUT_WORDS,
  type HeldOutCell,
  type HeldOutKind,
  heldOutKinds,
  heldOutWords,
} from "../../core/held-out.ts";
import type { ArmRun } from "./measure.ts";

export {
  HELD_OUT_KINDS,
  HELD_OUT_OWNER_WORDS,
  HELD_OUT_WORDS,
  type HeldOutCell,
  type HeldOutKind,
  heldOutKinds,
  heldOutWords,
};

/**
 * What a confirmation found on its held-out cells (goal 082), named safely.
 *
 * The owner sees each held-out cell's name, its kind of failure, and the measured value against
 * its threshold where the check gives one. The agents (the lanes, the planner, the teachers) see
 * only that a held-out check failed and its kind, in fixed words. No one gets a held-out cell's
 * inputs, outputs or texts: a run's error output and the kit's check reasons never pass through
 * here, only a kind from a closed list.
 */

/** A held-out record: whether every cell passed, and each cell's result. */
export interface HeldOutResult {
  pass: boolean;
  cells: HeldOutCell[];
}

/**
 * The agents' words when a held-out pass could not finish: an error in the judge's own work (a
 * kit that fails its runs, a tampered build, a lost lease). An error's text can carry a held-out
 * cell's name, parameters or time, so the agents get only these words; the error itself goes to
 * the rig's log, for the owner.
 */
export const HELD_OUT_INFRA = "a held-out check could not finish (an infrastructure failure)";

/**
 * What a hill climb's held-out ratio measures: the change over the champion when higher is better,
 * the champion over the change when lower is better, so a ratio above 1 is always an improvement.
 */
export function heldOutMeasure(metric: string, direction: "max" | "min"): string {
  return direction === "max"
    ? `${metric}, the change's median over the champion's`
    : `${metric}, the champion's median over the change's (lower is better)`;
}

/** Whether a value is on the passing side of a goal's threshold. */
export function meetsThreshold(x: number, op: ">=" | ">" | "<=" | "<", value: number): boolean {
  return op === ">=" ? x >= value : op === ">" ? x > value : op === "<=" ? x <= value : x < value;
}

/** A failed run's kind, from how it failed: never from what it printed. */
export function heldOutKindOf(r: Exclude<ArmRun, { kind: "ok" }>): HeldOutKind {
  switch (r.failure) {
    case "timeout":
      return "timed_out";
    case "memory":
    case "disk":
    case "exit":
      return "crashed";
    case "metric":
      return "non_finite";
    default:
      return "check_failed";
  }
}

/**
 * A held-out record of these cells, with any value that is not a finite number left out: the
 * ledger's JSON has no form for one, and a record must never fail for it.
 */
export function heldOutResult(cells: readonly HeldOutCell[]): HeldOutResult {
  const finite = cells.map(
    (c) =>
      Object.fromEntries(
        Object.entries(c).filter(([, v]) => typeof v !== "number" || Number.isFinite(v)),
      ) as unknown as HeldOutCell,
  );
  return { pass: finite.every((c) => c.ok), cells: finite };
}

/** A held-out record's cells, read back from its detail; [] for a record from before goal 082. */
export function heldOutCellsOf(detail: unknown): HeldOutCell[] {
  const cells = (detail as { cells?: unknown } | null | undefined)?.cells;
  if (!Array.isArray(cells)) return [];
  return cells.filter(
    (c): c is HeldOutCell =>
      !!c && typeof c === "object" && typeof (c as HeldOutCell).cell === "string",
  );
}

/**
 * The owner's event for a held-out record (goal 082): each cell's name, its kind of failure, and
 * its value against its threshold where there is one. It reaches control and the rig's exports;
 * no agent reads events, and the knowledge base does not take this one. Its subject is the
 * attempt, or, for a goal run's champion (goal 086), the run, with `champion_seq`.
 */
export function heldOutEvent(
  job: number,
  run: string,
  subject: string,
  ho: HeldOutResult,
  championSeq?: number,
): EventToRecord {
  return {
    kind: "held_out_checked",
    subject,
    body: {
      run,
      job,
      ...(championSeq !== undefined ? { champion_seq: championSeq } : {}),
      pass: ho.pass,
      cells: ho.cells.slice(0, HELD_OUT_EVENT_CELLS),
      cells_total: ho.cells.length,
    },
  };
}
