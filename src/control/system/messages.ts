import type { Bus, BusMessage } from "../../common/bus/index.ts";
import { BadInput } from "../../common/errors.ts";
import { BUS_STREAMS, type BusView } from "../bus/index.ts";

/**
 * Metrics' stream inspector (goal 179): a stream's messages, newest first, a page at a time,
 * filtered by subject; and one message whole. It reads with the server's message lookup alone
 * (Bus.next and Bus.message), so it makes no consumer and hands, acks or removes nothing: it reads
 * a work queue as it reads any stream, and a reader of it changes nothing for the rigs.
 *
 * A page newer than a place reads forward from it. A page older than a place reads back in
 * windows of places, each scanned forward, each larger as the subject's messages are sparser,
 * until it has a page, reaches the stream's start, or has made STREAM_LOOKUPS_MAX lookups.
 */

/** How many messages a page shows. */
const STREAM_PAGE = 25;
/** How many lookups one page may make at most: past it, the page says it was cut. */
export const STREAM_LOOKUPS_MAX = 500;
/** How much of a message's text the list shows of it. */
const PREVIEW_CHARS = 160;
/** The longest subject filter. */
const SUBJECT_FILTER_MAX = 256;

/** A subject filter: tokens of letters, digits, `_` and `-`, or `*`, and `>` only as the last. */
const TOKEN = /^(?:[A-Za-z0-9_$-]+|\*)$/;

/** The streams the inspector reads: those control makes. */
export const inspectable = (stream: string): boolean =>
  (BUS_STREAMS as readonly string[]).includes(stream);

/** A subject filter as asked, checked; all the stream's subjects (`>`) when none is given. */
export function subjectFilter(asked: string | undefined): string {
  const f = (asked ?? "").trim();
  if (!f) return ">";
  const tokens = f.split(".");
  const ok =
    f.length <= SUBJECT_FILTER_MAX &&
    tokens.every((t, i) => TOKEN.test(t) || (t === ">" && i === tokens.length - 1));
  if (!ok)
    throw new BadInput(
      `subject is refused: a subject is tokens of letters, digits, _ and -, with * for one token and > for the rest, as the last; at most ${SUBJECT_FILTER_MAX} characters`,
    );
  return f;
}

/** A message as a page lists it: no data, its size and the start of its text. */
interface StreamMessageRow {
  seq: number;
  subject: string;
  at: string | null;
  bytes: number;
  headers: Record<string, string>;
  /** The start of its data as text; null for data that is not text. */
  preview: string | null;
}

export interface MessagesPage {
  stream: string;
  subject: string;
  /** The stream's last place now. */
  last_seq: number;
  /** Newest first. */
  messages: StreamMessageRow[];
  /** The place to ask `before` for the next older page; null at the stream's start. */
  older: number | null;
  /** The place to ask `after` for the next newer page; null at its end. */
  newer: number | null;
  /** Why the page has fewer messages than it could: it made STREAM_LOOKUPS_MAX lookups. */
  cut: string | null;
}

/** A message whole, for one message's view. */
export interface StreamMessage extends StreamMessageRow {
  data: Uint8Array;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Data as text, if it is text: UTF-8 with no control character but tab, newline and return. */
export function asText(data: Uint8Array): string | null {
  try {
    const t = decoder.decode(data);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters mark data that is not text
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t) ? null : t;
  } catch {
    // Not UTF-8: bytes, shown as bytes.
    return null;
  }
}

function rowOf(m: BusMessage): StreamMessageRow {
  const text = asText(m.data.subarray(0, PREVIEW_CHARS * 4));
  return {
    seq: m.seq,
    subject: m.subject,
    at: m.at ?? null,
    bytes: m.data.length,
    headers: m.headers?.() ?? {},
    preview: text === null ? null : text.slice(0, PREVIEW_CHARS),
  };
}

type Reader = Pick<Bus, "next" | "lastSeq">;

/** The lookups the inspector reads with, from control's bus; undefined where it has none. */
export function streamReader(
  view: BusView | undefined,
): Pick<Bus, "next" | "lastSeq" | "message"> | undefined {
  const bus = view?.bus;
  if (!bus?.next || !bus.message) return undefined;
  const { next, message } = bus;
  return { lastSeq: bus.lastSeq.bind(bus), next: next.bind(bus), message: message.bind(bus) };
}

/** One page of a stream's messages on `subject`, newer than `after` or older than `before`. */
export async function streamPage(
  bus: Reader,
  stream: string,
  o: { subject?: string | undefined; before?: number | undefined; after?: number | undefined },
  limit = STREAM_PAGE,
): Promise<MessagesPage> {
  if (!inspectable(stream))
    throw new BadInput(`stream is refused: it is one of ${BUS_STREAMS.join(", ")}`);
  const subject = subjectFilter(o.subject);
  const last = await bus.lastSeq(stream);
  let lookups = 0;
  const next = (from: number) => {
    lookups++;
    return bus.next(stream, from, subject);
  };
  const page = (
    rows: BusMessage[],
    older: number | null,
    newer: number | null,
    cut: string | null,
  ) => ({
    stream,
    subject,
    last_seq: last,
    messages: rows.map(rowOf).sort((a, b) => b.seq - a.seq),
    older,
    newer,
    cut,
  });
  if (o.after !== undefined) {
    // Forward from the place after `after`: one lookup past the page says whether more come.
    const rows: BusMessage[] = [];
    let at = Math.max(0, o.after) + 1;
    let more = false;
    while (at <= last) {
      const m = await next(at);
      if (!m || m.seq > last) break;
      if (rows.length === limit) {
        more = true;
        break;
      }
      rows.push(m);
      at = m.seq + 1;
    }
    const first = rows[0]?.seq;
    const top = rows.at(-1)?.seq;
    return page(
      rows,
      first !== undefined && first > 1 ? first : null,
      more && top ? top : null,
      null,
    );
  }
  // Back from the place before `before` (the stream's end when not given).
  const top = Math.min(last, (o.before ?? last + 1) - 1);
  let rows: BusMessage[] = [];
  let hi = top;
  let width = limit;
  let cut: string | null = null;
  // Older messages left out of a window that held more than the page needed.
  let leftOut = false;
  while (hi >= 1 && rows.length < limit) {
    // A window no wider than the lookups left: one holds at most a message a place, and a lookup
    // past them says it ended, so each window is read to its end and the page has no gap.
    const left = STREAM_LOOKUPS_MAX - lookups - 1;
    if (left < 1) {
      cut = `This page stopped after ${STREAM_LOOKUPS_MAX} lookups; Older goes on from here.`;
      break;
    }
    const lo = Math.max(1, hi - Math.min(width, left) + 1);
    const found: BusMessage[] = [];
    let at = lo;
    while (at <= hi) {
      const m = await next(at);
      if (!m || m.seq > hi) break;
      found.push(m);
      at = m.seq + 1;
    }
    if (found.length > limit - rows.length) leftOut = true;
    rows = [...found.slice(-(limit - rows.length)), ...rows];
    // The next window back: wider where this one held fewer of the subject's messages.
    const need = limit - rows.length;
    width = Math.min(
      1e12,
      width * (found.length ? Math.max(2, Math.ceil((2 * need) / found.length)) : 8),
    );
    hi = lo - 1;
  }
  // The next older page starts below the oldest shown, or below where a cut page stopped.
  const oldest = rows[0]?.seq ?? (cut ? hi + 1 : undefined);
  const older = oldest !== undefined && (hi >= 1 || leftOut) ? oldest : null;
  return page(rows, older, top < last ? top : null, cut);
}

/** One message of a stream, whole; undefined when the stream has none at that place. */
export async function streamMessage(
  bus: Pick<Bus, "message">,
  stream: string,
  seq: number,
): Promise<StreamMessage | undefined> {
  if (!inspectable(stream))
    throw new BadInput(`stream is refused: it is one of ${BUS_STREAMS.join(", ")}`);
  if (!Number.isInteger(seq) || seq < 1) throw new BadInput("seq is refused: a place is 1 or more");
  const m = await bus.message(stream, seq);
  return m ? { ...rowOf(m), data: m.data } : undefined;
}
