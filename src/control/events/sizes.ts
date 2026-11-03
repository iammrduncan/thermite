import type { BusMessage } from "../../common/bus/index.ts";
import { EVENT_HEADERS, eventKindOfSubject } from "../../core/link/events.ts";

/**
 * The events' sizes by kind (goal 179), for Metrics' Bus tab: of the messages the `EVENTS` stream
 * stored in the last hour, how many of each kind, their bytes, and the largest with the rig it
 * came from. The apply hands it every message it reads; it keeps one count for each minute, and
 * drops a minute once it is an hour old, so it holds at most an hour of counts whatever comes.
 */

/** How far back the sizes look: the messages the stream stored in the last hour. */
export const EVENT_SIZES_WINDOW_MS = 3_600_000;

const MINUTE = 60_000;

/** One kind's events in the window. */
export interface EventKindSize {
  kind: string;
  events: number;
  bytes: number;
  /** The largest message's bytes, its rig and its place in the stream. */
  largest: number;
  largest_rig: string | null;
  largest_seq: number;
}

export class EventSizes {
  /** Each minute's counts, by the minute's start, then by kind. */
  private readonly minutes = new Map<number, Map<string, EventKindSize>>();

  /** Counts each message stored in the window; one stored before it, or with no time, is not. */
  take(messages: readonly BusMessage[], now = Date.now()): void {
    const from = now - EVENT_SIZES_WINDOW_MS;
    for (const m of messages) {
      const at = m.at ? Date.parse(m.at) : Number.NaN;
      if (!(at >= from)) continue;
      const kind = eventKindOfSubject(m.subject) ?? "other";
      const minute = at - (at % MINUTE);
      const kinds = this.minutes.get(minute) ?? new Map<string, EventKindSize>();
      this.minutes.set(minute, kinds);
      const k = kinds.get(kind) ?? {
        kind,
        events: 0,
        bytes: 0,
        largest: 0,
        largest_rig: null,
        largest_seq: 0,
      };
      kinds.set(kind, k);
      const bytes = m.data.length;
      k.events++;
      k.bytes += bytes;
      if (bytes > k.largest) {
        k.largest = bytes;
        k.largest_rig = m.header(EVENT_HEADERS.rig) ?? null;
        k.largest_seq = m.seq;
      }
    }
    this.drop(now);
  }

  /** Each kind's events in the window, the most bytes first. */
  list(now = Date.now()): EventKindSize[] {
    this.drop(now);
    const all = new Map<string, EventKindSize>();
    for (const kinds of this.minutes.values())
      for (const k of kinds.values()) {
        const a = all.get(k.kind);
        if (!a) {
          all.set(k.kind, { ...k });
          continue;
        }
        a.events += k.events;
        a.bytes += k.bytes;
        if (k.largest > a.largest)
          Object.assign(a, {
            largest: k.largest,
            largest_rig: k.largest_rig,
            largest_seq: k.largest_seq,
          });
      }
    return [...all.values()].sort((a, b) => b.bytes - a.bytes || a.kind.localeCompare(b.kind));
  }

  private drop(now: number): void {
    const from = now - EVENT_SIZES_WINDOW_MS;
    for (const minute of this.minutes.keys())
      if (minute + MINUTE <= from) this.minutes.delete(minute);
  }
}
