import type { SSEStreamingApi } from "hono/streaming";
import type { ControlStore } from "../../store/index.ts";

/**
 * The Live pages' push (goal 168, step 2): control sends a page each new line of what it shows as
 * a server-sent event, as soon as control has the line from the message bus.
 * The page needs no poll, and the browser connects again on its own after a drop, from the last
 * line it has (its Last-Event-ID). A reader that falls behind, with more lines waiting than one
 * event carries, keeps what it shows: it gets the newest lines, and is told how many it missed.
 */

/**
 * The most lines one event carries. A reader with more waiting than this has fallen behind: it
 * gets the newest this many, and a count of the rest.
 */
export const LIVE_PUSH_LINES = 500;
/**
 * How often a quiet push says it is still there (a `beat` event, by which the page shows when it
 * last heard from control), so that nothing between control and the browser closes it as idle; and
 * draws again the lines that wait for their event.
 */
export const LIVE_PUSH_BEAT_MS = 15_000;
/** How soon the browser connects again after the push ends. */
export const LIVE_PUSH_RETRY_MS = 3_000;
/** How many lines that wait for their event one push follows, at most: the newest. */
const RECHECK_MAX = 50;

/** One line as the page's script adds it: its id and HTML, and what else the script reads. */
export type PushedLine = { id: number; html: string } & Record<string, unknown>;

/** What a push reads: one view's lines of one rig, drawn as its page draws them. */
export interface LiveFeed {
  rig: string;
  /** The view's lines after `after`, oldest first, `limit` at most. */
  after(after: number, limit: number): PushedLine[];
  /** The view's newest `limit` lines, oldest first. */
  newest(limit: number): PushedLine[];
  /** How many lines of the view there are after `after`. */
  count(after: number): number;
  /** Of these lines, drawn while they waited for their event, the ones that wait no more. */
  redraw?(ids: number[]): { id: number; html: string }[];
}

/** A line id from a request, or 0 for none: a whole number at least 0. */
const lineId = (v: string | undefined) => Math.max(0, Math.trunc(Number(v ?? "0")) || 0);

/**
 * Where a reader starts: after the last line it has. A browser that connects again names it
 * (Last-Event-ID); the page's first connection, in `after`.
 */
export function pushStart(lastEventId: string | undefined, after: string | undefined): number {
  return lastEventId ? lineId(lastEventId) : lineId(after);
}

/** The ids of the lines a page drew waiting for their event, from its request: the newest few. */
export function recheckIds(raw: string | undefined): number[] {
  return String(raw ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(-RECHECK_MAX);
}

/** Sends the lines after `after`; a reader too far behind gets the newest and a count. */
async function sendNew(
  stream: SSEStreamingApi,
  feed: LiveFeed,
  after: number,
  waiting: Set<number>,
): Promise<number> {
  const n = feed.count(after);
  if (!n) return after;
  const behind = n > LIVE_PUSH_LINES;
  const lines = behind ? feed.newest(LIVE_PUSH_LINES) : feed.after(after, LIVE_PUSH_LINES);
  const last = lines.at(-1);
  if (!last) return after;
  if (behind)
    await stream.writeSSE({ event: "missed", data: JSON.stringify({ lines: n - lines.length }) });
  for (const l of lines) if (l.html.includes('data-recheck="1"')) waiting.add(l.id);
  for (const id of waiting) {
    if (waiting.size <= RECHECK_MAX) break;
    waiting.delete(id);
  }
  await stream.writeSSE({
    event: "lines",
    id: String(last.id),
    data: JSON.stringify({ entries: lines }),
  });
  return last.id;
}

/** Sends again the waiting lines whose event has come. */
async function sendRedrawn(stream: SSEStreamingApi, feed: LiveFeed, waiting: Set<number>) {
  if (!waiting.size || !feed.redraw) return;
  const redrawn = feed.redraw([...waiting]);
  for (const r of redrawn) waiting.delete(r.id);
  if (redrawn.length)
    await stream.writeSSE({ event: "redrawn", data: JSON.stringify({ redrawn }) });
}

/**
 * Pushes a view's new lines to one reader until it goes: those after `after` at once, then each
 * time the store has new lines of the rig. `recheck`: lines the page drew waiting for their event.
 * `beatMs`: LIVE_PUSH_BEAT_MS unless a test gives a shorter one.
 */
export async function pushLive(
  stream: SSEStreamingApi,
  store: ControlStore,
  feed: LiveFeed,
  o: { after: number; recheck: number[]; beatMs?: number | undefined },
): Promise<void> {
  let after = o.after;
  const waiting = new Set(o.recheck);
  let fresh = true;
  let wake: (() => void) | undefined;
  const stop = store.liveLines.watch((rig) => {
    if (rig !== feed.rig) return;
    fresh = true;
    wake?.();
  });
  stream.onAbort(() => wake?.());
  try {
    await stream.write(`retry: ${LIVE_PUSH_RETRY_MS}\n\n`);
    while (!stream.aborted && !stream.closed) {
      if (fresh) {
        fresh = false;
        after = await sendNew(stream, feed, after, waiting);
        await sendRedrawn(stream, feed, waiting);
        continue;
      }
      const beat = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), o.beatMs ?? LIVE_PUSH_BEAT_MS);
        wake = () => {
          clearTimeout(timer);
          resolve(false);
        };
      });
      wake = undefined;
      if (!beat || stream.aborted) continue;
      await stream.writeSSE({ event: "beat", data: "" });
      await sendRedrawn(stream, feed, waiting);
    }
  } finally {
    stop();
  }
}
