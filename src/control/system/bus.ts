import type { ServerFigures } from "../../core/link/users.ts";
import type { BusView } from "../bus/index.ts";
import type { EventKindSize } from "../events/index.ts";

/**
 * The message bus as Metrics' Bus tab shows it (goal 179): the server's own figures, from its
 * monitoring as control's system user asks for them (VARZ, JSZ, CONNZ and LEAFZ), shaped into
 * what the page, REST and MCP give; and the events' sizes by kind, from control's apply. Rates are
 * worked out between two looks: none on the first, nor after a minute with no look.
 */

/** What asks the server for its figures: control's ServerLook, or a test's. */
export interface FiguresAsker {
  ask<T>(what: ServerFigures, options?: Record<string, unknown>): Promise<T>;
}

/** How long a look stays the answer: the page's viewers in the same second share one. */
const BUS_LOOK_KEPT_MS = 1000;
/** The longest time between two looks that rates are worked out over; longer, and none is given. */
const BUS_RATE_WINDOW_MS = 60_000;
/** The share of its limit a stream or the store may hold before the tab warns. */
const BUS_FULL_SHARE = 0.85;
/** How long a durable consumer may take nothing while messages wait for it, before the tab warns. */
const CONSUMER_IDLE_MS = 5 * 60_000;
/** The bytes the server may queue for a client before the tab warns that it falls behind. */
const CLIENT_PENDING_BYTES = 1024 * 1024;
/** How many connections the tab lists at most. */
const CONNECTIONS_MAX = 500;

/** Messages and bytes a second, in and out. */
export interface Traffic {
  in_msgs: number;
  out_msgs: number;
  in_bytes: number;
  out_bytes: number;
}

interface BusServer {
  name: string;
  version: string;
  started: string | null;
  /** The server process's memory, and its CPU as a share of one core (100 is one core). */
  memory_bytes: number;
  cpu_pct: number;
  cores: number;
  connections: number;
  total_connections: number;
  leafnodes: number;
  subscriptions: number;
  slow_consumers: number;
  max_payload: number;
  /** Everything since the server started. */
  total: Traffic;
  /** A second, since the look before; null on the first. */
  rate: Traffic | null;
  /** JetStream's store in memory and on disk, each against its limit; null without JetStream. */
  jetstream: {
    memory_bytes: number;
    memory_max: number;
    store_bytes: number;
    store_max: number;
    api_calls: number;
    api_errors: number;
  } | null;
}

export interface BusStreamFigures {
  name: string;
  account: string;
  created: string | null;
  messages: number;
  bytes: number;
  subjects: number;
  first_seq: number;
  last_seq: number;
  first_at: string | null;
  last_at: string | null;
  /** Places of removed messages inside it (a work queue's taken ones, a purge's). */
  deleted: number;
  consumers: number;
  /** Messages a second since the look before, from its last place; null on the first. */
  rate: number | null;
  config: {
    retention: string;
    storage: string;
    discard: string;
    /** Each limit; null where it has none. */
    max_bytes: number | null;
    max_age_seconds: number | null;
    max_msgs_per_subject: number | null;
    max_msg_size: number | null;
  };
}

interface BusConsumerFigures {
  stream: string;
  name: string;
  durable: boolean;
  /** Its subjects; empty: all the stream's. */
  filter: string[];
  pending: number;
  ack_pending: number;
  redelivered: number;
  waiting: number;
  last_active: string | null;
}

interface BusConnection {
  id: number;
  kind: string;
  /** The name it gave as it connected: `control`, `supervisor <rig>`… */
  name: string;
  /** Whose user key it signed in with, in words; null where control does not know the key. */
  user: string | null;
  account: string | null;
  started: string | null;
  rtt: string | null;
  /** In: what it published. Out: what the server delivered to it. */
  total: Traffic;
  /** Bytes the server queued for it and has not sent yet. */
  pending_bytes: number;
  subscriptions: string[];
  lang: string | null;
  version: string | null;
}

interface BusLeaf {
  name: string;
  account: string | null;
  rtt: string | null;
  total: Traffic;
  subscriptions: number;
}

export interface BusFigures {
  at: string;
  server: BusServer | null;
  streams: BusStreamFigures[];
  consumers: BusConsumerFigures[];
  connections: BusConnection[];
  connections_left_out: number;
  leafnodes: BusLeaf[];
  event_sizes: EventKindSize[];
  /** What looks wrong, in words. */
  warnings: string[];
  /** What the server would not give, in words. */
  errors: string[];
}

// ---------------------------------------------------------------- the monitoring's answers
// Loose: the server's fields as its monitoring names them, each read with a fallback.

interface Varz {
  server_name?: string;
  version?: string;
  start?: string;
  mem?: number;
  cpu?: number;
  cores?: number;
  connections?: number;
  total_connections?: number;
  leafnodes?: number;
  subscriptions?: number;
  slow_consumers?: number;
  max_payload?: number;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  jetstream?: {
    config?: { max_memory?: number; max_storage?: number };
    stats?: { memory?: number; storage?: number; api?: { total?: number; errors?: number } };
  };
}

interface RawConsumer {
  name?: string;
  config?: { durable_name?: string; filter_subject?: string; filter_subjects?: string[] };
  num_pending?: number;
  num_ack_pending?: number;
  num_redelivered?: number;
  num_waiting?: number;
  delivered?: { last_active?: string };
}

interface RawStream {
  name?: string;
  created?: string;
  config?: {
    retention?: string;
    storage?: string;
    discard?: string;
    max_bytes?: number;
    max_age?: number;
    max_msgs_per_subject?: number;
    max_msg_size?: number;
  };
  state?: {
    messages?: number;
    bytes?: number;
    first_seq?: number;
    first_ts?: string;
    last_seq?: number;
    last_ts?: string;
    num_subjects?: number;
    num_deleted?: number;
    consumer_count?: number;
  };
  consumer_detail?: RawConsumer[];
}

interface Jsz {
  account_details?: { name?: string; stream_detail?: RawStream[] }[];
}

interface RawConnection {
  cid?: number;
  kind?: string;
  name?: string;
  start?: string;
  rtt?: string;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  pending_bytes?: number;
  subscriptions_list?: string[];
  authorized_user?: string;
  account?: string;
  lang?: string;
  version?: string;
}

interface Connz {
  total?: number;
  connections?: RawConnection[];
}

interface Leafz {
  leafs?: {
    name?: string;
    account?: string;
    rtt?: string;
    in_msgs?: number;
    out_msgs?: number;
    in_bytes?: number;
    out_bytes?: number;
    subscriptions?: number;
  }[];
}

const n = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const s = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
/** A limit as the server gives it: -1 or 0 for none. */
const limit = (x: unknown): number | null => (typeof x === "number" && x > 0 ? x : null);
/** A time; the server's zero time (year 1) for none. */
const time = (x: unknown): string | null =>
  typeof x === "string" && x && !x.startsWith("0001-") ? x : null;
const traffic = (x: Partial<Record<keyof Traffic, unknown>>): Traffic => ({
  in_msgs: n(x.in_msgs),
  out_msgs: n(x.out_msgs),
  in_bytes: n(x.in_bytes),
  out_bytes: n(x.out_bytes),
});

function streamOf(account: string, x: RawStream, rate: number | null): BusStreamFigures {
  const st = x.state ?? {};
  const c = x.config ?? {};
  return {
    name: String(x.name ?? ""),
    account,
    created: time(x.created),
    messages: n(st.messages),
    bytes: n(st.bytes),
    subjects: n(st.num_subjects),
    first_seq: n(st.first_seq),
    last_seq: n(st.last_seq),
    first_at: n(st.messages) ? time(st.first_ts) : null,
    last_at: n(st.messages) ? time(st.last_ts) : null,
    deleted: n(st.num_deleted),
    consumers: n(st.consumer_count),
    rate,
    config: {
      retention: String(c.retention ?? ""),
      storage: String(c.storage ?? ""),
      discard: String(c.discard ?? ""),
      max_bytes: limit(c.max_bytes),
      // The server gives a duration in nanoseconds.
      max_age_seconds: limit(c.max_age) === null ? null : n(c.max_age) / 1e9,
      max_msgs_per_subject: limit(c.max_msgs_per_subject),
      max_msg_size: limit(c.max_msg_size),
    },
  };
}

function consumerOf(stream: string, x: RawConsumer): BusConsumerFigures {
  const c = x.config ?? {};
  return {
    stream,
    name: String(x.name ?? ""),
    durable: Boolean(c.durable_name),
    filter: c.filter_subjects?.length
      ? [...c.filter_subjects]
      : c.filter_subject
        ? [c.filter_subject]
        : [],
    pending: n(x.num_pending),
    ack_pending: n(x.num_ack_pending),
    redelivered: n(x.num_redelivered),
    waiting: n(x.num_waiting),
    last_active: time(x.delivered?.last_active),
  };
}

const share = (x: number) => `${Math.round(x * 100)}%`;
const mib = (b: number) => `${(b / 2 ** 20).toFixed(1)} MiB`;

/** What looks wrong in a look, in words. */
function warningsOf(f: Omit<BusFigures, "warnings">, now: number): string[] {
  const w: string[] = [];
  const js = f.server?.jetstream;
  if (js && js.store_max > 0 && js.store_bytes / js.store_max > BUS_FULL_SHARE)
    w.push(
      `The bus's store holds ${share(js.store_bytes / js.store_max)} of its limit (${mib(js.store_bytes)} of ${mib(js.store_max)}). A stream kept for good grows until a retention policy removes some; make the store larger or remove some.`,
    );
  for (const x of f.streams) {
    const max = x.config.max_bytes;
    if (max && x.bytes / max > BUS_FULL_SHARE)
      w.push(
        `${x.name} holds ${share(x.bytes / max)} of its limit (${mib(x.bytes)} of ${mib(max)}): ${x.config.discard === "old" ? "it drops its oldest messages as new ones come" : "it refuses new messages when full"}.`,
      );
  }
  for (const c of f.consumers) {
    const idle = c.last_active ? now - Date.parse(c.last_active) : Number.POSITIVE_INFINITY;
    if (c.durable && c.pending > 0 && idle > CONSUMER_IDLE_MS)
      w.push(
        `${c.name} on ${c.stream} has ${c.pending} message${c.pending === 1 ? "" : "s"} waiting and took none for ${Math.round(Math.min(idle, 99 * 3_600_000) / 60_000)} minutes: its reader is away or behind.`,
      );
  }
  for (const x of f.connections)
    if (x.pending_bytes > CLIENT_PENDING_BYTES)
      w.push(
        `The server queues ${mib(x.pending_bytes)} for ${x.name || `connection ${x.id}`} that it has not sent yet: it reads slower than its messages come.`,
      );
  if (f.server?.slow_consumers)
    w.push(
      `The server cut off a client that read too slowly ${f.server.slow_consumers} time${f.server.slow_consumers === 1 ? "" : "s"} since it started.`,
    );
  return w;
}

/** The look before: when, and the counts rates are worked out from. */
interface Before {
  at: number;
  total: Traffic;
  lastSeq: Map<string, number>;
}

interface BusFiguresOptions {
  look?: FiguresAsker | undefined;
  bus?: BusView | undefined;
  /** Who holds each user key the server knows, in words. */
  holders?: (() => ReadonlyMap<string, string>) | undefined;
  now?: (() => number) | undefined;
}

/**
 * The bus's figures, a look at a time: one asked within BUS_LOOK_KEPT_MS of the last is the
 * last, and two asked at once share one look. Without a way to ask the server (a test's control,
 * or control made without its bus), it says so in `errors`.
 */
export class BusFiguresLook {
  private readonly o: BusFiguresOptions;
  private before: Before | undefined;
  private kept: { at: number; figures: BusFigures } | undefined;
  private looking: Promise<BusFigures> | undefined;

  constructor(o: BusFiguresOptions) {
    this.o = o;
  }

  async read(): Promise<BusFigures> {
    const now = (this.o.now ?? Date.now)();
    if (this.kept && now - this.kept.at < BUS_LOOK_KEPT_MS) return this.kept.figures;
    this.looking ??= this.look(now).finally(() => {
      this.looking = undefined;
    });
    return this.looking;
  }

  private async look(now: number): Promise<BusFigures> {
    const errors: string[] = [];
    const sizes = this.o.bus?.apply.sizes.list(now) ?? [];
    const look = this.o.look;
    if (!look) {
      errors.push("control has no message bus to look at");
      return {
        at: new Date(now).toISOString(),
        server: null,
        streams: [],
        consumers: [],
        connections: [],
        connections_left_out: 0,
        leafnodes: [],
        event_sizes: sizes,
        warnings: [],
        errors,
      };
    }
    const asked = <T>(what: ServerFigures, opts: Record<string, unknown>) =>
      look.ask<T>(what, opts).catch((err: unknown) => {
        errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
    const [varz, jsz, connz, leafz] = await Promise.all([
      asked<Varz>("VARZ", {}),
      asked<Jsz>("JSZ", { accounts: true, streams: true, consumer: true, config: true }),
      asked<Connz>("CONNZ", {
        subscriptions: true,
        auth: true,
        limit: CONNECTIONS_MAX,
        sort: "cid",
      }),
      asked<Leafz>("LEAFZ", {}),
    ]);
    const before = this.before && now - this.before.at <= BUS_RATE_WINDOW_MS ? this.before : null;
    const secs = before ? Math.max(0.001, (now - before.at) / 1000) : 0;
    const total = traffic(varz ?? {});
    const per = (a: number, b: number) => Math.max(0, (a - b) / secs);
    const server: BusServer | null = varz
      ? {
          name: String(varz.server_name ?? ""),
          version: String(varz.version ?? ""),
          started: time(varz.start),
          memory_bytes: n(varz.mem),
          cpu_pct: n(varz.cpu),
          cores: n(varz.cores),
          connections: n(varz.connections),
          total_connections: n(varz.total_connections),
          leafnodes: n(varz.leafnodes),
          subscriptions: n(varz.subscriptions),
          slow_consumers: n(varz.slow_consumers),
          max_payload: n(varz.max_payload),
          total,
          rate: before
            ? {
                in_msgs: per(total.in_msgs, before.total.in_msgs),
                out_msgs: per(total.out_msgs, before.total.out_msgs),
                in_bytes: per(total.in_bytes, before.total.in_bytes),
                out_bytes: per(total.out_bytes, before.total.out_bytes),
              }
            : null,
          jetstream: varz.jetstream
            ? {
                memory_bytes: n(varz.jetstream.stats?.memory),
                memory_max: n(varz.jetstream.config?.max_memory),
                store_bytes: n(varz.jetstream.stats?.storage),
                store_max: n(varz.jetstream.config?.max_storage),
                api_calls: n(varz.jetstream.stats?.api?.total),
                api_errors: n(varz.jetstream.stats?.api?.errors),
              }
            : null,
        }
      : null;
    const streams: BusStreamFigures[] = [];
    const consumers: BusConsumerFigures[] = [];
    const lastSeq = new Map<string, number>();
    for (const account of jsz?.account_details ?? [])
      for (const x of account.stream_detail ?? []) {
        const name = String(x.name ?? "");
        const last = n(x.state?.last_seq);
        lastSeq.set(name, last);
        const was = before?.lastSeq.get(name);
        streams.push(
          streamOf(String(account.name ?? ""), x, was === undefined ? null : per(last, was)),
        );
        for (const c of x.consumer_detail ?? []) consumers.push(consumerOf(name, c));
      }
    streams.sort((a, b) => a.name.localeCompare(b.name));
    const holders = this.o.holders?.() ?? new Map<string, string>();
    const connections: BusConnection[] = (connz?.connections ?? []).map((x) => ({
      id: n(x.cid),
      kind: String(x.kind ?? ""),
      name: String(x.name ?? ""),
      user: x.authorized_user ? (holders.get(x.authorized_user) ?? null) : null,
      account: s(x.account),
      started: time(x.start),
      rtt: s(x.rtt),
      total: traffic(x),
      pending_bytes: n(x.pending_bytes),
      subscriptions: [...(x.subscriptions_list ?? [])].sort(),
      lang: s(x.lang),
      version: s(x.version),
    }));
    const leafnodes: BusLeaf[] = (leafz?.leafs ?? []).map((x) => ({
      name: String(x.name ?? ""),
      account: s(x.account),
      rtt: s(x.rtt),
      total: traffic(x),
      subscriptions: n(x.subscriptions),
    }));
    if (varz) this.before = { at: now, total, lastSeq };
    const figures = {
      at: new Date(now).toISOString(),
      server,
      streams,
      consumers,
      connections,
      connections_left_out: Math.max(0, n(connz?.total) - connections.length),
      leafnodes,
      event_sizes: sizes,
      errors,
    };
    const out: BusFigures = { ...figures, warnings: warningsOf(figures, now) };
    this.kept = { at: now, figures: out };
    return out;
  }
}
