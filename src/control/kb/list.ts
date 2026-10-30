import { z } from "zod";
import { NAME_PATTERN } from "../../core/ids.ts";
import {
  KB_ITEM_TYPES,
  KB_LIST_SORTS,
  KbKind,
  type KbListSort,
  KbOutcome,
  KbSlot,
  kbAddress,
  kbItemType,
} from "../../core/kb.ts";
import { KB_FILTER_MAX, KB_IS_DATA } from "../../core/link/kb.ts";
import type { ControlStore, KbFolderRow, KbListAt, KbListCounts } from "../store/index.ts";
import type { RigView } from "../views/index.ts";
import type { KbItem } from "./index.ts";

/**
 * The owner's list of one place of the knowledge base (goal 176), the same on REST (`GET
 * /v1/kb/list`), MCP (`kb_list`), the command line (`thermite kb list`) and the Knowledge page,
 * which shows nothing this read does not give: the place, its folders (the collections, runs or
 * slots in it, each with its items, its newest change, and whether a collection's campaign is
 * archived, a run is running or started fresh), and a page of every item under it with how many
 * there are and their counts by kind, outcome, type and slot.
 */

/** How many items a page holds when not told, and at most: a mechanical limit, not an end. */
export const KB_LIST_DEFAULT = 50;
export const KB_LIST_MAX = 200;

/** A place's levels, by how many parts its address has. */
const LEVELS = ["knowledge_base", "collection", "run", "slot"] as const;
export type KbLevel = (typeof LEVELS)[number];

/** A place read from its address: "" (the whole knowledge base), <campaign>, /<run>, /<slot>. */
export function readKbPlace(text: string): KbListAt | undefined {
  if (text === "") return {};
  const [campaign, run, slot, ...more] = text.split("/");
  if (more.length || !campaign || !NAME_PATTERN.test(campaign)) return undefined;
  if (run !== undefined && !NAME_PATTERN.test(run)) return undefined;
  if (slot !== undefined && !KbSlot.safeParse(slot).success) return undefined;
  return { campaign, run, slot };
}

/** A place's address: its parts joined, "" for the whole knowledge base. */
export const kbPlacePath = (at: KbListAt): string =>
  [at.campaign, at.run, at.slot].filter((p): p is string => p !== undefined).join("/");

const levelOf = (at: KbListAt): KbLevel =>
  LEVELS[[at.campaign, at.run, at.slot].filter((p) => p !== undefined).length] ?? "slot";

/** A list's fields over REST and MCP. */
export const kbListFields = {
  at: z
    .string()
    .max(300)
    .default("")
    .refine((s) => readKbPlace(s) !== undefined, {
      message: "a place is <campaign>, <campaign>/<run> or <campaign>/<run>/<slot>",
    })
    .describe(
      "The place: <campaign> (a collection), <campaign>/<run> or <campaign>/<run>/<slot>; empty: the whole knowledge base",
    ),
  kinds: z.array(KbKind).max(KbKind.options.length).optional().describe("Only these kinds of item"),
  outcomes: z
    .array(KbOutcome)
    .max(KbOutcome.options.length)
    .optional()
    .describe("Only experiments and attempts that ended so"),
  types: z
    .array(z.enum(KB_ITEM_TYPES))
    .max(KB_ITEM_TYPES.length)
    .optional()
    .describe(
      "Only these types: record (Thermite's code's, in a run's records slot), blurb (a short text an agent wrote) or file (a document kept whole)",
    ),
  slots: z
    .array(KbSlot)
    .max(KB_FILTER_MAX)
    .optional()
    .describe("Only the items of these writers' slots"),
  sort: z
    .enum(KB_LIST_SORTS)
    .optional()
    .describe(
      "What the items sort by: name (the title), kind, outcome, writer (the slot), modified (the default) or size (a file's)",
    ),
  order: z
    .enum(["asc", "desc"])
    .optional()
    .describe("asc or desc; left out: desc for modified and size, asc for the others"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Where the page starts: next_offset of the page before"),
  limit: z
    .number()
    .int()
    .min(0)
    .max(KB_LIST_MAX)
    .optional()
    .describe(
      `How many items, 0 to ${KB_LIST_MAX} (default ${KB_LIST_DEFAULT}); 0 gives the place, its folders and the counts`,
    ),
};
export const KbListQuery = z.strictObject(kbListFields);
export type KbListQuery = z.infer<typeof KbListQuery>;

/** A collection, run or slot as the list gives it. */
export interface KbFolder {
  name: string;
  /** Its address, as `at` takes it. */
  path: string;
  level: KbLevel;
  items: number;
  updated_at: string | null;
  /** A collection: its campaign is archived. */
  archived?: boolean;
  /** A run: it is running on a rig now. */
  running?: boolean;
  /** A run: it started fresh, so its agents read only its own items. */
  fresh?: boolean;
}

/** Folders in the list's order: by name, or by newest change, as the items sort; else by name. */
function sorted(xs: KbFolder[], sort: KbListSort, order: "asc" | "desc" | undefined): KbFolder[] {
  const byName = (a: KbFolder, b: KbFolder) =>
    a.name.localeCompare(b.name, "en", { numeric: true });
  if (sort === "modified") {
    const sign = (order ?? "desc") === "desc" ? -1 : 1;
    return [...xs].sort(
      (a, b) => sign * (a.updated_at ?? "").localeCompare(b.updated_at ?? "") || byName(a, b),
    );
  }
  const sign = sort === "name" && order === "desc" ? -1 : 1;
  return [...xs].sort((a, b) => sign * byName(a, b));
}

/**
 * The collections, runs or slots a place holds, in the list's order (by newest change unless
 * told), with what control knows of each now: which campaigns are archived (store.archive) and
 * which runs are running (the rigs' views). None in a slot.
 */
export function kbFolders(
  store: ControlStore,
  vs: readonly RigView[],
  at: KbListAt,
  o: { sort?: KbListSort | undefined; order?: "asc" | "desc" | undefined } = {},
): KbFolder[] {
  const childLevel = LEVELS[LEVELS.indexOf(levelOf(at)) + 1];
  if (!childLevel) return [];
  const archived = new Set(store.archive.list().map((a) => a.campaign));
  const running = new Set(
    vs.flatMap((u) => u.runs.filter((r) => r.status === "running").map((r) => r.id)),
  );
  const base = kbPlacePath(at);
  const folders = store
    .kb()
    .folders(at)
    .map((f: KbFolderRow): KbFolder => {
      const folder: KbFolder = {
        name: f.name,
        path: base ? `${base}/${f.name}` : f.name,
        level: childLevel,
        items: f.items,
        updated_at: f.updated_at,
      };
      if (childLevel === "collection") folder.archived = archived.has(f.name);
      if (childLevel === "run") {
        folder.running = running.has(f.name);
        folder.fresh = f.fresh;
      }
      return folder;
    });
  return sorted(folders, o.sort ?? "modified", o.order);
}

/** A place with what its parent's list says of it; or, when the knowledge base has none, why. */
function placeOf(
  store: ControlStore,
  vs: readonly RigView[],
  at: KbListAt,
): KbFolder | { error: string } {
  if (at.campaign === undefined) {
    const all = kbFolders(store, vs, {});
    return {
      name: "",
      path: "",
      level: "knowledge_base",
      items: all.reduce((n, f) => n + f.items, 0),
      updated_at: all.reduce<string | null>(
        (t, f) => (f.updated_at && (!t || f.updated_at > t) ? f.updated_at : t),
        null,
      ),
    };
  }
  const parent: KbListAt =
    at.slot !== undefined
      ? { campaign: at.campaign, run: at.run }
      : at.run !== undefined
        ? { campaign: at.campaign }
        : {};
  const name = at.slot ?? at.run ?? at.campaign;
  const found = kbFolders(store, vs, parent).find((f) => f.name === name);
  if (found) return found;
  if (at.slot !== undefined) return { error: `${at.campaign}/${at.run} has no slot ${at.slot}` };
  if (at.run !== undefined) return { error: `${at.campaign} has no run ${at.run}` };
  return { error: `the knowledge base has no collection ${at.campaign}` };
}

/** An item as the list gives it: where it is, its type, and who wrote it and when. */
export function listedItem(x: KbItem) {
  return {
    id: x.id,
    address: kbAddress(x),
    collection: x.campaign,
    run: x.run,
    slot: x.slot,
    kind: x.kind,
    type: kbItemType(x),
    title: x.title,
    outcome: x.outcome,
    by: x.by,
    at: x.updated_at,
    version: x.version,
    file: x.file,
  };
}
export type KbListedItem = ReturnType<typeof listedItem>;

/** What the list answers. */
export interface KbListAnswer {
  note: string;
  at: KbFolder;
  folders: KbFolder[];
  total: number;
  matched: number;
  next_offset: number | null;
  counts: KbListCounts;
  items: KbListedItem[];
}

/** The owner's list of a place: the place, its folders, and a page of the items under it. */
export function ownerKbList(
  store: ControlStore,
  vs: readonly RigView[],
  q: KbListQuery,
): KbListAnswer | { error: string } {
  const at = readKbPlace(q.at);
  if (!at) return { error: `no place ${q.at} in the knowledge base` };
  const place = placeOf(store, vs, at);
  if ("error" in place) return place;
  const limit = q.limit ?? KB_LIST_DEFAULT;
  const offset = q.offset ?? 0;
  const r = store.kb().list(at, {
    kinds: q.kinds,
    outcomes: q.outcomes,
    types: q.types,
    slots: q.slots,
    sort: q.sort,
    order: q.order,
    offset,
    limit,
  });
  return {
    note: KB_IS_DATA,
    at: place,
    folders: kbFolders(store, vs, at, { sort: q.sort, order: q.order }),
    total: r.total,
    matched: r.matched,
    next_offset: limit > 0 && offset + r.items.length < r.matched ? offset + r.items.length : null,
    counts: r.counts,
    items: r.items.map(listedItem),
  };
}
