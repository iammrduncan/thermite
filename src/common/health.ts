import { type LoopAges, loopLimitMs } from "../core/health.ts";
import { errorText } from "./errors.ts";
import { logError } from "./log.ts";

/**
 * A part's long-running loops and when each last came around (goal 173). Each loop ticks once a
 * round; the part's health route answers with each loop's age and 503 when one is past its limit
 * (core/health.ts says how a limit follows from the loop's period). A loop that waits on work with
 * no time limit of its own, such as a judge's job or the planner's call, says so (`busy`) and is
 * not late meanwhile.
 */
export class Loops {
  private readonly loops = new Map<
    string,
    { limitMs: number; last: number; busy?: (() => string | undefined) | undefined }
  >();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * A loop to watch, counted from now: it comes around every `periodMs` and is late past its
   * limit. `busy` says what it waits on now, when that work has no time limit.
   */
  add(name: string, periodMs: number, busy?: () => string | undefined): void {
    this.loops.set(name, { limitMs: loopLimitMs(periodMs), last: this.now(), busy });
  }

  /** The loop came around. A loop must be added before it ticks: one that is not is a bug. */
  tick(name: string): void {
    const l = this.loops.get(name);
    if (!l) throw new Error(`no loop named ${name} is watched`);
    l.last = this.now();
  }

  /** Each loop's age and limit, and whether every one is in time. */
  health(): { ok: boolean; loops: LoopAges } {
    const now = this.now();
    const loops: LoopAges = {};
    let ok = true;
    for (const [name, l] of this.loops) {
      const age = Math.max(0, now - l.last);
      const busy = l.busy?.();
      const late = !busy && age > l.limitMs;
      if (late) ok = false;
      loops[name] = {
        age_seconds: Math.round(age / 1000),
        limit_seconds: Math.round(l.limitMs / 1000),
        late,
        ...(busy ? { busy } : {}),
      };
    }
    return { ok, loops };
  }
}

/**
 * Runs `round` every `periodMs` as a loop that `loops` watches: each round that ends, well or not,
 * ticks it. Rounds may overlap, as with setInterval: a round that hangs holds no later one, and the
 * loop is late only when none ends. A round catches its own errors; one it leaves is logged here,
 * by the part's `component`. The timer never keeps the process alive.
 */
export function every(
  loops: Loops,
  component: string,
  name: string,
  periodMs: number,
  round: () => unknown,
): ReturnType<typeof setInterval> {
  loops.add(name, periodMs);
  const timer = setInterval(() => {
    void Promise.resolve()
      .then(round)
      .finally(() => loops.tick(name))
      .catch((err) =>
        logError(component, "a loop's round failed", { loop: name, error: errorText(err) }),
      );
  }, periodMs);
  timer.unref?.();
  return timer;
}
