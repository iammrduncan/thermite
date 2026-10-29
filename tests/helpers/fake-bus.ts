import { JetStreamApiError } from "@nats-io/jetstream";
import { errors } from "@nats-io/transport-node";
import {
  type BatchPublished,
  BUS_BATCH_MAX,
  BUS_READ_MAX,
  BUS_READ_MAX_BYTES,
  type Bus,
  type BusMessage,
  type BusRead,
  type ConsumerSettings,
  type Handled,
  type Outgoing,
  type Published,
  type StreamSettings,
  type StreamState,
} from "../../src/common/bus.ts";

/** A message the fake bus keeps. */
export interface Kept {
  stream: string;
  subject: string;
  /** Its place in its stream. */
  seq: number;
  /** Its id; none for a message published without one. */
  id: string | undefined;
  data: string;
  /** Its data as bytes, for a message published as bytes (a file's chunk): `data` is empty then. */
  bytes?: Uint8Array | undefined;
  headers: Record<string, string>;
  /** When the stream stored it. */
  at?: string | undefined;
}

/** A subject as a stream's pattern reads it: `*` stands for one token, `>` for the rest. */
function takes(pattern: string, subject: string): boolean {
  const re = pattern
    .split(".")
    .map((t) => (t === "*" ? "[^.]+" : t === ">" ? ".+" : t.replace(/[\\^$+?()[\]{}|]/g, "\\$&")))
    .join("\\.");
  return new RegExp(`^${re}$`).test(subject);
}

/** The server's words for a store that is full: it refuses every publish, to any stream. */
const FULL = { code: 503, err_code: 10023, description: "insufficient resources" };
/** The server's words for a batch to a stream that takes none (`allow_atomic` not set). */
const NOT_ATOMIC = { code: 400, err_code: 10174, description: "atomic publish is disabled" };
/** The server's words for a batch with a message it did not take, as one for another stream. */
const INCOMPLETE = {
  code: 400,
  err_code: 10176,
  description: "atomic publish batch is incomplete",
};
/** The server's words for a batch whose first message expects another last place. */
const WRONG_LAST = (seq: number) => ({
  code: 400,
  err_code: 10071,
  description: `wrong last sequence: ${seq}`,
});
/** The server's words for a message over its stream's largest. */
const TOO_LARGE = {
  code: 400,
  err_code: 10054,
  description: "message size exceeds maximum allowed",
};
/** The server's words for an update that would make a stream a work queue, or one no longer. */
const NO_RETENTION_CHANGE = {
  code: 500,
  err_code: 10052,
  description: "stream configuration update can not change retention policy to/from workqueue",
};

/**
 * A stand-in for the NATS server, in memory, for tests of what control and the supervisor do on
 * the message bus (common/bus.ts talks to a real one). It keeps the streams made, each message
 * published to a subject one of them takes, once by its id within its stream, each stream's
 * places counted on their own; removes one by its id; gives a subject's newest, a message by its
 * place, a stream's last place, and reads a stream in order. A batch is stored whole or not at
 * all, as the server stores it. `take` hands a subject's messages to a handler as a work queue's
 * consumer does; `follow` hands a stream's to a durable consumer, once.
 */
export class FakeBus
  implements
    Pick<
      Bus,
      | "publish"
      | "publishBatch"
      | "read"
      | "message"
      | "lastSeq"
      | "makeStream"
      | "follow"
      | "remove"
      | "streams"
      | "last"
      | "connected"
    >
{
  /** Whether the part holds a connection to the server now, as control's health says. */
  up = true;
  connected(): boolean {
    return this.up;
  }
  /** The streams made, by name. */
  readonly made = new Map<string, StreamSettings>();
  readonly kept: Kept[] = [];
  /** The ids each stream remembers; forgetIds() stands for its duplicate window passing. */
  private readonly ids = new Map<string, Set<string>>();
  /** Each stream's last place. */
  private readonly seqs = new Map<string, number>();
  /** Set: every publish fails, as when the server's ack never comes; nothing is stored. */
  failing = false;
  /** Set: each publish waits for it before the server answers. */
  hold: Promise<void> | undefined;
  /** Set: the subjects the publishing user may not publish to, as the server refuses them. */
  refuse: ((subject: string) => boolean) | undefined;
  /** Set: the server's store is full, and it refuses every publish, as the real one does. */
  full = false;
  /** Set: how many more batches pass before `failing` is set, as when the server goes away. */
  failAfter: number | undefined;
  /** Set: the next batch is stored and its ack lost: its publish fails all the same. */
  loseAck = false;

  /** Each durable consumer's place in a stream that keeps what it hands (not a work queue). */
  private readonly places = new Map<string, number>();

  /** As the server: a stream's retention never changes to or from a work queue in place. */
  async makeStream(stream: StreamSettings): Promise<void> {
    const had = this.made.get(stream.name);
    if (had && (had.retention === "workqueue") !== (stream.retention === "workqueue"))
      throw new JetStreamApiError(NO_RETENTION_CHANGE);
    this.made.set(stream.name, stream);
  }

  /**
   * As common/bus.ts's follow, in one pass: the stream made or brought to its settings, then each
   * message the consumer has yet to take handed to `handle`, in order, until one is asked for
   * again, which stays for the next call; a test calls it again for what comes later. A stream on
   * the fake with another retention than the work queue it is now is emptied first, as
   * common/work-queue.ts does: its subjects taken off, each message handed, then removed and made
   * anew, its places and ids starting again; one asked for again leaves it emptying.
   */
  async follow(
    stream: StreamSettings | string,
    consumer: ConsumerSettings,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
  ): Promise<void> {
    const name = typeof stream === "string" ? stream : stream.name;
    const had = this.made.get(name);
    if (typeof stream !== "string") {
      if (had && stream.retention === "workqueue" && had.retention !== "workqueue") {
        this.made.set(name, { ...had, subjects: [name] });
        if (!(await this.hand(name, consumer.durable_name, handle))) return;
        this.removeStream(name);
      }
      await this.makeStream(stream);
    } else if (!had) return;
    await this.hand(name, consumer.durable_name, handle);
  }

  /** Hands a consumer its messages in order; false at the first the handler asks for again. */
  private async hand(
    stream: string,
    consumer: string,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
  ): Promise<boolean> {
    const queue = this.made.get(stream)?.retention === "workqueue";
    const at = `${stream}.${consumer}`;
    const left = this.kept.filter((m) => m.stream === stream && m.seq > (this.places.get(at) ?? 0));
    for (const m of left) {
      if (await handle(asMessage(m))) return false;
      if (queue) this.kept.splice(this.kept.indexOf(m), 1);
      else this.places.set(at, m.seq);
    }
    return true;
  }

  /** A stream removed, with its messages, the ids it remembers and its consumers' places. */
  private removeStream(name: string): void {
    this.made.delete(name);
    this.ids.delete(name);
    this.seqs.delete(name);
    for (const at of [...this.places.keys()]) if (at.startsWith(`${name}.`)) this.places.delete(at);
    for (let i = this.kept.length - 1; i >= 0; i--)
      if (this.kept[i]?.stream === name) this.kept.splice(i, 1);
  }

  /**
   * Why the server would refuse this message, or else the stream that takes it. A refusal is the
   * server's: a JetStreamApiError for the stream's, a PermissionViolationError for the user's.
   */
  private check(m: Outgoing): StreamSettings {
    if (this.failing) throw new Error("TimeoutError: no ack from the server");
    if (this.refuse?.(m.subject)) {
      const why = `Permissions Violation for Publish to "${m.subject}"`;
      throw new Error(why, {
        cause: new errors.PermissionViolationError(why, "publish", m.subject),
      });
    }
    const stream = [...this.made.values()].find((s) =>
      (s.subjects ?? []).some((p) => takes(p, m.subject)),
    );
    if (!stream) throw new Error(`no stream on the bus takes ${m.subject} yet: control makes it`);
    if (this.full) throw new JetStreamApiError(FULL);
    const bytes =
      Buffer.byteLength(m.data) +
      Object.entries(m.headers ?? {}).reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
    const max = stream.max_msg_size ?? -1;
    if (max >= 0 && bytes > max) throw new JetStreamApiError(TOO_LARGE);
    return stream;
  }

  private idsOf(stream: string): Set<string> {
    const ids = this.ids.get(stream) ?? new Set<string>();
    this.ids.set(stream, ids);
    return ids;
  }

  /** Stores a message the checks passed, unless its stream has its id. */
  private store(stream: string, m: Outgoing): Published {
    const ids = this.idsOf(stream);
    if (m.id !== undefined && ids.has(m.id)) {
      const had = this.kept.find((k) => k.stream === stream && k.id === m.id);
      return { seq: had?.seq ?? this.lastOf(stream), duplicate: true };
    }
    if (m.id !== undefined) ids.add(m.id);
    const seq = this.lastOf(stream) + 1;
    this.seqs.set(stream, seq);
    const { subject, id } = m;
    const bytes = typeof m.data === "string" ? undefined : m.data;
    this.kept.push({
      stream,
      subject,
      seq,
      id,
      data: typeof m.data === "string" ? m.data : "",
      ...(bytes ? { bytes } : {}),
      headers: m.headers ?? {},
      at: new Date().toISOString(),
    });
    return { seq, duplicate: false };
  }

  private lastOf(stream: string): number {
    return this.seqs.get(stream) ?? 0;
  }

  async publish(
    subject: string,
    data: string | Uint8Array,
    o: { id: string; headers?: Record<string, string> | undefined },
  ): Promise<Published> {
    await this.hold;
    const m = { subject, data, id: o.id, headers: o.headers };
    return this.store(this.check(m).name, m);
  }

  /**
   * As the server: every message checked first, and one refused refuses the batch, which stores
   * nothing (with that message's own refusal, where the server says only that the batch is
   * incomplete); a first message that expects another last place than the stream's refuses it
   * too. A batch whose stream has some of its ids is published a message at a time, as
   * common/bus.ts does.
   */
  async publishBatch(batch: readonly Outgoing[]): Promise<BatchPublished> {
    await this.hold;
    if (this.failAfter !== undefined && this.failAfter-- <= 0) this.failing = true;
    if (batch.length < 1 || batch.length > BUS_BATCH_MAX)
      throw new Error(`a batch holds 1 to ${BUS_BATCH_MAX} messages, not ${batch.length}`);
    const ids = batch.flatMap((m) => (m.id ? [m.id] : []));
    if (new Set(ids).size !== ids.length) throw new Error("a batch holds each message id once");
    const streams = new Set(batch.map((m) => this.check(m).name));
    const [stream = ""] = streams;
    if (!this.made.get(stream)?.allow_atomic) throw new JetStreamApiError(NOT_ATOMIC);
    if (streams.size > 1) throw new JetStreamApiError(INCOMPLETE);
    const expected = batch[0]?.headers?.["Nats-Expected-Last-Sequence"];
    if (expected !== undefined && Number(expected) !== this.lastOf(stream))
      throw new JetStreamApiError(WRONG_LAST(this.lastOf(stream)));
    // Stored whole when the stream has none of its ids; else a message at a time: the same here.
    let seq = 0;
    let stored = 0;
    for (const m of batch) {
      const ack = this.store(stream, m);
      seq = ack.seq;
      if (!ack.duplicate) stored++;
    }
    if (this.loseAck) {
      this.loseAck = false;
      throw new Error("TimeoutError: no ack from the server");
    }
    return { seq, stored, duplicate: stored === 0 };
  }

  /** A stream's messages in order, as common/bus.ts reads them, the same limits and header test. */
  async read(
    stream: string,
    o: {
      subjects?: readonly string[] | undefined;
      from?: number | undefined;
      limit: number;
      headers?: Readonly<Record<string, string>> | undefined;
    },
  ): Promise<BusRead> {
    await this.hold;
    if (this.failing) throw new Error("TimeoutError: no answer from the server");
    const from = o.from ?? 1;
    if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > BUS_READ_MAX)
      throw new Error(`a read looks at 1 to ${BUS_READ_MAX} messages, not ${o.limit}`);
    if (!Number.isInteger(from) || from < 1)
      throw new Error(`a read starts at 1 or after, not ${from}`);
    const out: BusRead = { messages: [], next: from, done: true };
    if (!this.made.has(stream)) return out;
    const on = this.kept.filter(
      (m) =>
        m.stream === stream &&
        m.seq >= from &&
        (!o.subjects?.length || o.subjects.some((p) => takes(p, m.subject))),
    );
    let bytes = 0;
    for (const [i, m] of on.entries()) {
      bytes += m.bytes?.length ?? Buffer.byteLength(m.data);
      out.next = m.seq + 1;
      const message = asMessage(m);
      if (Object.entries(o.headers ?? {}).every(([k, v]) => message.header(k) === v))
        out.messages.push(message);
      out.done = i === on.length - 1;
      if (i + 1 >= o.limit || bytes >= BUS_READ_MAX_BYTES) break;
    }
    return out;
  }

  /** The message at a place in a stream made; undefined when there is none there. */
  async message(stream: string, seq: number): Promise<BusMessage | undefined> {
    await this.hold;
    if (this.failing) throw new Error("TimeoutError: no answer from the server");
    const m = this.kept.find((k) => k.stream === stream && k.seq === seq);
    return m ? asMessage(m) : undefined;
  }

  /** A stream's last place: 0 before its first message, or for a stream not made. */
  async lastSeq(stream: string): Promise<number> {
    await this.hold;
    if (this.failing) throw new Error("TimeoutError: no answer from the server");
    return this.lastOf(stream);
  }

  async remove(_stream: string, subject: string, id: string): Promise<boolean> {
    const at = this.kept.findIndex((m) => m.subject === subject && m.id === id);
    if (at < 0) return false;
    this.kept.splice(at, 1);
    return true;
  }

  /** The newest message on a subject, of a stream made; undefined when it has none. */
  async last(stream: string, subject: string): Promise<BusMessage | undefined> {
    await this.hold;
    if (this.failing) throw new Error("TimeoutError: no answer from the server");
    if (!this.made.has(stream)) return undefined;
    const m = this.on(subject).at(-1);
    return m ? asMessage(m) : undefined;
  }

  /** Each stream made, with the messages it keeps; no consumers. */
  async streams(names: readonly string[]): Promise<StreamState[]> {
    return names.flatMap((name) => {
      if (!this.made.has(name)) return [];
      const kept = this.kept.filter((m) => m.stream === name);
      return [
        {
          name,
          messages: kept.length,
          bytes: kept.reduce((n, m) => n + (m.bytes?.length ?? Buffer.byteLength(m.data)), 0),
          subjects: new Set(kept.map((m) => m.subject)).size,
          first_at: null,
          last_at: null,
          consumers: [],
          consumers_left_out: 0,
        },
      ];
    });
  }

  /** A stream's settings and messages, as its snapshot holds them; undefined for one not made. */
  streamCopy(name: string): { settings: StreamSettings; messages: Kept[] } | undefined {
    const settings = this.made.get(name);
    if (!settings) return undefined;
    return {
      settings,
      messages: this.kept.filter((m) => m.stream === name).map((m) => ({ ...m })),
    };
  }

  /** Makes a stream from a copy, each message at its own place, as the server's restore does. */
  putStream(settings: StreamSettings, messages: readonly Kept[]): void {
    this.made.set(settings.name, settings);
    for (const m of messages) this.kept.push({ ...m, stream: settings.name });
    this.seqs.set(settings.name, messages.at(-1)?.seq ?? 0);
  }

  /** The duplicate window passes: a message id published before is new again, in every stream. */
  forgetIds(): void {
    this.ids.clear();
  }

  /** The messages on a subject, oldest first. */
  on(subject: string): Kept[] {
    return this.kept.filter((m) => m.subject === subject);
  }

  /**
   * Hands each message on `subject` to `handle` once, oldest first, as a work queue's consumer:
   * a message acked is gone; one the handler asks for again stays for the next call.
   */
  async take(
    subject: string,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
  ): Promise<{ acked: number; again: number }> {
    let acked = 0;
    let again = 0;
    for (const m of this.on(subject)) {
      const handled = await handle(asMessage(m));
      if (handled) again++;
      else {
        acked++;
        this.kept.splice(this.kept.indexOf(m), 1);
      }
    }
    return { acked, again };
  }
}

/** A kept message as a handler sees it, its id among its headers as the server keeps it. */
export function asMessage(m: Kept): BusMessage {
  const headers: Record<string, string> = { ...m.headers };
  if (m.id !== undefined) headers["Nats-Msg-Id"] = m.id;
  return {
    subject: m.subject,
    seq: m.seq,
    data: m.bytes ?? new TextEncoder().encode(m.data),
    header: (name) => headers[name],
    at: m.at,
  };
}

/** Lets the work control queued for the bus (each publish waits its turn) run to its end. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}
