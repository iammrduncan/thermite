import { createHash } from "node:crypto";
import {
  BUS_READ_MAX,
  BUS_RETRY_MS,
  type Bus,
  type BusMessage,
  type Outgoing,
  type StreamInfo,
} from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import {
  COPY_DUPLICATE_WINDOW_NS,
  EVENT_HEADERS,
  EVENT_REBUILD_STREAM,
  EVENT_REBUILD_STREAM_CONFIG,
  EVENT_REBUILD_SUBJECT,
  EVENT_STREAM,
  EVENT_STREAM_CONFIG,
  EVENT_SUBJECT_HEADER,
} from "../../core/link/events.ts";
import { inBatches, publishAfter, publishFailed } from "./batch.ts";

/**
 * The `EVENTS` stream made again once (goal 125, T12; the owner's decision of 2026-11-01: "Rebuild
 * the store once"). A stream made before v0.1.1 refuses every delete and purge, and the server
 * never lets a stream stop refusing them; the owner's retention policies purge it by subject. So
 * at control's start, before it takes a report or reads the stream, a stream that refuses purges
 * is copied, then made anew without that, and copied back:
 *
 * 1. Every message is copied to `EVENTS_REBUILD`, at the same place, on one subject, its own
 *    subject and the time control first stored it in headers, its id and the event's headers as
 *    they were. Each batch names the last place it expects, so a stop part way or a lost ack never
 *    copies a message twice, and a start after a stop goes on from the copy's last place.
 * 2. The copy is checked against the stream, place by place: subject, id, headers, data and the
 *    time it was first stored, with each rig's count and digest in control's log.
 * 3. Control's user may delete the stream now (BusUsers.whileRebuilding), and deletes it.
 * 4. `EVENTS` is made again, starting at the same first place, and the copy is copied back the
 *    same way, and checked the same way.
 * 5. The copy is deleted.
 *
 * Each step is worked out from what the bus holds at each start, so a stop at any step goes on
 * from there; nothing is lost, since the stream is deleted only once the copy holds every message
 * whole, and the copy only once the new stream does. Every event keeps its place, so control's
 * place in the stream, its views' folds, a caller's cursor of `GET /v1/rigs/<rig>/events` and a
 * backup's places stay as they were. While it runs, the bus's store needs room for the events
 * twice. A stream with a place that holds no message, which a stream that refuses deletes can't
 * have, stops it, in words, and control does not start.
 */

/** While the copy goes on, it logs how far it got every this many messages. */
const REBUILD_LOG_MESSAGES = 100_000;
/** NATS's own header for a message's id. */
const MSG_ID_HEADER = "Nats-Msg-Id";
/** The event's own headers, which a copy keeps as they were. */
const KEPT_HEADERS = [
  EVENT_HEADERS.rig,
  EVENT_HEADERS.ledger,
  EVENT_HEADERS.report,
  EVENT_HEADERS.seq,
] as const;

/** What the rebuild needs of the bus. */
type RebuildBus = Pick<Bus, "streamInfo" | "deleteStream" | "makeStream" | "read" | "publishBatch">;

interface EventsRebuildOptions {
  bus: RebuildBus;
  /**
   * Runs `work` while control's user may delete the events stream (BusUsers.whileRebuilding);
   * none: as it is (a test's bus, which refuses nothing).
   */
  allowDelete?: (<T>(work: () => Promise<T>) => Promise<T>) | undefined;
  /** How long it waits after a failure: BUS_RETRY_MS unless a test gives a shorter one. */
  retryMs?: number | undefined;
}

/** What a rebuild found: no stream yet, a stream that purges already, or one it made again. */
type RebuildDone = "none" | "current" | "rebuilt";

/** A stream's settings that refuse deletes or purges, which the server never undoes. */
const refuses = (s: StreamInfo) => Boolean(s.config.deny_purge || s.config.deny_delete);

/** When control first stored a message: its header after a copy, else the server's own time. */
const receivedOf = (m: BusMessage) => m.header(EVENT_HEADERS.received) ?? m.at ?? "";

/** A message's own subject: its header in the copy, else the subject it is on. */
const subjectOf = (m: BusMessage) => m.header(EVENT_SUBJECT_HEADER) ?? m.subject;

/** The event's headers, as they were, and when control first stored it. */
function eventHeadersOf(m: BusMessage): Record<string, string> {
  const h: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = m.header(name);
    if (v !== undefined) h[name] = v;
  }
  const at = receivedOf(m);
  if (at) h[EVENT_HEADERS.received] = at;
  return h;
}

/** A message of the stream as the copy holds it. */
function toCopy(m: BusMessage): Outgoing {
  return {
    subject: EVENT_REBUILD_SUBJECT,
    data: new TextDecoder().decode(m.data),
    id: m.header(MSG_ID_HEADER),
    headers: { ...eventHeadersOf(m), [EVENT_SUBJECT_HEADER]: m.subject },
  };
}

/** A message of the copy as the stream made again holds it. */
function fromCopy(m: BusMessage): Outgoing {
  return {
    subject: subjectOf(m),
    data: new TextDecoder().decode(m.data),
    id: m.header(MSG_ID_HEADER),
    headers: eventHeadersOf(m),
  };
}

/** What a check compares of a message: its place, subject, id, headers, data and first time. */
function keyOf(m: BusMessage): string {
  const h = KEPT_HEADERS.map((name) => m.header(name) ?? "").join("\n");
  const data = new TextDecoder().decode(m.data);
  return `${m.seq}\n${subjectOf(m)}\n${m.header(MSG_ID_HEADER) ?? ""}\n${h}\n${receivedOf(m)}\n${data}`;
}

/** Why the rebuild can't go on, in words: control does not start. */
class RebuildStopped extends Error {}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class EventsRebuild {
  private readonly o: EventsRebuildOptions;
  /** Messages it copied since control started, both ways. */
  copied = 0;
  /** Why it waits now (the bus away, its store full); null while it goes on, or is done. */
  waiting: string | null = null;
  /** Why it stopped, until control starts again; null while it goes on, or is done. */
  stopped: string | null = null;
  /** What it found, once done. */
  done: RebuildDone | null = null;
  private closed = false;

  constructor(o: EventsRebuildOptions) {
    this.o = o;
  }

  close(): void {
    this.closed = true;
  }

  /** Makes the stream again when it refuses purges, as above; resolves once done or stopped. */
  async run(): Promise<void> {
    while (!this.stopped && !this.closed && !this.done) {
      try {
        this.done = await this.turn();
        if (this.waiting)
          log("control", "the events stream's rebuild goes on", { after: this.waiting });
        this.waiting = null;
      } catch (err) {
        if (err instanceof RebuildStopped) {
          this.stopped = err.message;
          log("control", "the events stream can't be made again", { error: err.message }, "error");
          return;
        }
        const error = publishFailed(err);
        if (this.waiting !== error)
          log("control", "the events stream's rebuild waits; trying again", { error }, "warn");
        this.waiting = error;
        await pause(this.o.retryMs ?? BUS_RETRY_MS);
      }
    }
  }

  private async turn(): Promise<RebuildDone> {
    const { bus } = this.o;
    const old = await bus.streamInfo(EVENT_STREAM);
    if (old && refuses(old)) {
      if (old.messages && old.messages !== old.last_seq - old.first_seq + 1)
        throw new RebuildStopped(
          `${EVENT_STREAM} holds ${old.messages} messages from place ${old.first_seq} to ${old.last_seq}: a place holds no message, which a stream that refuses deletes can't have. Restore it from a backup, then start control again`,
        );
      const started = performance.now();
      log("control", "making the events stream again, once: copying it", {
        messages: old.messages,
        first: old.first_seq,
        last: old.last_seq,
      });
      if (!(await bus.streamInfo(EVENT_REBUILD_STREAM)))
        await bus.makeStream({
          ...EVENT_REBUILD_STREAM_CONFIG,
          first_seq: Math.max(1, old.messages ? old.first_seq : old.last_seq + 1),
        });
      await this.copy(EVENT_STREAM, EVENT_REBUILD_STREAM, toCopy);
      const summary = await this.check(EVENT_STREAM, EVENT_REBUILD_STREAM);
      log("control", "the events stream's copy holds every message", {
        ...summary,
        seconds: Math.round(performance.now() - started) / 1000,
      });
      const del = this.o.allowDelete ?? (<T>(work: () => Promise<T>) => work());
      await del(() => bus.deleteStream(EVENT_STREAM));
      log("control", "the events stream that refused purges deleted: its copy holds it", {});
    }
    const copy = await bus.streamInfo(EVENT_REBUILD_STREAM);
    if (!copy) return old ? "current" : "none";
    const started = performance.now();
    if (!(await bus.streamInfo(EVENT_STREAM)))
      await bus.makeStream({
        ...EVENT_STREAM_CONFIG,
        first_seq: Math.max(1, copy.messages ? copy.first_seq : copy.last_seq + 1),
        duplicate_window: COPY_DUPLICATE_WINDOW_NS,
      });
    await this.copy(EVENT_REBUILD_STREAM, EVENT_STREAM, fromCopy);
    const summary = await this.check(EVENT_REBUILD_STREAM, EVENT_STREAM);
    await bus.makeStream(EVENT_STREAM_CONFIG);
    await bus.deleteStream(EVENT_REBUILD_STREAM);
    log("control", "the events stream made again: control's user may purge it now", {
      ...summary,
      seconds: Math.round(performance.now() - started) / 1000,
    });
    return "rebuilt";
  }

  /**
   * Copies `from`'s messages after `to`'s last place, each at its own place, a batch at a time:
   * each batch names the last place it expects.
   */
  private async copy(from: string, to: string, as: (m: BusMessage) => Outgoing): Promise<void> {
    const { bus } = this.o;
    const dest = await bus.streamInfo(to);
    let place = dest?.last_seq ?? 0;
    let next = place + 1;
    let logged = 0;
    for (;;) {
      const r = await bus.read(from, { from: next, limit: BUS_READ_MAX });
      const messages: { out: Outgoing; bytes: number }[] = [];
      for (const m of r.messages) {
        if (m.seq !== next + messages.length)
          throw new RebuildStopped(
            `${from} has no message at place ${next + messages.length} (the next is at ${m.seq}): it can't be copied place for place`,
          );
        const out = as(m);
        messages.push({ out, bytes: Buffer.byteLength(String(out.data)) });
      }
      for (const batch of inBatches(messages)) {
        place = await publishAfter(bus, place, batch);
        this.copied += batch.length;
      }
      if (this.copied - logged >= REBUILD_LOG_MESSAGES) {
        logged = this.copied;
        log("control", "making the events stream again: copying", { from, to, through: place });
      }
      next = r.next;
      if (r.done || !r.messages.length) return;
    }
  }

  /**
   * Checks that `b` holds `a`'s messages, place for place, the same; throws in words when it
   * does not. Gives how many it compared, and each rig's count and digest.
   */
  private async check(a: string, b: string) {
    const { bus } = this.o;
    const rigs = new Map<string, { messages: number; hash: ReturnType<typeof createHash> }>();
    let compared = 0;
    let next = 1;
    let theirs: BusMessage[] = [];
    let theirNext = 1;
    let theirDone = false;
    for (;;) {
      const r = await bus.read(a, { from: next, limit: BUS_READ_MAX });
      for (const m of r.messages) {
        while (!theirs.length && !theirDone) {
          const page = await bus.read(b, { from: theirNext, limit: BUS_READ_MAX });
          theirs = page.messages;
          theirNext = page.next;
          theirDone = page.done || !page.messages.length;
        }
        const t = theirs.shift();
        if (!t || keyOf(t) !== keyOf(m))
          throw new RebuildStopped(
            `${b} does not hold ${a}'s message at place ${m.seq} as it is: nothing was deleted; start control again to copy it anew`,
          );
        const rig = m.header(EVENT_HEADERS.rig) ?? "";
        const r2 = rigs.get(rig) ?? { messages: 0, hash: createHash("sha256") };
        r2.messages++;
        r2.hash.update(keyOf(m)).update("\n");
        rigs.set(rig, r2);
        compared++;
      }
      next = r.next;
      if (r.done || !r.messages.length) break;
    }
    if (theirs.length || !theirDone) {
      const more = theirs.length
        ? theirs
        : (await bus.read(b, { from: theirNext, limit: 1 })).messages;
      if (more.length)
        throw new RebuildStopped(
          `${b} holds a message at place ${more[0]?.seq} that ${a} does not: nothing was deleted`,
        );
    }
    return {
      compared,
      rigs: Object.fromEntries(
        [...rigs].map(([rig, x]) => [rig, { messages: x.messages, sha256: x.hash.digest("hex") }]),
      ),
    };
  }
}
