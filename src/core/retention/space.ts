import { z } from "zod";
import { RETENTION_KIND_KEYS, type RetentionKind, RIG_KINDS } from "./kinds.ts";
import { RETENTION_NAME_MAX, type Removal, type RetentionItem } from "./policy.ts";

/**
 * What crosses between a rig and control for retention policies (index.ts): what a rig keeps of
 * its kinds, packed for its `space` ask, and what it removed, its `retention_removed` event.
 */
/** Flags of a packed item: its run is open, it is a champion's. */
const OPEN = 1;
const CHAMPION = 2;

/** The most items of one kind a rig reports one by one; older ones go in groups by run and day. */
export const SPACE_ITEMS_MAX = 100_000;
/** The most runs a rig's report of one kind names. */
const SPACE_RUNS_MAX = 100_000;

/**
 * A kind's items as a rig reports them, packed: its runs once, then each item as [the run's index
 * (-1: none), when it was made in seconds since 1970, its bytes, its flags, how many it is].
 */
export const SpaceInventory = z.object({
  /** Every item's bytes, the grouped ones too. */
  bytes: z.number().int().min(0),
  runs: z.array(z.string().max(64)).max(SPACE_RUNS_MAX),
  items: z
    .array(
      z.tuple([
        z.number().int().min(-1),
        z.number().int().min(0),
        z.number().int().min(0),
        z.number().int().min(0).max(3),
        z.number().int().min(1),
      ]),
    )
    .max(SPACE_ITEMS_MAX * 2),
  /**
   * Why the kind's items could not be read: then there are none; or why some could not, such as a
   * runner's builds when it doesn't answer (goal 259).
   */
  error: z.string().max(500).optional(),
});
export type SpaceInventory = z.infer<typeof SpaceInventory>;

/** What a rig reports of each of its kinds, read when it was. */
export const RigSpace = z.object({
  read_at: z.iso.datetime(),
  kinds: z.partialRecord(z.enum(RIG_KINDS as [RetentionKind, ...RetentionKind[]]), SpaceInventory),
});
export type RigSpace = z.infer<typeof RigSpace>;

/**
 * A kind's items packed for the rig's report: the newest SPACE_ITEMS_MAX one by one, the rest in
 * one group for each run, day and flags, so the report stays bounded and its bytes whole.
 */
export function packItems(items: readonly RetentionItem[]): SpaceInventory {
  const runs: string[] = [];
  const runIndex = new Map<string, number>();
  const ix = (run: string | null) => {
    if (run === null) return -1;
    let i = runIndex.get(run);
    if (i === undefined) {
      i = runs.length;
      runs.push(run);
      runIndex.set(run, i);
    }
    return i;
  };
  const flags = (x: RetentionItem) => (x.open ? OPEN : 0) | (x.champion ? CHAMPION : 0);
  const sec = (x: RetentionItem) => Math.max(0, Math.floor(Date.parse(x.at) / 1000));
  const sorted = [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const out: SpaceInventory["items"] = sorted
    .slice(0, SPACE_ITEMS_MAX)
    .map((x) => [ix(x.run), sec(x), x.bytes, flags(x), x.count]);
  const groups = new Map<string, [number, number, number, number, number]>();
  for (const x of sorted.slice(SPACE_ITEMS_MAX)) {
    const key = `${x.run ?? ""}\n${x.at.slice(0, 10)}\n${flags(x)}`;
    const g = groups.get(key);
    if (g) {
      g[2] += x.bytes;
      g[4] += x.count;
    } else groups.set(key, [ix(x.run), sec(x), x.bytes, flags(x), x.count]);
  }
  out.push(...groups.values());
  return { bytes: items.reduce((n, x) => n + x.bytes, 0), runs, items: out };
}

/** A rig's packed items read back, as wouldRemove takes them. */
export function unpackItems(rig: string, inv: SpaceInventory): RetentionItem[] {
  return inv.items.map(([run, at, bytes, f, count], i) => ({
    id: `${rig}:${i}`,
    rig,
    run: run >= 0 ? (inv.runs[run] ?? null) : null,
    at: new Date(at * 1000).toISOString(),
    bytes,
    count,
    open: (f & OPEN) !== 0,
    champion: (f & CHAMPION) !== 0,
  }));
}

// ---------------------------------------------------------------- what a rig removed

/**
 * What a rig removed for a policy (the `retention_removed` event of its ledger), which reaches
 * control as any event: control shows it under What policies removed and writes it in its audit
 * log. `error`: why it removed nothing, or not all it would.
 */
export const RetentionRemoved = z.object({
  policy: z.number().int().positive(),
  name: z.string().max(RETENTION_NAME_MAX),
  kind: z.enum(RETENTION_KIND_KEYS as [RetentionKind, ...RetentionKind[]]),
  by: z.enum(["schedule", "hand"]),
  count: z.number().int().min(0),
  bytes: z.number().int().min(0),
  oldest: z.string().nullable(),
  newest: z.string().nullable(),
  error: z.string().max(500).optional(),
});
export type RetentionRemoved = z.infer<typeof RetentionRemoved>;

/** A removal's body, as the event and the audit log keep it, from what wouldRemove said. */
export function removedBody(
  p: { policy: number; name: string; kind: RetentionKind; by: "schedule" | "hand" },
  r: Omit<Removal, "items">,
  error?: string | undefined,
): RetentionRemoved {
  return {
    ...p,
    count: r.count,
    bytes: r.bytes,
    oldest: r.oldest,
    newest: r.newest,
    ...(error ? { error: error.slice(0, 500) } : {}),
  };
}
