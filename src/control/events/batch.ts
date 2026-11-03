import { BUS_BATCH_MAX, type Bus, type Outgoing } from "../../common/bus/index.ts";
import { errorText } from "../../common/errors.ts";
import {
  EVENT_MAX_BYTES,
  type EventMessage,
  eventFits,
  eventMessage,
} from "../../core/link/events.ts";
import type { ReportEvent } from "../../core/link/report.ts";

/**
 * Rigs' events as messages of the `EVENTS` stream, in the batches control publishes them in: the
 * events of a report's page, published first (writer.ts), and the rows of a store from before
 * the stream, moved there once (move.ts). Control is the stream's one writer, one turn at a time:
 * each batch names the stream's last place it expects, so one the server stored late, after its
 * publish failed, refuses the next, and the writer reads the stream's end again.
 */

/**
 * How many bytes of events one batch holds at most: what one message may hold, so that a batch,
 * which the server holds until its last message, weighs no more than a report's page on the bus.
 * An event alone always fits.
 */
export const BATCH_BYTES = EVENT_MAX_BYTES;
/** NATS's header that has a publish stored only when the stream's last place is this one. */
const EXPECTED_LAST_HEADER = "Nats-Expected-Last-Sequence";
/** The server's code for a store that is full: it refuses every publish, until it has room. */
const STORE_FULL = 10023;

/**
 * Whether a run's event goes on its run's subject: the run registry gives the run to the rig that
 * reported it, or to no rig yet. A run a rig created is its own from its `run_created` on, which
 * control registers before it publishes the page; so every event of a run a page creates goes on
 * the run's subject, its `run_created` too. A run the registry gives only other rigs is not the
 * rig's: its event goes on the rig's own subject.
 */
export function isTheRigsRun(rig: string, rigsOfRun: readonly string[]): boolean {
  return rigsOfRun.length === 0 || rigsOfRun.includes(rig);
}

/** An event as a message on the bus, with its size, or why the bus can't carry it. */
export type OnBus =
  | { message: EventMessage; bytes: number }
  | { error: string; bytes: number | null };

/** An event as a message on the bus, or why the bus can't carry it: too large, or a bad name. */
export function onBus(o: {
  rig: string;
  ledger: string;
  event: ReportEvent;
  runIsTheRigs: boolean;
  report?: string | undefined;
  seq?: number | undefined;
}): OnBus {
  let message: EventMessage;
  try {
    message = eventMessage(o);
  } catch (err) {
    return { error: errorText(err), bytes: null };
  }
  const bytes = Buffer.byteLength(message.data);
  if (!eventFits(bytes))
    return {
      error: `it is ${bytes} bytes, more than a message on the bus holds (${EVENT_MAX_BYTES} bytes with its headers)`,
      bytes,
    };
  return { message, bytes };
}

/**
 * Why the bus can't carry an event of a report's page, in words, or undefined when it can carry
 * them all: one too large, or with a kind or ledger a subject or a header can't hold. Control keeps
 * every event it takes on the bus, so ingest refuses such a page before it keeps anything of it.
 */
export function notForBus(r: {
  rig: string;
  ledger_id: string;
  events: readonly ReportEvent[];
}): string | undefined {
  for (const event of r.events) {
    const m = onBus({ rig: r.rig, ledger: r.ledger_id, event, runIsTheRigs: false });
    if (!("error" in m)) continue;
    const which = `event ${event.id} (${event.kind.slice(0, 64)})`;
    return m.bytes !== null
      ? `${which} is too large for the message bus: ${m.error}`
      : `${which} can't go on the message bus: ${m.error}`;
  }
  return undefined;
}

/** A message as a batch takes it. */
export const outgoing = (m: EventMessage): Outgoing => ({
  subject: m.subject,
  data: m.data,
  id: m.id,
  headers: m.headers,
});

/**
 * Messages in order, in batches of up to BUS_BATCH_MAX messages and BATCH_BYTES of events: each
 * batch the server stores whole, or not at all.
 */
export function inBatches(messages: readonly { out: Outgoing; bytes: number }[]): Outgoing[][] {
  const out: Outgoing[][] = [];
  let batch: Outgoing[] = [];
  let bytes = 0;
  for (const m of messages) {
    if (batch.length && (batch.length >= BUS_BATCH_MAX || bytes + m.bytes > BATCH_BYTES)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(m.out);
    bytes += m.bytes;
  }
  if (batch.length) out.push(batch);
  return out;
}

/**
 * Publishes a batch after the stream's place `place`, as its first message names: stored whole
 * there, or refused. Returns the place of its last message.
 */
export async function publishAfter(
  bus: Pick<Bus, "publishBatch">,
  place: number,
  batch: readonly Outgoing[],
): Promise<number> {
  const [first, ...rest] = batch;
  if (!first) return place;
  const named = { ...first, headers: { ...first.headers, [EXPECTED_LAST_HEADER]: String(place) } };
  const ack = await bus.publishBatch([named, ...rest]);
  return ack.seq;
}

/** Why a publish failed, in words: the bus's store full, or what the bus said. */
export function publishFailed(err: unknown): string {
  const full = (err as { code?: unknown } | null)?.code === STORE_FULL;
  return full ? `the bus's store is full: ${errorText(err)}` : errorText(err);
}
