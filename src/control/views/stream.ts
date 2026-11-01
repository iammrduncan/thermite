import { BUS_READ_MAX, type Bus, type BusMessage } from "../../common/bus/index.ts";
import {
  EVENT_HEADERS,
  EVENT_STREAM,
  type EventRead,
  eventSubject,
  readEventMessage,
} from "../../core/link/events.ts";
import { currentEvent } from "../../core/names.ts";
import { MODEL_CALL_EVENT } from "../../core/usage.ts";
import type { StoredEvent } from "./types.ts";

/**
 * Control's reads of its rigs' events from the message bus's `EVENTS` stream (goal 168, step 4),
 * which holds every event control took, in the order it took them: a rig's events after a place
 * (`GET /v1/rigs/<rig>/events`), one ledger's of a rig (the fold of an earlier ledger or of a
 * retired rig, cache.ts), and a run's events of one kind (its prompts). Each reads the subjects
 * the events are on, its rig's own and those of the runs its events name, which control's kept
 * folds know (cache.ts), and keeps those whose headers name the rig (and the ledger): a run's
 * subjects hold every rig's events of a run of that name. The apply of the stream
 * (control/events) hands the folds each event as it applies it.
 */

/** What control reads the stream through. */
export type EventBus = Pick<Bus, "read">;

/** An event from the stream: its place there, and the event with its rig, ledger and seq. */
export interface StreamEvent {
  place: number;
  read: EventRead;
  /** When the stream stored it: when control published it, as it took the rig's report. */
  at?: string | undefined;
}

/** One read of the stream: its events, where the next read starts, and whether it is at the end. */
export interface StreamPage {
  events: StreamEvent[];
  next: number;
  done: boolean;
}

/**
 * A message from the stream read as an event, or undefined for one that is not: the apply of the
 * stream says so in control's log, once, when it comes to it.
 */
export function streamEvent(m: BusMessage): StreamEvent | undefined {
  try {
    return { place: m.seq, read: readEventMessage(m), at: m.at };
  } catch {
    return undefined;
  }
}

/** One read of the stream, as Bus.read reads it, each message read as an event. */
async function readStream(
  bus: EventBus,
  o: {
    subjects: readonly string[];
    headers: Record<string, string>;
    from: number;
    limit: number;
  },
): Promise<StreamPage> {
  const r = await bus.read(EVENT_STREAM, o);
  const events = r.messages.flatMap((m) => streamEvent(m) ?? []);
  return { events, next: r.next, done: r.done };
}

/** The kinds whose text the knowledge base keeps: a view never reads it. */
const TEXT_LEFT_OUT = new Set(["source_fetched", "research_doc", "context_compacted"]);

/**
 * An event as a rig's fold takes it: under the current names, with its place in the stream as its
 * seq, as `GET /v1/rigs/<rig>/events` gives it (the move put the rows of control's events table
 * first in the stream, in the table's order, so the places of all events follow control's order),
 * and without what no page reads: the text of a source and a document, which the knowledge base
 * keeps, and the model calls, which the usage tables keep (undefined for one).
 */
export function foldEvent(e: StreamEvent): StoredEvent | undefined {
  const { event, ledger } = e.read;
  if (event.kind === MODEL_CALL_EVENT) return undefined;
  let body = event.body as Record<string, unknown>;
  if (TEXT_LEFT_OUT.has(event.kind) && body && typeof body === "object" && "text" in body) {
    const { text: _text, ...rest } = body;
    body = rest;
  }
  const stored: StoredEvent & { run: string | null } = {
    seq: e.place,
    ledger_id: ledger,
    id: event.id,
    at: event.at,
    actor: event.actor,
    kind: event.kind,
    subject: event.subject,
    body,
    run: event.run ?? null,
  };
  return currentEvent(stored);
}

/**
 * One read of a rig ledger's events from a place, on `subjects` (rigEventSubjects): what the fold
 * of an earlier ledger or of a retired rig is built from (cache.ts), a read at a time.
 */
export function readLedger(
  bus: EventBus,
  o: { rig: string; ledger: string; subjects: readonly string[]; from: number },
): Promise<StreamPage> {
  return readStream(bus, {
    subjects: o.subjects,
    headers: { [EVENT_HEADERS.rig]: o.rig, [EVENT_HEADERS.ledger]: o.ledger },
    from: o.from,
    limit: BUS_READ_MAX,
  });
}

/** An event as `GET /v1/rigs/<rig>/events` gives it: `seq` is its place in the stream. */
export interface RawEvent {
  seq: number;
  ledger_id: string;
  id: number;
  at: string;
  actor: string;
  kind: string;
  subject: string | null;
  body: unknown;
  run: string | null;
  /** When control took it: when the stream stored it; null where the stream did not say. */
  received_at: string | null;
}

/**
 * A rig's events after a place in the stream and up to `through`, oldest first, in every ledger,
 * `limit` at most, under the current names, on `subjects` (rigEventSubjects). Each one's `seq` is
 * its place in the stream, so the next page goes on after the last one's; a page holds fewer than
 * `limit` only at the end.
 */
export async function rigEventsAfter(
  bus: EventBus,
  o: { rig: string; subjects: readonly string[]; after: number; through: number; limit: number },
): Promise<RawEvent[]> {
  const headers = { [EVENT_HEADERS.rig]: o.rig };
  const out: RawEvent[] = [];
  for (let from = o.after + 1; from <= o.through; ) {
    const page = await readStream(bus, {
      subjects: o.subjects,
      headers,
      from,
      limit: BUS_READ_MAX,
    });
    for (const { place, read, at } of page.events) {
      if (place > o.through || out.length >= o.limit) return out;
      const { event: e, ledger } = read;
      const raw: RawEvent = {
        seq: place,
        ledger_id: ledger,
        id: e.id,
        at: e.at,
        actor: e.actor,
        kind: e.kind,
        subject: e.subject,
        body: e.body,
        run: e.run ?? null,
        received_at: at ?? null,
      };
      out.push(currentEvent(raw));
    }
    if (page.done || page.next <= from) break;
    from = page.next;
  }
  return out;
}

/**
 * A run's events of one kind on a rig, oldest first, in every ledger: on the run's subject for
 * the kind, or on the rig's own for a run the registry gave another rig when the event came.
 */
export async function runEventsOfKind(
  bus: EventBus,
  o: { rig: string; run: string; kind: string },
): Promise<StreamEvent[]> {
  const of = { kind: o.kind, run: o.run };
  const subjects = [...new Set([true, false].map((own) => eventSubject(o.rig, of, own)))];
  const headers = { [EVENT_HEADERS.rig]: o.rig };
  const out: StreamEvent[] = [];
  for (let from = 1; ; ) {
    const page = await readStream(bus, { subjects, headers, from, limit: BUS_READ_MAX });
    for (const e of page.events)
      if (e.read.event.kind === o.kind && e.read.event.run === o.run) out.push(e);
    if (page.done || page.next <= from) return out;
    from = page.next;
  }
}
