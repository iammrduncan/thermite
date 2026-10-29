import { z } from "zod";
import { MAX_LANES } from "./contract.ts";
import { NAME_PATTERN } from "./ids.ts";
import { KB_BODY_MAX } from "./kb-index.ts";

/**
 * Thermite's own knowledge base (goals 065 and 175), and its words. The knowledge base is on
 * control. It holds one collection for each campaign; a collection holds the campaign's runs; a run
 * holds slots, one for each writer; a slot holds items, and each item its versions. Thermite's code
 * writes each run's `records` slot from the run's signed events; an agent writes only its own slot,
 * with a `kb_item` event that its harness records signed. Control also sends a rig's supervisor the
 * items of the collections a run's campaign may read. Items are the agents' and the judge's
 * records: data, never instructions.
 */
export const KbKind = z.enum([
  "run",
  "trial",
  "experiment",
  "attempt",
  "note",
  "doc",
  "source",
  "claim",
  "hypothesis",
  "finding",
  "report",
  "decision",
  "surprise",
  "journal",
  "review",
  "reference",
  "paper",
]);
export type KbKind = z.infer<typeof KbKind>;

/**
 * The kinds a `kb_item` event writes: blurbs (a short text) or files (a document kept whole). The
 * records slot's runs, trials, experiments, attempts, sources, claims and hypotheses come only from
 * Thermite's reading of the run's signed events (core/kb-index.ts). Which writer may write which
 * kind is set later, on the campaign (goal 175, step 3): every writer may write each of these now.
 */
export const KB_WRITTEN_KINDS = [
  "note",
  "decision",
  "surprise",
  "journal",
  "finding",
  "review",
  "doc",
  "reference",
  "report",
  "paper",
] as const satisfies readonly KbKind[];
export const KbWrittenKind = z.enum(KB_WRITTEN_KINDS);
export type KbWrittenKind = z.infer<typeof KbWrittenKind>;

/** A kind's plural, as collections and counts say it: notes, hypotheses. */
export const kbPlural = (kind: string): string =>
  kind === "hypothesis" ? "hypotheses" : `${kind}s`;

// ---------------------------------------------------------------- slots and addresses

/** The slot Thermite's code writes in each run: the records it reads from the run's events. */
export const KB_RECORDS = "records";

/**
 * The agents' slots, one for each writer, as goal 166's roles name them; a worker's has its lane,
 * `worker-<lane>` (workerSlot). A writer writes only its own slot.
 */
export const KB_AGENT_SLOTS = [
  "planner",
  "teacher",
  "merged-by",
  "auditor",
  "review-panel",
  "synthesizer",
  "final-writer",
] as const;

const WORKER_SLOT = /^worker-([1-9][0-9]?)$/;

/** A worker's slot: `worker-` and its lane's number (`lane-3` or 3 give `worker-3`). */
export function workerSlot(lane: string | number): string {
  const n = typeof lane === "number" ? lane : Number(/^lane-(\d+)$/.exec(lane)?.[1]);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LANES)
    throw new Error(`not a lane of a worker's slot: ${lane}`);
  return `worker-${n}`;
}

/** Whether a slot is an agent's: a role's, or a worker's with a lane a rig can have. */
export function isAgentSlot(slot: string): boolean {
  const lane = WORKER_SLOT.exec(slot)?.[1];
  if (lane !== undefined) return Number(lane) <= MAX_LANES;
  return (KB_AGENT_SLOTS as readonly string[]).includes(slot);
}

export const KbSlot = z.string().refine((s) => s === KB_RECORDS || isAgentSlot(s), {
  message: `a slot is ${KB_RECORDS}, worker-<lane> or one of ${KB_AGENT_SLOTS.join(", ")}`,
});

/**
 * The slot an event's writer writes in, from the event the harness signed: Thermite's code (the
 * harness) writes the records slot, an agent its own slot, named for its role and lane. Undefined:
 * the writer has no slot, and writes no item.
 */
export function slotOfWriter(actor: string): string | undefined {
  if (actor === CODE_WRITER) return KB_RECORDS;
  return isAgentSlot(actor) ? actor : undefined;
}

/** The event's writer for a slot: slotOfWriter's other way. */
export const writerOfSlot = (slot: string): string => (slot === KB_RECORDS ? CODE_WRITER : slot);

/** The actor of Thermite's code's events, the writer of the records slot. */
const CODE_WRITER = "harness";

/**
 * A written item's id in its slot: its number. In the records slot, where Thermite's reading of the
 * run's events names each record by its id in the run (an experiment's, a note's number), a written
 * item's number takes a `w` before it, so the two never meet.
 */
export const writtenRef = (slot: string, item: number): string =>
  slot === KB_RECORDS ? `w${item}` : String(item);

/** An item's place: its campaign's collection, its run, its writer's slot, its kind and its id. */
export interface KbPlace {
  campaign: string;
  run: string;
  slot: string;
  kind: string;
  ref: string;
}

/**
 * An item's address, through what owns it (goal 170): `<campaign>/<run>/<slot>/<kind>:<ref>`. An
 * agent's items are numbered in its slot (`gemv/gs-3/worker-1/finding:2`); the records slot's
 * items keep their ids in the run (`gemv/gs-3/records/experiment:x-1`).
 */
export const kbAddress = (p: KbPlace): string =>
  `${p.campaign}/${p.run}/${p.slot}/${p.kind}:${p.ref}`;

const ADDRESS = /^([^/\s]+)\/([^/\s]+)\/([a-z0-9-]+)\/([a-z]+):([^\n]+)$/;

/** An address read back into its parts; undefined for text that is not an item's address. */
export function readKbAddress(text: string): KbPlace | undefined {
  const m = ADDRESS.exec(text);
  if (!m) return undefined;
  const [, campaign = "", run = "", slot = "", kind = "", ref = ""] = m;
  if (!NAME_PATTERN.test(campaign) || !NAME_PATTERN.test(run)) return undefined;
  if (!KbSlot.safeParse(slot).success || !KbKind.safeParse(kind).success) return undefined;
  return { campaign, run, slot, kind, ref };
}

export const KbAddress = z
  .string()
  .max(600)
  .refine((s) => readKbAddress(s) !== undefined, {
    message: "an item's address is <campaign>/<run>/<slot>/<kind>:<id>",
  });

// ---------------------------------------------------------------- the kb_item event

/** How one item stands to another: it supports it, contradicts it, or follows on from it. */
export const KB_LINKS = ["supports", "contradicts", "follows"] as const;
export const KbLinkRel = z.enum(KB_LINKS);
export type KbLinkRel = z.infer<typeof KbLinkRel>;

/** The most links one version of an item has: a write's own limit, refused past it. */
export const KB_LINKS_MAX = 20;

/** The longest text of a blurb, in characters: the longest item text (KB_BODY_MAX). Longer: a file. */
export const KB_TEXT_MAX = KB_BODY_MAX;

/**
 * Where a rig's items' files wait in its outbox, each named by its SHA-256: the harness writes them,
 * and the supervisor, which reads the outbox, puts each on the message bus once
 * (core/link/kb-files.ts). The dot keeps them apart from the exports there.
 */
export const KB_OUTBOX_FILES = ".kb-files";

/**
 * An item's file, kept whole by its SHA-256: once in the rig's outbox, until the supervisor puts
 * it on the message bus (core/link/kb-files.ts), then once in control's state. No size limit.
 */
export const KbItemFile = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "a file's SHA-256 is 64 hex digits"),
  /** Its name, as its writer gave it. */
  name: z.string().trim().min(1).max(200),
  /** Its media type: text/markdown, application/pdf, … */
  type: z
    .string()
    .max(100)
    .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/, "a media type, such as text/markdown"),
  bytes: z.number().int().min(0),
});
export type KbItemFile = z.infer<typeof KbItemFile>;

/**
 * The body of a `kb_item` event (goal 175): one version of one item, in its writer's slot of the
 * event's run (its subject). `item` is the item's number in its slot; `version` 1 makes the item,
 * and each later version adds to the writer's own item, whose older versions stay. An item holds a
 * text (a blurb) or a file, and links to other items by their addresses. The harness records it
 * with the writer as the event's actor (slotOfWriter), and control stores it in that slot only.
 */
export const KbItemBody = z
  .object({
    slot: KbSlot,
    item: z.number().int().positive(),
    version: z.number().int().positive(),
    kind: KbWrittenKind,
    title: z.string().trim().min(1).max(300),
    text: z.string().min(1).max(KB_TEXT_MAX).optional(),
    file: KbItemFile.optional(),
    links: z.array(z.object({ rel: KbLinkRel, to: KbAddress })).max(KB_LINKS_MAX),
  })
  .refine((b) => (b.text === undefined) !== (b.file === undefined), {
    message: "an item holds a text or a file: one of the two",
  });
export type KbItemBody = z.infer<typeof KbItemBody>;

/** A `kb_item` event's body, read and checked; or why it is not one, in words. */
export function readKbItem(raw: unknown): { body: KbItemBody } | { refused: string } {
  const r = KbItemBody.safeParse(raw);
  if (r.success) return { body: r.data };
  const words = r.error.issues.map((i) => `${i.path.join(".") || "the item"}: ${i.message}`);
  return { refused: words.join("; ") };
}

/** One item of a campaign's collection, as control sends it. */
export const KbItemWire = z.object({
  /** Increases on every change of any item: the sync's cursor. */
  seq: z.number().int().positive(),
  campaign: z.string().min(1).max(200),
  rig: z.string().min(1).max(200),
  run: z.string().min(1).max(100),
  kind: KbKind,
  /**
   * The item's id in its run: the run's own id, a trial's, an experiment's, an attempt's, a
   * claim's, a note's number, or a document's lane and path.
   */
  ref: z.string().min(1).max(200),
  title: z.string().max(500),
  body: z.string().max(200_000),
  /** Who wrote it: a lane, the planner, an advisor, the judge, the owner. */
  by: z.string().max(200),
  url: z.string().max(2000).nullable(),
  /** For a note: observation, decision, surprise, question, lesson or note. */
  sub: z.string().max(40).nullable(),
  at: z.string(),
  updated_at: z.string(),
});
export type KbItemWire = z.infer<typeof KbItemWire>;

/** Control's answer to a supervisor's sync of one run's readable collections. */
export const KbSync = z.object({
  campaign: z.string(),
  /** The collections the run's campaign may read: its own first, then those the owner granted. */
  collections: z.array(z.string()),
  items: z.array(KbItemWire),
  /** The cursor for the next call (the last item's seq, or the one given when none came). */
  next: z.number().int().min(0),
  /** True when more items wait after this page. */
  more: z.boolean(),
});
export type KbSync = z.infer<typeof KbSync>;

/** Whether this build knows a kind of item (one it left out before an upgrade, say). */
export const knownKbKind = (kind: string): boolean => KbKind.safeParse(kind).success;

/** Items read by a rig, and how many of each kind it left out because it does not know the kind. */
export interface KbItemsRead {
  items: KbItemWire[];
  /** Per kind this build does not know (cut to 40 characters), the items left out. */
  unknownKinds: Record<string, number>;
}

/**
 * Reads items as a rig does. An item of a kind this build does not know, which a newer control
 * may send, is left out and counted, and the rest are read: a newer control never stops an older
 * rig's sync. An item of a known kind must still be well formed.
 */
export function readKbItems(raw: unknown[]): KbItemsRead {
  const out: KbItemsRead = { items: [], unknownKinds: {} };
  for (const x of raw) {
    const kind = x && typeof x === "object" ? (x as { kind?: unknown }).kind : undefined;
    if (typeof kind === "string" && !knownKbKind(kind)) {
      const k = kind.slice(0, 40);
      out.unknownKinds[k] = (out.unknownKinds[k] ?? 0) + 1;
      continue;
    }
    out.items.push(KbItemWire.parse(x));
  }
  return out;
}

/**
 * The kinds left out that were not told yet, with their counts: each kind is logged once. They are
 * marked as told in `told`.
 */
export function untoldKinds(
  told: Set<string>,
  unknownKinds: Record<string, number>,
): [string, number][] {
  const fresh = Object.entries(unknownKinds).filter(([kind]) => !told.has(kind));
  for (const [kind] of fresh) told.add(kind);
  return fresh;
}

/** Control's answer to a sync, read as a rig does: items of unknown kinds left out (readKbItems). */
export function readKbSync(raw: unknown): { page: KbSync; unknownKinds: Record<string, number> } {
  const page = KbSync.extend({ items: z.array(z.unknown()) }).parse(raw);
  const read = readKbItems(page.items);
  return { page: { ...page, items: read.items }, unknownKinds: read.unknownKinds };
}
