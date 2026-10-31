import type { KbKind } from "./kb.ts";

/**
 * An item of the knowledge base's records slots as Thermite's reading keeps it (core/kb-index.ts):
 * its fields, how a change merges into them, the target the reading writes to, and the small
 * helpers its words are made with. Shared by control's store and a rig's export.
 */

type Row = Record<string, unknown>;

export const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The longest item text, in characters (a source's text and a document are cut to it). */
export const KB_BODY_MAX = 20_000;

/**
 * A text cut to `n` characters, with a line that says so: a cut is never silent (goal 162). The
 * line says how long the whole is, and that the run's research folder keeps it whole.
 */
export function cutSaid(text: string, n: number, what: string): string {
  if (text.length <= n) return text;
  const said = `\n\n(Cut: the ${what} has ${text.length} characters; the run's research folder keeps it whole.)`;
  return `${text.slice(0, Math.max(0, n - said.length))}${said}`;
}

/** What a change gives an item; a field left out keeps what the item had. */
export interface KbFields {
  title?: string | undefined;
  body?: string | undefined;
  by?: string | undefined;
  url?: string | null | undefined;
  sub?: string | null | undefined;
  meta?: Record<string, string> | undefined;
}

/** An item's stored fields (meta as JSON). */
export interface KbStored {
  title: string;
  body: string;
  by: string;
  url: string | null;
  sub: string | null;
  meta: string;
}

/** An item's fields after a change: what the change gives, else what the item had. */
export function mergeItem(ref: string, old: KbStored | undefined, f: KbFields): KbStored {
  const url = f.url !== undefined ? f.url : (old?.url ?? null);
  const sub = f.sub !== undefined ? f.sub : (old?.sub ?? null);
  return {
    title: clip(f.title ?? old?.title ?? "", 300) || ref,
    body: clip(f.body ?? old?.body ?? "", KB_BODY_MAX),
    by: clip(f.by ?? (old?.by || "harness"), 200),
    url: url && url.length <= 2000 ? url : null,
    sub: sub ? clip(sub, 40) : null,
    meta: f.meta ? JSON.stringify(f.meta) : old?.meta || "{}",
  };
}

/** Whether a change left an item as it was (it then keeps its place in every sync). */
export function sameItem(a: KbStored, b: KbStored): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.by === b.by &&
    a.url === b.url &&
    a.sub === b.sub &&
    a.meta === b.meta
  );
}

/** An item as the reading changes it: its text, and the fields its state is kept in. */
export interface KbHeld {
  body: string;
  meta: Record<string, string>;
}

/** An item's stored meta (JSON) as fields; anything else is none. */
export function metaOf(json: string | undefined): Record<string, string> {
  try {
    const m = JSON.parse(json ?? "{}") as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Where the items of one reading go: control's store, or an export's. */
export interface KbIndexTarget {
  /** A run started: its campaign as its event names it (the target decides where to file it). */
  runCreated(run: string, named: string): void;
  /** An item, when the target has it. */
  item(run: string, kind: KbKind, ref: string): KbHeld | undefined;
  /** An attempt's item, found by its ref alone (a verdict names only its attempt). */
  attempt(ref: string): ({ run: string } & KbHeld) | undefined;
  /** A new item, or a change to one (the target merges it with mergeItem). */
  put(run: string, kind: KbKind, ref: string, f: KbFields, at: string): void;
}

/** One event of a run's ledger, as the reading takes it. */
export interface KbEvent {
  at: string;
  actor: string;
  kind: string;
  subject: string;
  body: Row;
}

export const lines = (xs: string[]) => xs.filter(Boolean).join("\n");

/** A text with its line that starts with `label: ` replaced (or added at the end). */
export function setLine(body: string, label: string, line: string): string {
  const kept = body.split("\n").filter((l) => !l.startsWith(`${label}: `));
  return lines([...kept, line]).trim();
}

/** A number in words with its thousands marked; anything else as text. */
export const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : str(v));
