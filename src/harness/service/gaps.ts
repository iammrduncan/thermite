import { log } from "../../common/log.ts";
import type { Ledger } from "../ledger/index.ts";

/**
 * Time the harness did not run: the host slept, its container was paused or stopped, or it
 * crashed. Its agents could not work then, so a research run's clock leaves it out, as it leaves
 * out a drain (research/blocked.ts). Nothing else records it: the run stays `running` meanwhile,
 * and a wait for a rate limit ends at the time it named, however long the harness stood still.
 * The ledger keeps each gap as `harness_gap`, from the last moment the harness is known to have
 * run to the moment it ran again.
 */

/** How often the harness notes that it runs: the period of its `awake` loop. */
export const AWAKE_EVERY_MS = 10_000;

/**
 * The shortest gap recorded. A shorter one counts as running time: a busy moment or a quick
 * restart is no reason to stop a run's clock, and a gap this long is no busy moment.
 */
export const GAP_MIN_MS = 2 * 60_000;

/** Records the gap from `since` to `until`. */
function record(ledger: Ledger, since: number, until: number, restarted: boolean): void {
  const gap = {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    restarted,
  };
  ledger.appendEvent("harness", "harness_gap", null, gap);
  log("harness", "the harness did not run for a while: research clocks leave it out", gap);
}

/**
 * The harness's note of when it last ran, which the `awake` loop keeps (controller/loops.ts). The
 * loop's timer comes around every `AWAKE_EVERY_MS` while the harness runs. When the host sleeps or
 * the container is paused, it stops with everything else, and its next round finds the time
 * jumped: that time is a gap.
 */
export class AwakeWatch {
  private readonly ledger: Ledger;
  private last: number;
  constructor(ledger: Ledger, now: number) {
    this.ledger = ledger;
    this.last = now;
  }

  /** The harness runs at `now`. True when it recorded a gap since its last note. */
  note(now: number): boolean {
    const since = this.last;
    this.last = now;
    if (now - since < GAP_MIN_MS) return false;
    record(this.ledger, since, now, false);
    return true;
  }
}

/**
 * At start: the time since the ledger's newest event is a gap, when it is long enough. That event
 * is the last moment the harness is known to have run: a stop records its trials' end, and a run
 * at work records its agents' calls. Call it before anything else records an event at start.
 */
export function gapAtStart(ledger: Ledger, now: number): boolean {
  const last = ledger.events.lastAt();
  if (last === undefined) return false;
  const since = Date.parse(last);
  if (Number.isNaN(since) || now - since < GAP_MIN_MS) return false;
  record(ledger, since, now, true);
  return true;
}

/** When the harness did not run, oldest first: each `harness_gap`'s span. */
export function gapSpans(ledger: Ledger): [number, number][] {
  return ledger.events
    .list("harness_gap")
    .map((e): [number, number] => [Date.parse(e.body.since), Date.parse(e.body.until)]);
}
