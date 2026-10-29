import { randomUUID } from "node:crypto";
import {
  type ConsumerConfig,
  type ConsumerMessages,
  JetStreamApiCodes,
  JetStreamApiError,
  type JsMsg,
  jetstream,
  jetstreamManager,
  type MsgRequest,
  type StoredMsg,
  type StreamConfig,
} from "@nats-io/jetstream";
import {
  connect,
  errors,
  headers,
  type MsgHdrs,
  type NatsConnection,
  nkeyAuthenticator,
  type Subscription,
} from "@nats-io/transport-node";
import { log } from "../env.ts";
import { removeOnceEmpty, startEmptying } from "../work-queue.ts";
import { type BusTrust, tlsOf, where } from "./tls.ts";

export {
  BUS_CA_FILE_SETTING,
  BUS_CA_SETTING,
  BUS_URL_SETTING,
  type BusTrust,
  busHost,
  busTrust,
  busUrl,
} from "./tls.ts";

/**
 * The message bus (goal 168): a NATS server with JetStream, which control runs. Control and the
 * rigs' supervisors reach it through this module alone, which hides the NATS library behind a few
 * calls: a publish that waits for the server's ack, a batch published whole or not at all, a
 * durable consumer whose messages are handed over one at a time, a key-value bucket watched from
 * the latest of each key, a read of a stream in order, a message by its place, a subject's last
 * message, a stream's last place, a stream made, a message removed, the streams' state, and a
 * request with its one answer (where the server and its authority come from: tls.ts). Every
 * connection is over TLS, and trusts the server through the authority it is given (control's own,
 * which control hands every rig it sets up), or else the system's. The harness and the agents
 * never reach the bus.
 */

/** How long a connection attempt may take: the call that needed it fails, the next tries again. */
export const BUS_CONNECT_TIMEOUT_MS = 10_000;
/** How long a publish waits for the server's ack. It then fails; the message may be kept or not. */
export const BUS_ACK_TIMEOUT_MS = 30_000;
/** How long a consumer, or a stream not made, waits after a failure to try again. */
export const BUS_RETRY_MS = 5_000;
/** How many messages on a subject a removal looks at, at most: then it says it found none. */
export const BUS_REMOVE_LOOK_MAX = 1000;
/** How many consumers of a stream its state lists, at most: then it says how many it left out. */
export const BUS_STATE_CONSUMERS_MAX = 200;
/** How many messages a batch holds, at most: the server's own limit, which refuses a larger one. */
export const BUS_BATCH_MAX = 1000;
/** How long a look (a message, a last place, a read's start) waits for the server. It then fails. */
export const BUS_LOOK_TIMEOUT_MS = 10_000;
/** How many messages a read looks at, at most: the largest page control's API gives. */
export const BUS_READ_MAX = 5000;
/** How many bytes of messages a read gathers, at most: it ends after the message that passes it. */
export const BUS_READ_MAX_BYTES = 64 * 1024 * 1024;
/** How long a read may take: it then ends with what it has, and says it is not done. */
export const BUS_READ_TIMEOUT_MS = 30_000;
/** How many bytes the server sends a read at a time: twice the largest message (max_payload). */
const READ_PULL_BYTES = 16 * 1024 * 1024;
/**
 * The server's code for a batch with an id the stream has (in its duplicate window), all or some:
 * it stores none of it. The library says only "batch didn't contain number of published messages".
 */
const BATCH_HAS_A_KEPT_ID = 10201;

/** The server's ack: the message's place in the stream, and whether it had the message's id. */
export interface Published {
  seq: number;
  duplicate: boolean;
}

/**
 * A message to publish: its subject, its data, its id (a stream keeps one message for each id it
 * remembers, within its duplicate window; none, and it remembers nothing) and its headers.
 */
export interface Outgoing {
  subject: string;
  data: string | Uint8Array;
  id?: string | undefined;
  headers?: Record<string, string> | undefined;
}

/** The server's ack of a batch. */
export interface BatchPublished {
  /** The place in the stream of the batch's last message. */
  seq: number;
  /** How many of its messages the stream stored now. */
  stored: number;
  /** Whether the stream had every message of the batch already, by its id, and stored none. */
  duplicate: boolean;
}

/** What a read of a stream gave: its messages, where the next read starts, and whether it is done. */
export interface BusRead {
  /** The messages it looked at that passed its header test, in the stream's order. */
  messages: BusMessage[];
  /** The place after the last message it looked at: where the next read starts. */
  next: number;
  /** Whether it looked at the last message the stream had on its subjects. */
  done: boolean;
}

/** A request on the bus, as the code that answers it sees it. */
export interface BusRequest {
  subject: string;
  /** The subject its answer goes to: the asker's inbox; none for a message that wants none. */
  reply: string | undefined;
  data: Uint8Array;
}

/** A message from a stream, as the code that handles it sees it. */
export interface BusMessage {
  subject: string;
  /** Its place in the stream. */
  seq: number;
  data: Uint8Array;
  header(name: string): string | undefined;
  /** When the stream stored it, by its server's clock; undefined where nothing says. */
  at?: string | undefined;
}

/**
 * How a part signs in to the bus: the seed of its user key, which the server checks against the
 * key's public part in its users; and, for a rig, the start of the subjects it takes replies on,
 * the only ones its user may subscribe to.
 */
export interface BusSignIn {
  seed: Uint8Array;
  inboxPrefix?: string | undefined;
  /** The authority the server's certificate must come from; none: the system's authorities. */
  trust?: BusTrust | undefined;
}

/** A stream as the server has it now, with what each of its consumers has still to take. */
export interface StreamState {
  name: string;
  messages: number;
  bytes: number;
  /** How many subjects hold its messages. */
  subjects: number;
  /** When its oldest and its newest message came; null while it holds none. */
  first_at: string | null;
  last_at: string | null;
  consumers: {
    name: string;
    /** Messages it has not been handed yet. */
    pending: number;
    /** Messages it was handed and has not acked yet. */
    ack_pending: number;
    /** Messages it was handed more than once. */
    redelivered: number;
  }[];
  /** Consumers past BUS_STATE_CONSUMERS_MAX, left out of the list. */
  consumers_left_out: number;
}

export type StreamSettings = Partial<StreamConfig> & { name: string };
export type ConsumerSettings = Partial<ConsumerConfig> & { durable_name: string };

/**
 * What a handler answers for a message: nothing, and the message is acked; or `againInMs`, and it
 * is handed again after that long, while the messages after it go on.
 */
export type Handled = undefined | { againInMs: number };

export interface Bus {
  /**
   * Publishes one message and waits for the server's ack. A message whose id the stream had within
   * its duplicate window is acked as a duplicate and not kept again.
   */
  publish(
    subject: string,
    data: string | Uint8Array,
    o: { id: string; headers?: Record<string, string> | undefined },
  ): Promise<Published>;
  /**
   * Publishes 1 to BUS_BATCH_MAX messages, each with an id of its own or none, as one atomic batch
   * to one stream that allows it (`allow_atomic`), and waits for the server's ack: it stores them
   * all, next to each other and in order, or none, and the batch fails. A batch the stream has
   * every message of already, by the ids it remembers (its duplicate window), is acked as a
   * duplicate. One it has only some of (the server refuses the whole batch then) is published
   * again a message at a time, in order: the stream keeps those it had where they are, and stores
   * the rest after them.
   */
  publishBatch(messages: readonly Outgoing[]): Promise<BatchPublished>;
  /**
   * Reads a stream in order from the place `from` (1, its first, when not given): its messages on
   * `subjects` (any subject a stream's pattern names, `*` and `>` too; all its subjects when none
   * are given), each that passes the header test `headers` (each named header with that value;
   * others are looked at and passed over), until it has looked at `limit` messages (1 to
   * BUS_READ_MAX), gathered BUS_READ_MAX_BYTES, reached the last message, or taken
   * BUS_READ_TIMEOUT_MS. A stream not made yet has nothing to read.
   */
  read(
    stream: string,
    o: {
      subjects?: readonly string[] | undefined;
      from?: number | undefined;
      limit: number;
      headers?: Readonly<Record<string, string>> | undefined;
    },
  ): Promise<BusRead>;
  /** The message at this place in the stream; undefined when it has none there, or no such stream. */
  message(stream: string, seq: number): Promise<BusMessage | undefined>;
  /** The place of the stream's last message: 0 when it has had none, or there is no such stream. */
  lastSeq(stream: string): Promise<number>;
  /**
   * Makes sure the stream and its durable consumer exist, then hands each message to `handle`, in
   * order, one at a time, and acks it when `handle` returns, unless it asks for it again. A
   * message `handle` throws on is handed again after BUS_RETRY_MS. Runs until the bus is closed.
   * `stream` is its settings, and the stream is made or brought to them first; or its name alone,
   * for a stream another part makes, which is waited for. A stream made before that is a work
   * queue now, which the server can't change in place, is first emptied by the consumer, its
   * subjects taken off it meanwhile, then made anew (work-queue.ts).
   */
  follow(
    stream: StreamSettings | string,
    consumer: ConsumerSettings,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
  ): Promise<void>;
  /**
   * As follow, for a key-value bucket's reader: the durable consumer is made again each time
   * watching starts, and after a failure, so `handle` gets the newest message of each subject the
   * consumer takes first (its deliver policy `last_per_subject`), then each new one. The stream is
   * another part's, and is waited for.
   */
  watch(
    stream: string,
    consumer: ConsumerSettings,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
  ): Promise<void>;
  /** The newest message on `subject`; undefined when it has none, or there is no such stream. */
  last(stream: string, subject: string): Promise<BusMessage | undefined>;
  /**
   * Makes the stream, or brings an existing one to these settings, and tries again every
   * BUS_RETRY_MS until it has, or the bus is closed.
   */
  makeStream(stream: StreamSettings): Promise<void>;
  /**
   * Removes the message with this id from the stream, looking among the messages on its subject.
   * False when it is not there, as when a work queue's consumer took it already.
   */
  remove(stream: string, subject: string, id: string): Promise<boolean>;
  /** The state of each of these streams the server has; a stream not made yet is left out. */
  streams(names: readonly string[]): Promise<StreamState[]>;
  /**
   * Sends a request on `subject` and waits up to `timeoutMs` for its one answer (NATS's request
   * and reply, which no stream keeps). It fails when no one serves the subject, on the timeout, or
   * when the bus can't be reached.
   */
  request(subject: string, data: string | Uint8Array, timeoutMs: number): Promise<Uint8Array>;
  /**
   * Answers each request on `subject` (`*` and `>` stand for tokens) with what `answer` gives
   * for it (its subject, the subject its answer goes to, and its data), until the bus is closed,
   * and subscribes again after a failure. A request `answer` gives nothing for, or throws on, gets
   * no answer, and its asker's wait ends with its timeout.
   */
  serve(
    subject: string,
    answer: (request: BusRequest) => Promise<string | undefined>,
  ): Promise<void>;
  /** Whether the part holds a connection to the server now. */
  connected(): boolean;
  close(): Promise<void>;
}

/**
 * Whether the server refused a publish for good, so that the same message would be refused
 * again: its user may not publish to the subject, or the stream refused the message itself. Any
 * other failure, such as no ack in time or no stream yet, may pass.
 */
export function refusedForGood(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++, e = e.cause)
    if (e instanceof errors.PermissionViolationError || e instanceof JetStreamApiError) return true;
  return false;
}

/**
 * Logs the connection's changes (a drop, a reconnect, an error from the server) and tells
 * `up` whether the connection holds now.
 */
async function watch(nc: NatsConnection, server: string, up: (on: boolean) => void): Promise<void> {
  log("bus", "connected", { server });
  up(true);
  for await (const s of nc.status()) {
    if (s.type === "disconnect") {
      up(false);
      log("bus", "disconnected; reconnecting", { server }, "warn");
    } else if (s.type === "reconnect") {
      up(true);
      log("bus", "reconnected", { server });
    } else if (s.type === "error")
      log("bus", "server error", { server, error: String(s.error) }, "warn");
  }
}

/** Makes the stream, or brings an existing one to these settings. */
async function ensureStream(nc: NatsConnection, stream: StreamSettings): Promise<void> {
  const jsm = await jetstreamManager(nc);
  try {
    await jsm.streams.info(stream.name);
  } catch (err) {
    if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound))
      throw err;
    await jsm.streams.add(stream);
    log("bus", "stream made", { stream: stream.name });
    return;
  }
  await jsm.streams.update(stream.name, stream);
}

/** Makes the durable consumer unless it exists; `again`: removes it first, and makes it anew. */
async function ensureConsumer(
  nc: NatsConnection,
  stream: string,
  consumer: ConsumerSettings,
  again = false,
): Promise<void> {
  // No check of the account's JetStream first: a rig's user may not read the account's figures.
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  if (again)
    await jsm.consumers.delete(stream, consumer.durable_name).catch((err: unknown) => {
      // Not there to remove: made below. No such stream: said below, as for any consumer.
      const gone: number[] = [JetStreamApiCodes.ConsumerNotFound, JetStreamApiCodes.StreamNotFound];
      if (!(err instanceof JetStreamApiError && gone.includes(err.code))) throw err;
    });
  try {
    await jsm.consumers.info(stream, consumer.durable_name);
  } catch (err) {
    if (err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound)
      throw new Error(`no stream ${stream} on the bus yet: control makes it`, { cause: err });
    if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound))
      throw err;
    await jsm.consumers.add(stream, consumer);
    log("bus", "consumer made", { stream, consumer: consumer.durable_name });
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether the server said there is no such stream. */
const noSuchStream = (err: unknown) =>
  err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound;

/** The words for a subject no stream takes, as before control made its stream. */
const noStreamTakes = (subject: string, cause: unknown) =>
  new Error(`no stream on the bus takes ${subject} yet: control makes it`, { cause });

/** A message from the server (to a consumer, or by its place), as the code that handles it sees it. */
const asBusMessage = (m: JsMsg | StoredMsg, h: MsgHdrs | undefined): BusMessage => ({
  subject: m.subject,
  seq: m.seq,
  data: m.data,
  header: (k) => h?.get(k) || undefined,
  at: m.time.toISOString(),
});

/** Whether a message has each of these headers with this value. */
const passes = (m: BusMessage, test: Readonly<Record<string, string>> | undefined) =>
  !test || Object.entries(test).every(([k, v]) => m.header(k) === v);

/** The server's answer to a batch's first message (empty, once the batch began) or to its last. */
interface BatchAnswer {
  error?: { code: number; err_code: number; description: string };
  seq?: number;
  count?: number;
}

/**
 * Sends a batch: each message with the batch's id and its place in it. The server answers the
 * first, which begins the batch, and the last, which commits it; those between go without waiting,
 * and the server holds them until the commit. Throws the server's refusal as a JetStreamApiError.
 */
async function sendBatch(nc: NatsConnection, batch: readonly Outgoing[]): Promise<number> {
  if (batch.length < 1 || batch.length > BUS_BATCH_MAX)
    throw new Error(`a batch holds 1 to ${BUS_BATCH_MAX} messages, not ${batch.length}`);
  const ids = batch.flatMap((m) => (m.id ? [m.id] : []));
  if (new Set(ids).size !== ids.length) throw new Error("a batch holds each message id once");
  const id = randomUUID();
  let answer: BatchAnswer = {};
  for (const [i, m] of batch.entries()) {
    const last = i === batch.length - 1;
    const h = headers();
    for (const [k, v] of Object.entries(m.headers ?? {})) h.set(k, v);
    if (m.id) h.set("Nats-Msg-Id", m.id);
    h.set("Nats-Batch-Id", id);
    h.set("Nats-Batch-Sequence", String(i + 1));
    if (last) h.set("Nats-Batch-Commit", "1");
    if (i > 0 && !last) {
      nc.publish(m.subject, m.data, { headers: h });
      continue;
    }
    const r = await nc
      .request(m.subject, m.data, { headers: h, timeout: BUS_ACK_TIMEOUT_MS })
      .catch((err: unknown) => {
        if (err instanceof errors.RequestError && err.isNoResponders())
          throw noStreamTakes(m.subject, err);
        throw err;
      });
    answer = r.data.length ? r.json<BatchAnswer>() : {};
    if (answer.error) throw new JetStreamApiError(answer.error);
  }
  if (answer.count !== batch.length || answer.seq === undefined)
    throw new Error(`the bus acked a batch of ${batch.length} as ${JSON.stringify(answer)}`);
  return answer.seq;
}

/**
 * A connection to the server at `url` as `name`, over TLS, signed in with `signIn` when given;
 * after a drop it tries `reconnects` times (-1: for ever).
 */
function connectTo(url: string, name: string, signIn: BusSignIn | undefined, reconnects: number) {
  const auth = signIn && {
    authenticator: nkeyAuthenticator(signIn.seed),
    inboxPrefix: signIn.inboxPrefix,
  };
  const tls = tlsOf(signIn?.trust, url);
  return connect({
    servers: url,
    name,
    timeout: BUS_CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: reconnects,
    tls,
    ...auth,
  });
}

/** A connection of its own, for calls that end: it never reconnects, and the caller closes it. */
export const connectOnce = (
  url: string,
  name: string,
  signIn: BusSignIn,
): Promise<NatsConnection> => connectTo(url, name, signIn, 0);

/**
 * The bus at `url`, as `name` (the part and its rig, shown in the server's list of connections),
 * signed in with `signIn` when given. It connects on first use, and again after a connection fails
 * or the client gave one up, as after the server refused its user; the NATS client reconnects on
 * its own after a drop.
 */
export function natsBus(url: string, name: string, signIn?: BusSignIn): Bus {
  const server = where(url);
  let conn: Promise<NatsConnection> | undefined;
  let closed = false;
  let up = false;
  /** The consumers being read now, each by its own loop: a close stops them all. */
  const readings = new Set<ConsumerMessages>();
  /** The subjects it serves now: a close ends them all. */
  const serving = new Set<Subscription>();
  const connection = (): Promise<NatsConnection> => {
    if (conn) return conn;
    const made = connectTo(url, name, signIn, -1).then(
      (nc) => {
        void watch(nc, server, (on) => {
          up = on;
        });
        // Given up (its user refused twice running): the next call connects again.
        void nc.closed().then(() => {
          up = false;
          if (conn === made) conn = undefined;
        });
        return nc;
      },
      (err: unknown) => {
        conn = undefined;
        throw err;
      },
    );
    conn = made;
    return made;
  };
  /** Follows or watches a consumer (`again`: made anew each time), until the bus is closed. */
  const consume = async (
    stream: StreamSettings | string,
    consumer: ConsumerSettings,
    handle: (m: BusMessage) => Handled | Promise<Handled>,
    again: boolean,
  ): Promise<void> => {
    const name = typeof stream === "string" ? stream : stream.name;
    // A failure is logged as an error once, and again only after following worked.
    let failing = false;
    following: while (!closed) {
      let reading: ConsumerMessages | undefined;
      try {
        const nc = await connection();
        const emptying = typeof stream !== "string" && (await startEmptying(nc, stream));
        if (typeof stream !== "string" && !emptying) await ensureStream(nc, stream);
        await ensureConsumer(nc, name, consumer, again);
        const empty = () => removeOnceEmpty(nc, name, consumer.durable_name);
        if (emptying && (await empty())) continue;
        const c = await jetstream(nc).consumers.get(name, consumer.durable_name);
        reading = await c.consume();
        readings.add(reading);
        failing = false;
        log("bus", "following", { stream: name, consumer: consumer.durable_name });
        for await (const m of reading) {
          let handled: Handled;
          try {
            handled = await handle(asBusMessage(m, m.headers));
          } catch (err) {
            // Handed again after the wait; a consumer with one message in flight hands no later
            // message first.
            m.nak(BUS_RETRY_MS);
            throw err;
          }
          if (handled) m.nak(handled.againInMs);
          else if (emptying) await m.ackAck();
          else m.ack();
          // The last message of a stream being emptied: it is made anew at once.
          if (emptying && !handled && m.info.pending === 0 && (await empty())) continue following;
        }
      } catch (err) {
        if (closed) break;
        const error = String(err);
        const level = failing ? "debug" : "error";
        log("bus", "following failed; trying again", { stream: name, error }, level);
        failing = true;
      } finally {
        if (reading) {
          reading.stop();
          readings.delete(reading);
        }
      }
      if (!closed) await pause(BUS_RETRY_MS);
    }
  };
  /** Publishes one message and waits for the server's ack. */
  const publishOne = async (m: Outgoing): Promise<Published> => {
    const nc = await connection();
    const h = headers();
    for (const [k, v] of Object.entries(m.headers ?? {})) h.set(k, v);
    const ack = await jetstream(nc)
      .publish(m.subject, m.data, { msgID: m.id, headers: h, timeout: BUS_ACK_TIMEOUT_MS })
      .catch((err: unknown) => {
        // The library's words for a subject no stream takes, as before control made it.
        if (err instanceof Error && err.name === "JetStreamNotEnabled")
          throw noStreamTakes(m.subject, err);
        throw err;
      });
    return { seq: ack.seq, duplicate: ack.duplicate };
  };
  /**
   * A batch the stream has some or all of: each message published on its own, in order, those it
   * has acked as duplicates and not stored again.
   */
  const publishEach = async (batch: readonly Outgoing[]): Promise<BatchPublished> => {
    let seq = 0;
    let stored = 0;
    for (const m of batch) {
      const ack = await publishOne(m);
      seq = ack.seq;
      if (!ack.duplicate) stored++;
    }
    const what = { messages: batch.length, stored, last_seq: seq };
    if (!stored) log("bus", "the stream had this batch already", what);
    else log("bus", "the stream had part of a batch; the rest stored one by one", what, "warn");
    return { seq, stored, duplicate: stored === 0 };
  };
  return {
    publish(subject, data, o) {
      return publishOne({ subject, data, id: o.id, headers: o.headers });
    },
    async publishBatch(batch) {
      try {
        const seq = await sendBatch(await connection(), batch);
        return { seq, stored: batch.length, duplicate: false };
      } catch (err) {
        if (!(err instanceof JetStreamApiError && err.code === BATCH_HAS_A_KEPT_ID)) throw err;
      }
      return await publishEach(batch);
    },
    async read(stream, o) {
      const from = o.from ?? 1;
      if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > BUS_READ_MAX)
        throw new Error(`a read looks at 1 to ${BUS_READ_MAX} messages, not ${o.limit}`);
      if (!Number.isInteger(from) || from < 1)
        throw new Error(`a read starts at 1 or after, not ${from}`);
      const js = jetstream(await connection(), { timeout: BUS_LOOK_TIMEOUT_MS });
      // An ordered consumer, made for this read alone, in the server's memory, and removed after.
      const subjects = o.subjects?.length ? { filter_subjects: [...o.subjects] } : {};
      const c = await js.consumers
        .get(stream, { ...subjects, opt_start_seq: from })
        .catch((err: unknown) => {
          if (noSuchStream(err)) return undefined;
          throw err;
        });
      const out: BusRead = { messages: [], next: from, done: true };
      if (!c) return out;
      try {
        if ((await c.info(true)).num_pending === 0) return out;
        out.done = false;
        let looked = 0;
        let bytes = 0;
        const reading = await c.consume({ max_bytes: READ_PULL_BYTES });
        const timer = setTimeout(() => reading.stop(), BUS_READ_TIMEOUT_MS);
        try {
          for await (const m of reading) {
            looked++;
            bytes += m.data.length;
            out.next = m.seq + 1;
            const message = asBusMessage(m, m.headers);
            if (passes(message, o.headers)) out.messages.push(message);
            out.done = m.info.pending === 0;
            if (out.done || looked >= o.limit || bytes >= BUS_READ_MAX_BYTES) break;
          }
        } finally {
          clearTimeout(timer);
          reading.stop();
        }
        return out;
      } finally {
        await c.delete().catch((err: unknown) => {
          // Not removed: the server removes it itself once it has gone unused for five minutes.
          log("bus", "a read's consumer not removed", { stream, error: String(err) }, "debug");
        });
      }
    },
    async message(stream, seq) {
      const jsm = await jetstreamManager(await connection(), { timeout: BUS_LOOK_TIMEOUT_MS });
      const m = await jsm.streams.getMessage(stream, { seq }).catch((err: unknown) => {
        if (noSuchStream(err)) return null;
        throw err;
      });
      return m ? asBusMessage(m, m.header) : undefined;
    },
    async lastSeq(stream) {
      const jsm = await jetstreamManager(await connection(), { timeout: BUS_LOOK_TIMEOUT_MS });
      const info = await jsm.streams.info(stream).catch((err: unknown) => {
        if (noSuchStream(err)) return undefined;
        throw err;
      });
      return info?.state.last_seq ?? 0;
    },
    follow(stream, consumer, handle) {
      return consume(stream, consumer, handle, false);
    },
    watch(stream, consumer, handle) {
      return consume(stream, consumer, handle, true);
    },
    async last(stream, subject) {
      const jsm = await jetstreamManager(await connection());
      // The server finds the last message on a subject; the library's type names other ways to ask.
      const query = { last_by_subj: subject } as unknown as MsgRequest;
      const m = await jsm.streams.getMessage(stream, query).catch((err: unknown) => {
        if (noSuchStream(err)) return null;
        throw err;
      });
      return m ? asBusMessage(m, m.header) : undefined;
    },
    async makeStream(stream) {
      let failing = false;
      while (!closed) {
        try {
          await ensureStream(await connection(), stream);
          return;
        } catch (err) {
          if (closed) break;
          const what = { stream: stream.name, error: String(err) };
          log("bus", "making the stream failed; trying again", what, failing ? "debug" : "error");
          failing = true;
        }
        await pause(BUS_RETRY_MS);
      }
    },
    async remove(stream, subject, id) {
      const jsm = await jetstreamManager(await connection());
      let after = 0;
      for (let looked = 0; looked < BUS_REMOVE_LOOK_MAX; looked++) {
        // The server finds the next message on a subject from a place in the stream; the library's
        // type for this call names only the other two ways to ask (by place, and the last one).
        const next = { next_by_subj: subject, seq: after + 1 } as unknown as MsgRequest;
        const m = await jsm.streams.getMessage(stream, next);
        if (!m) return false;
        if (m.header.get("Nats-Msg-Id") === id)
          return await jsm.streams.deleteMessage(stream, m.seq);
        after = m.seq;
      }
      return false;
    },
    async streams(names) {
      const jsm = await jetstreamManager(await connection());
      const out: StreamState[] = [];
      for (const name of names) {
        let info: Awaited<ReturnType<typeof jsm.streams.info>>;
        try {
          info = await jsm.streams.info(name);
        } catch (err) {
          if (err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound)
            continue;
          throw err;
        }
        const st = info.state;
        const consumers: StreamState["consumers"] = [];
        let leftOut = 0;
        for await (const c of jsm.consumers.list(name)) {
          if (consumers.length >= BUS_STATE_CONSUMERS_MAX) {
            leftOut++;
            continue;
          }
          consumers.push({
            name: c.name,
            pending: c.num_pending,
            ack_pending: c.num_ack_pending,
            redelivered: c.num_redelivered,
          });
        }
        const at = (ts: string) => (st.messages && !ts.startsWith("0001") ? ts : null);
        out.push({
          name,
          messages: st.messages,
          bytes: st.bytes,
          subjects: st.num_subjects ?? 0,
          first_at: at(st.first_ts),
          last_at: at(st.last_ts),
          consumers,
          consumers_left_out: leftOut,
        });
      }
      return out;
    },
    async request(subject, data, timeoutMs) {
      const nc = await connection();
      const r = await nc.request(subject, data, { timeout: timeoutMs }).catch((err: unknown) => {
        if (err instanceof errors.RequestError && err.isNoResponders())
          throw new Error(`no one answers on ${subject} now`, { cause: err });
        throw err;
      });
      return r.data;
    },
    async serve(subject, answer) {
      let failing = false;
      while (!closed) {
        let sub: Subscription | undefined;
        try {
          sub = (await connection()).subscribe(subject);
          serving.add(sub);
          failing = false;
          log("bus", "serving", { subject });
          for await (const m of sub)
            answer({ subject: m.subject, reply: m.reply || undefined, data: m.data }).then(
              (a) => {
                if (a !== undefined) m.respond(a);
              },
              (err: unknown) =>
                log("bus", "a request got no answer", { subject: m.subject, error: String(err) }),
            );
        } catch (err) {
          if (closed) break;
          const what = { subject, error: String(err) };
          log("bus", "serving failed; trying again", what, failing ? "debug" : "error");
          failing = true;
        } finally {
          if (sub) serving.delete(sub);
        }
        if (!closed) await pause(BUS_RETRY_MS);
      }
    },
    connected: () => up,
    async close() {
      closed = true;
      for (const r of readings) r.stop();
      for (const sub of serving) sub.unsubscribe();
      const nc = await conn?.catch(() => undefined);
      await nc?.close();
    },
  };
}
