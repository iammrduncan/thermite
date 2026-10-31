import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * The live log: what the rig's agents and judge are doing right now, for people watching from
 * control. It is a view, never a record: nothing in it is judged, it is not in the ledger, and it
 * starts empty when the harness controller restarts (a new log id).
 *
 * Sources: "planner", "judge", "trial:<id>" (one worker's session) and "supervisor" (the
 * supervisor's own advisors, relayed unsigned). The harness signs every batch it hands to the
 * supervisor, so control can tell the harness's lines from anything the supervisor might invent.
 */

export const LIVE_KINDS = [
  "text",
  "thinking",
  "tool",
  "result",
  "message",
  "status",
  "log",
] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];

/** The longest line of the live view: a longer one is cut, and says so. */
export const LIVE_TEXT_MAX = 8000;

/**
 * The rig's own credentials as an agent may print them: a trial's, a call's in its terminal, the
 * model proxy's and the MCP gateway's tokens (`trial.`, `call.`, `proxy.` or `mcp.` and hex), and
 * any `THERMITE_*_AUTH` setting.
 */
const RIG_CREDENTIALS =
  /\b(?:(trial|call|proxy|mcp)\.[0-9a-f]{16,}|(THERMITE_[A-Z0-9_]*_AUTH(?:=|\\?["']?\s*:\s*\\?["']?))[^\s"'\\,;}&]+)/g;

/**
 * A line's text as the live view keeps it: the rig's credentials in it masked as `***`, then
 * whole, or cut and marked `[cut]` (goal 171).
 */
export function liveText(text: string): string {
  const masked = text.replace(RIG_CREDENTIALS, (_, kind, setting) =>
    kind ? `${kind}.***` : `${setting}***`,
  );
  return masked.length > LIVE_TEXT_MAX ? `${masked.slice(0, LIVE_TEXT_MAX - 10)} [cut]` : masked;
}

export const LiveEntry = z.object({
  seq: z.number().int().positive(),
  at: z.string().min(1).max(40),
  source: z.string().regex(/^(planner|judge|supervisor|trial:[A-Za-z0-9_-]{1,64})$/),
  kind: z.enum(LIVE_KINDS),
  text: z.string().max(LIVE_TEXT_MAX),
  lane: z.string().max(32).optional(),
  run: z.string().max(80).optional(),
});
export type LiveEntry = z.infer<typeof LiveEntry>;

/** The most lines in one batch: a page of the harness's live log, as control takes it. */
export const LIVE_BATCH_MAX = 2000;

export const LiveBatch = z.object({
  rig: z.string().min(1),
  /** Changes when the controller restarts; sequence numbers start again under a new id. */
  log_id: z.string().min(1).max(64),
  from: z.number().int().min(0),
  next: z.number().int().min(0),
  entries: z.array(LiveEntry).max(LIVE_BATCH_MAX),
  rig_pubkey: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
});
export type LiveBatch = z.infer<typeof LiveBatch>;

/** A live batch as control reads it: its lines checked one by one (readLiveEntries). */
export const LiveBatchWire = LiveBatch.extend({
  entries: z.array(z.unknown()).max(LIVE_BATCH_MAX),
});

/**
 * A batch's lines as control reads them (goal 171): those it knows, and a count of the rest by
 * the kind or source it does not know, so one line from a newer rig never stops the rig's live
 * view. The knowledge base's sync reads items the same way (core/kb.ts: readKbItems).
 */
export function readLiveEntries(raw: unknown[]): {
  entries: LiveEntry[];
  unknown: Record<string, number>;
} {
  const out = { entries: [] as LiveEntry[], unknown: {} as Record<string, number> };
  for (const x of raw) {
    const e = LiveEntry.safeParse(x);
    if (e.success) out.entries.push(e.data);
    else {
      const { kind, source } = (x ?? {}) as { kind?: unknown; source?: unknown };
      const known = (LIVE_KINDS as readonly unknown[]).includes(kind);
      const k = (known ? `source ${String(source)}` : `kind ${String(kind)}`).slice(0, 80);
      out.unknown[k] = (out.unknown[k] ?? 0) + 1;
    }
  }
  return out;
}

/** The part of a live batch its signature covers. */
export function liveBody(
  b: Pick<LiveBatch, "rig" | "log_id" | "from" | "next"> & { entries: readonly unknown[] },
): unknown {
  return { rig: b.rig, log_id: b.log_id, from: b.from, next: b.next, entries: b.entries };
}

/** What a writer appends (the log numbers and times it). */
export interface LiveLine {
  source: string;
  kind: LiveKind;
  text: string;
  lane?: string | undefined;
  run?: string | undefined;
}

/** A bounded in-memory live log. */
export class LiveLog {
  readonly id = randomUUID();
  private entries: LiveEntry[] = [];
  private seq = 0;
  private readonly max: number;
  private readonly clock: () => Date;
  /** Told of each line kept, after it is kept: the harness's watch of its trials (goal 143). */
  private readonly onAppend: ((e: LiveEntry) => void) | undefined;

  constructor(opts: { max?: number; clock?: () => Date; onAppend?: (e: LiveEntry) => void } = {}) {
    this.max = opts.max ?? 5000;
    this.clock = opts.clock ?? (() => new Date());
    this.onAppend = opts.onAppend;
  }

  append(line: LiveLine): void {
    const e: LiveEntry = {
      seq: ++this.seq,
      at: this.clock().toISOString(),
      source: line.source,
      kind: line.kind,
      text: liveText(line.text),
      ...(line.lane ? { lane: line.lane } : {}),
      ...(line.run ? { run: line.run } : {}),
    };
    // Only well-formed lines: a bad source name is dropped, never relayed.
    if (!LiveEntry.safeParse(e).success) return;
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.onAppend?.(e);
  }

  /** Lines after `after`, oldest first, at most `limit`. */
  since(after: number, limit = 500): { entries: LiveEntry[]; next: number } {
    const out = this.entries.filter((e) => e.seq > after).slice(0, limit);
    return { entries: out, next: out.at(-1)?.seq ?? Math.max(after, 0) };
  }

  get latest(): number {
    return this.seq;
  }
}

/** A short, single-line rendering of a tool call's arguments for the live log. */
export function summarizeArgs(args: unknown, max = 300): string {
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  s = s.replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
