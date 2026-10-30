import type { ChildProcess } from "node:child_process";
import { errorText } from "../../common/errors.ts";
import { log, logWarn } from "../../common/log.ts";
import { HEALTH_URLS } from "../../core/health.ts";

/**
 * The one-container rig image's health check (goal 173). Compose, a machine's units and a cluster's
 * kubelet check each part's health route; nothing does on a RunPod pod, so the broker asks each
 * part's route itself, as those checks do: every 30 s, with 5 s for the answer (healthProbe's
 * rule). A part that answers other than 2xx (503: one of its loops is late) or not at all three
 * times in a row is ended, its whole process group, as a machine rig's unit ends it; its exit
 * handler then starts it again, with the broker's restart backoff.
 */
export const HEALTH_WATCH = { everyMs: 30_000, answerMs: 5_000, failures: 3 } as const;

/**
 * Each part the broker watches: its route, and how long it may take to start, as a cluster's
 * startup probes allow (the harness runs its isolation check before it listens). Until a part
 * first answers 2xx, its failures count only once that time is over.
 */
export const WATCHED = {
  controller: { url: HEALTH_URLS.harness, startMs: 10 * 60_000 },
  supervisor: { url: HEALTH_URLS.supervisor, startMs: 5 * 60_000 },
} as const;

export interface WatchOptions {
  /** The part, as the broker's log names it. */
  part: string;
  /** Its health route. */
  url: string;
  /** How long it may take to start (WATCHED). */
  startMs: number;
  /** True once the broker stops: the watch ends then, and ends no part. */
  stopping: () => boolean;
  /** How often it is asked: HEALTH_WATCH.everyMs, or less in a test. */
  everyMs?: number;
}

/**
 * Watches a part the broker has just started, from now until it exits, and ends its process
 * group (SIGKILL) after HEALTH_WATCH.failures failures in a row. Each failure that counts is
 * logged with why, and so is the end.
 */
export function watchHealth(proc: ChildProcess, o: WatchOptions): void {
  const pid = proc.pid;
  // It never started: its own error handler says so, and starts it again.
  if (pid === undefined) return;
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
    const failure = await ask(o.url);
    if (over) return;
    if (o.stopping()) {
      end();
      return;
    }
    if (failure === undefined) {
      if (!answered) log("broker", `watching the ${o.part}'s health route`, { url: o.url });
      answered = true;
      failures.length = 0;
    } else if (answered || Date.now() - startedAt >= o.startMs) {
      failures.push(failure);
      logWarn("broker", `the ${o.part}'s health route failed`, {
        url: o.url,
        why: failure,
        in_a_row: failures.length,
        ends_it_at: HEALTH_WATCH.failures,
      });
      if (failures.length >= HEALTH_WATCH.failures) {
        end();
        logWarn("broker", `the ${o.part} is unhealthy: ending it to start it again`, {
          url: o.url,
          failures,
        });
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // the group is already gone
        }
        return;
      }
    }
    next();
  };
  next();
}

/** Asks a health route once: undefined for a 2xx answer in time, otherwise why it failed. */
async function ask(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_WATCH.answerMs) });
    await res.body?.cancel();
    if (res.ok) return undefined;
    return res.status === 503 ? "answered 503: one of its loops is late" : `answered ${res.status}`;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError")
      return `no answer within ${HEALTH_WATCH.answerMs / 1000} s`;
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return `no answer: ${typeof code === "string" ? code : errorText(err)}`;
  }
}
