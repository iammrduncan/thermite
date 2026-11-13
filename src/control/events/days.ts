import type { Bus, BusMessage } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import {
  EVENT_HEADERS,
  EVENT_STREAM,
  purgeSubjectOf,
  readEventMessage,
} from "../../core/link/events.ts";
import type { RetentionItem } from "../../core/retention/index.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * What control keeps of its rigs' events, by day, for a retention policy of control's copy of
 * them (goal 125, T12): for each subject a purge names (a run's, or a rig's own: purgeSubjectOf),
 * each rig and each day it was stored, its first and last place in the `EVENTS` stream, how many
 * events and their bytes. The apply of the stream fills it as it reads every message (apply.ts),
 * from the stream's first at control's start, so it holds what the stream holds; and the runs
 * still open, from their `run_created` and `run_status` events. A purge removes a subject's
 * messages before a place, so a policy removes whole days of a subject, oldest first, and records
 * each rig ledger's floor: the last event removed on purpose (store/retention.ts).
 */

/** One subject's events of one rig on one day. */
interface EventDay {
  filter: string;
  rig: string;
  run: string | null;
  day: string;
  first: number;
  last: number;
  count: number;
  bytes: number;
  /** When the newest of them was stored. */
  at: string;
}

/** What a purge of control's copy needs of the bus. */
type PurgeBus = Pick<Bus, "purge" | "message">;

export class EventDays {
  /** The stream's place through which it took every message. */
  through = 0;
  private readonly days = new Map<string, EventDay>();
  /** Each run's state, from its events: open until a `run_status` closes it. */
  private readonly runs = new Map<string, boolean>();

  /** The messages of a page of the stream, in order; those it took already are passed over. */
  take(messages: readonly BusMessage[]): void {
    for (const m of messages) {
      if (m.seq <= this.through) continue;
      this.through = m.seq;
      const on = purgeSubjectOf(m.subject);
      const rig = m.header(EVENT_HEADERS.rig);
      if (!on || !rig) continue;
      // When control stored it, by the bus's clock.
      const at = m.at ?? "";
      const day = at.slice(0, 10);
      const key = `${on.filter}\n${rig}\n${day}`;
      const had = this.days.get(key);
      if (had) {
        had.last = m.seq;
        had.count++;
        had.bytes += m.data.length;
        if (at > had.at) had.at = at;
      } else
        this.days.set(key, {
          filter: on.filter,
          rig,
          run: on.run,
          day,
          first: m.seq,
          last: m.seq,
          count: 1,
          bytes: m.data.length,
          at,
        });
      if (on.run) this.runState(on.run, m);
    }
  }

  /** A run's state from its own events: made, closed, or open again. */
  private runState(run: string, m: BusMessage): void {
    if (m.subject.endsWith(".ev.run_created")) this.runs.set(run, true);
    else if (m.subject.endsWith(".ev.run_status")) {
      try {
        const body = JSON.parse(new TextDecoder().decode(m.data)).body as { status?: unknown };
        this.runs.set(run, body?.status !== "closed");
      } catch {
        // Not an event this build reads: the run's state stays as it was.
      }
    }
  }

  /** Each day of the rigs' events, as a policy reads them: one item for each subject, rig and day. */
  items(rigs: ReadonlySet<string>): RetentionItem[] {
    return [...this.days.values()]
      .filter((d) => rigs.has(d.rig))
      .map((d) => ({
        id: `${d.filter}\n${d.rig}\n${d.day}`,
        rig: d.rig,
        run: d.run,
        at: d.at,
        bytes: d.bytes,
        count: d.count,
        open: d.run !== null && this.runs.get(d.run) === true,
      }));
  }

  /**
   * What a purge removes of the days a policy chose (by their items' ids): for each subject, its
   * days from its oldest, any rig's, and the place before which they go. A purge removes every
   * message of the subject before that place, so it stops at the first day kept, and before the
   * first place of any day kept: a run's subject holds the events of every rig that used its
   * name, and one rig's day may reach past the start of another's, which the policy keeps.
   */
  plan(ids: ReadonlySet<string>): { filter: string; before: number; days: EventDay[] }[] {
    const bySubject = new Map<string, EventDay[]>();
    for (const d of this.days.values()) {
      const list = bySubject.get(d.filter);
      if (list) list.push(d);
      else bySubject.set(d.filter, [d]);
    }
    const out: { filter: string; before: number; days: EventDay[] }[] = [];
    for (const [filter, days] of bySubject) {
      const sorted = days.sort((a, b) => a.first - b.first);
      // The most days from the oldest that go whole: each chosen, and the last place among them
      // before the first place of the next day, which every later day starts after.
      let gone = 0;
      let through = 0;
      let reach = 0;
      for (const [i, d] of sorted.entries()) {
        if (!ids.has(`${d.filter}\n${d.rig}\n${d.day}`)) break;
        reach = Math.max(reach, d.last);
        const next = sorted[i + 1];
        if (!next || reach < next.first) {
          gone = i + 1;
          through = reach;
        }
      }
      if (gone) out.push({ filter, before: through + 1, days: sorted.slice(0, gone) });
    }
    return out;
  }

  /** A subject's days before a place, gone from the stream. */
  drop(filter: string, before: number): void {
    for (const [key, d] of this.days)
      if (d.filter === filter && d.last < before) this.days.delete(key);
  }
}

/** Each store's days of events, and the bus they are purged on, as its apply made them. */
const KEPT = new WeakMap<ControlStore, { days: EventDays; bus: PurgeBus | undefined }>();

/** Makes the days of events of a store's apply of the stream known to its retention policies. */
export function keepEventDays(store: ControlStore, days: EventDays, bus: PurgeBus | undefined) {
  KEPT.set(store, { days, bus });
}

/** The days of events of a store's apply; undefined where control applies no stream (a test's). */
export function eventDaysOf(store: ControlStore): EventDays | undefined {
  return KEPT.get(store)?.days;
}

/**
 * Purges the days a policy chose (their items' ids) from control's copy, a subject at a time, and
 * raises each rig ledger's floor to the last event removed (store/retention.ts), read from the last
 * message removed of each subject before it goes. Gives the days removed; a subject the bus did
 * not purge is left out, with why.
 */
export async function purgeEventDays(
  store: ControlStore,
  ids: ReadonlySet<string>,
  now: string,
): Promise<{ days: EventDay[]; error?: string }> {
  const kept = KEPT.get(store);
  if (!kept?.bus) return { days: [], error: "control holds no message bus to purge its events on" };
  const removed: EventDay[] = [];
  let error: string | undefined;
  for (const p of kept.days.plan(ids)) {
    try {
      // Each rig's last event removed of this subject, read before it goes: its ledger's floor.
      const lastOfRig = new Map<string, number>();
      for (const d of p.days) lastOfRig.set(d.rig, Math.max(lastOfRig.get(d.rig) ?? 0, d.last));
      const floors = [];
      for (const place of lastOfRig.values()) {
        const m = await kept.bus.message(EVENT_STREAM, place);
        if (m) floors.push(readEventMessage(m));
      }
      await kept.bus.purge(EVENT_STREAM, { filter: p.filter, seq: p.before });
      kept.days.drop(p.filter, p.before);
      removed.push(...p.days);
      for (const f of floors)
        await store.retention.raiseFloor(f.rig, f.ledger, f.event.id, p.before, now);
      log("control", "a retention policy purged control's copy of events", {
        filter: p.filter,
        before: p.before,
        events: p.days.reduce((n, d) => n + d.count, 0),
      });
    } catch (err) {
      error ??= `a purge of ${p.filter} failed: ${errorText(err)}`;
      log(
        "control",
        "a purge of control's copy of events failed",
        { filter: p.filter, error },
        "warn",
      );
    }
  }
  return error ? { days: removed, error } : { days: removed };
}
