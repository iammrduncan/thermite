import { createHash } from "node:crypto";
import type { AppendEvent } from "../../core/events/bodies.ts";
import type { LiveEntry } from "../../core/live.ts";
import { type ReplyNow, SAME_ANSWER } from "../agents/index.ts";

/**
 * What each open trial is doing, for the owner and the teachers (goal 143): when it last sent a
 * line, its open model call as a Pi worker reports it, and a streak of the same calls. On the lab
 * a trial sent nothing for more than four hours, and another repeated the same tool calls for
 * twenty minutes; the run's page said only "at work since". The watch reads every live line of
 * every trial, whatever its harness, and keeps all of it in memory: a restart interrupts the
 * trials it watches. It only shows: nothing here ends a trial.
 */

/** How many repeated calls in a row make a streak worth saying: a reporting threshold, not a cap. */
export const REPEAT_STREAK = 10;
/** The most different calls a trial's watch remembers; past it, the oldest go. */
const SEEN_MAX = 2000;
/** The most different calls a streak lists, the most repeated first. */
const STREAK_CALLS = 5;
/** The longest call a streak's list quotes, in characters. */
const CALL_CHARS = 300;

export type { ReplyNow };

export interface TrialFacts {
  /** When it last sent a line: its agent's, or the harness's about it. Null: none yet. */
  last_line_at: string | null;
  /** Its open model call, with when the worker last reported it; null: none open, or not Pi. */
  reply: (ReplyNow & { reported_at: string }) | null;
  /**
   * The streak of the same calls it is in, once it reaches REPEAT_STREAK: how many repeated
   * calls, since when, how many different calls, and the most repeated. Null: none.
   */
  repeating: {
    count: number;
    since: string;
    different: number;
    calls: { call: string; times: number }[];
  } | null;
}

/** A streak said once when it reaches REPEAT_STREAK, and once when it ends. */
export type StreakNews =
  | {
      kind: "repeating";
      trial: string;
      count: number;
      different: number;
      calls: { call: string; times: number }[];
    }
  | { kind: "stopped_repeating"; trial: string; count: number };

interface Watched {
  lastLineAt: string | null;
  reply: TrialFacts["reply"];
  /** The tool call waiting for its answer line. */
  pending: string | null;
  /** By call, the hash of the answer it got. */
  seen: Map<string, string>;
  streak: { count: number; since: string; calls: Map<string, number> } | null;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** An answer line without its time: Pi writes `read_file (12 ms): …`. */
const answerOf = (text: string) => text.replace(/^\S+( failed)? \(\d+(\.\d+)? ?m?s\): /, "");

export class TrialWatch {
  private readonly trials = new Map<string, Watched>();

  private of(trial: string): Watched {
    let w = this.trials.get(trial);
    if (!w) {
      w = { lastLineAt: null, reply: null, pending: null, seen: new Map(), streak: null };
      this.trials.set(trial, w);
    }
    return w;
  }

  /** A live line: a trial's line counts, its tool calls and their answers make streaks. */
  saw(e: Pick<LiveEntry, "source" | "kind" | "text" | "at">): StreakNews | undefined {
    if (!e.source.startsWith("trial:")) return undefined;
    const trial = e.source.slice("trial:".length);
    const w = this.of(trial);
    w.lastLineAt = e.at;
    if (e.kind === "tool") {
      w.pending = e.text;
      return undefined;
    }
    if (e.kind !== "result" || w.pending === null) return undefined;
    const call = w.pending;
    w.pending = null;
    const answer = answerOf(e.text);
    const h = hash(answer);
    const repeat = answer.startsWith(SAME_ANSWER) || w.seen.get(call) === h;
    if (!repeat) {
      w.seen.delete(call);
      w.seen.set(call, h);
      if (w.seen.size > SEEN_MAX) w.seen.delete(w.seen.keys().next().value as string);
      const ended = w.streak && w.streak.count >= REPEAT_STREAK ? w.streak.count : undefined;
      w.streak = null;
      return ended !== undefined ? { kind: "stopped_repeating", trial, count: ended } : undefined;
    }
    w.streak ??= { count: 0, since: e.at, calls: new Map() };
    w.streak.count++;
    w.streak.calls.set(call, (w.streak.calls.get(call) ?? 0) + 1);
    return w.streak.count === REPEAT_STREAK
      ? {
          kind: "repeating",
          trial,
          count: w.streak.count,
          different: w.streak.calls.size,
          calls: streakCalls(w.streak.calls),
        }
      : undefined;
  }

  /** A Pi worker's report of its open model call; null: the call ended. */
  reply(trial: string, r: ReplyNow | null, at: string): void {
    this.of(trial).reply = r ? { ...r, reported_at: at } : null;
  }

  /** A compaction: the agent may ask again for what it no longer holds. Not a repeat. */
  compacted(trial: string): void {
    const w = this.trials.get(trial);
    if (!w) return;
    w.seen.clear();
    w.streak = null;
  }

  facts(trial: string): TrialFacts {
    const w = this.trials.get(trial);
    const s = w?.streak;
    return {
      last_line_at: w?.lastLineAt ?? null,
      reply: w?.reply ?? null,
      repeating:
        s && s.count >= REPEAT_STREAK
          ? { count: s.count, since: s.since, different: s.calls.size, calls: streakCalls(s.calls) }
          : null,
    };
  }

  /** A trial ended: nothing of it is kept. */
  forget(trial: string): void {
    this.trials.delete(trial);
  }
}

function streakCalls(calls: Map<string, number>): { call: string; times: number }[] {
  return [...calls]
    .sort((a, b) => b[1] - a[1])
    .slice(0, STREAK_CALLS)
    .map(([call, times]) => ({
      call: call.length > CALL_CHARS ? `${call.slice(0, CALL_CHARS)}…` : call,
      times,
    }));
}

/**
 * A streak's news, from the line that made it (`e`): when it reaches REPEAT_STREAK, a
 * `trial_repeating` event for the owner and the teachers, and a line in the trial's Live; when it
 * ends, a line in Live.
 */
export function tellStreak(
  news: StreakNews | undefined,
  e: Pick<LiveEntry, "source" | "lane" | "run">,
  ledger: { appendEvent: AppendEvent },
  live: {
    append(line: {
      source: string;
      kind: "status";
      text: string;
      lane?: string;
      run?: string;
    }): void;
  },
): void {
  if (!news) return;
  const where = {
    source: e.source,
    ...(e.lane ? { lane: e.lane } : {}),
    ...(e.run ? { run: e.run } : {}),
  };
  if (news.kind === "stopped_repeating") {
    live.append({
      ...where,
      kind: "status",
      text: `stopped repeating the same calls after ${news.count}.`,
    });
    return;
  }
  ledger.appendEvent("harness", "trial_repeating", e.run ?? null, {
    trial: news.trial,
    lane: e.lane ?? null,
    count: news.count,
    different: news.different,
    calls: news.calls,
  });
  const calls = news.calls.map((c) => `${c.call.slice(0, 100)} ×${c.times}`).join("; ");
  live.append({
    ...where,
    kind: "status",
    text: `repeats the same calls: ${news.count} in a row, each with the same answer as before, ${news.different} different (${calls}). The trial goes on: stop it from the run's page if it is stuck.`,
  });
}
