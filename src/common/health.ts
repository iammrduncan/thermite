import type { ChildProcess } from "node:child_process";
import { type LoopAges, loopLimitMs } from "../core/health.ts";
import { errorText } from "./errors.ts";
import { log, logError, logWarn } from "./log.ts";

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
    {
      limitMs: number;
      last: number;
      busy?: (() => string | undefined) | undefined;
      /** Which add it was, so that a loop that ends removes only its own. */
      added: number;
    }
  >();
  private adds = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * A loop to watch, counted from now: it comes around every `periodMs` and is late past its
   * limit. `busy` says what it waits on now, when that work has no time limit.
   */
  add(name: string, periodMs: number, busy?: () => string | undefined): number {
    const added = ++this.adds;
    this.loops.set(name, { limitMs: loopLimitMs(periodMs), last: this.now(), busy, added });
    return added;
  }

  /**
   * A loop that ended for good, such as the judge's on a runner that left the rig: not watched.
   * `added`: only if it is still that add's, not a loop of the same name added since.
   */
  remove(name: string, added?: number): void {
    if (added === undefined || this.loops.get(name)?.added === added) this.loops.delete(name);
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

/**
 * How a part that runs another as its child watches the child's health (goal 173), where nothing
 * outside does: the one-container rig image's broker watches its controller and its supervisor
 * (harness/broker/watch.ts), and a RunPod pod's supervisor its pod's own bus server
 * (supervisor/leaf.ts). It asks every 30 s and gives the answer 5 s, as the deployments' health
 * checks do (core/health.ts's healthProbe); three failures in a row end the child, whose exit
 * handler starts it again.
 */
export const HEALTH_WATCH = { everyMs: 30_000, answerMs: 5_000, failures: 3 } as const;

interface PartWatch {
  /** Who watches, as the log names it ("broker", "supervisor"). */
  component: string;
  /** The child, as the log names it ("supervisor", "pod's bus server"). */
  part: string;
  /** What is asked, as the log names it ("health route", "sign-in check"). */
  check: string;
  /** Where it is asked, for the log ({url}, {bus}). */
  where: Record<string, unknown>;
  /** Asks once: undefined for a good answer in time, otherwise why it failed, in words. */
  probe: () => Promise<string | undefined>;
  /**
   * How long the child may take to start: until its first good answer, its failures count only
   * once this time is over.
   */
  startMs: number;
  /** True once the watcher stops: the watch ends then, and ends no child. */
  stopping: () => boolean;
  /** Ends the child (SIGKILL: to itself, or to its process group). */
  end: () => void;
  /** How often it is asked: HEALTH_WATCH.everyMs, or less in a test. */
  everyMs?: number | undefined;
}

/**
 * Watches a child just started, from now until it exits, and ends it after HEALTH_WATCH.failures
 * failures in a row. Each failure that counts is logged with why, and so is the end. The timer
 * never keeps the process alive.
 */
export function watchPart(proc: ChildProcess, o: PartWatch): void {
  // It never started: its own error handler says so, and starts it again.
  if (proc.pid === undefined) return;
  const everyMs = o.everyMs ?? HEALTH_WATCH.everyMs;
  const startedAt = Date.now();
  let answered = false;
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failures: string[] = [];
  const end = () => {
    over = true;
    clearTimeout(timer);
  };
  proc.once("exit", end);
  const next = () => {
    timer = setTimeout(() => void round(), everyMs);
    timer.unref();
  };
  const round = async () => {
    const failure = await o.probe();
    if (over) return;
    if (o.stopping()) {
      end();
      return;
    }
    if (failure === undefined) {
      if (!answered) log(o.component, `watching the ${o.part}'s ${o.check}`, o.where);
      answered = true;
      failures.length = 0;
    } else if (answered || Date.now() - startedAt >= o.startMs) {
      failures.push(failure);
      logWarn(o.component, `the ${o.part}'s ${o.check} failed`, {
        ...o.where,
        why: failure,
        in_a_row: failures.length,
        ends_it_at: HEALTH_WATCH.failures,
      });
      if (failures.length >= HEALTH_WATCH.failures) {
        end();
        logWarn(o.component, `the ${o.part} is unhealthy: ending it to start it again`, {
          ...o.where,
          failures,
        });
        o.end();
        return;
      }
    }
    next();
  };
  next();
}
