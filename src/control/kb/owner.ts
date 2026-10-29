import { z } from "zod";
import { KbAddress, KbKind } from "../../core/kb.ts";
import { KB_IS_DATA, KB_QUERY_MAX, KB_SEARCH_DEFAULT, KB_SEARCH_MAX } from "../../core/link/kb.ts";
import type { ControlStore } from "../store/index.ts";
import { hitOf } from "./asks.ts";

/**
 * The owner's search and read of the knowledge base (goal 175), the same on REST (`GET
 * /v1/kb/search`, `GET /v1/kb/item`), MCP (`kb_search`, `kb_read`) and the command line (`thermite
 * kb`): every collection, or those named, searched by words and ranked by BM25 (store/kb/search.ts),
 * each hit with its id (Start a run's `past` takes it), its address, its slot, an excerpt, why it
 * matched and, for an experiment, its result.
 */

/** A search's fields over REST and MCP. */
export const kbSearchFields = {
  q: z
    .string()
    .max(KB_QUERY_MAX)
    .default("")
    .describe(
      "Words to find; an item matches with any of them, and those with more of them, and rarer ones, come first. Common words are left out. Empty: the newest items",
    ),
  collections: z
    .array(z.string().min(1).max(200))
    .max(100)
    .optional()
    .describe("The collections to search, by campaign; left out: every collection"),
  kinds: z.array(KbKind).max(KbKind.options.length).optional().describe("Only these kinds of item"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(KB_SEARCH_MAX)
    .optional()
    .describe(`How many hits, 1 to ${KB_SEARCH_MAX} (default ${KB_SEARCH_DEFAULT})`),
};
export const KbSearchQuery = z.strictObject(kbSearchFields);
export type KbSearchQuery = z.infer<typeof KbSearchQuery>;

/** A read's fields over REST and MCP. */
export const kbReadFields = {
  address: KbAddress.describe("The item's address, <campaign>/<run>/<slot>/<kind>:<id>"),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("One of its versions; left out: its newest"),
};
export const KbReadQuery = z.strictObject(kbReadFields);
export type KbReadQuery = z.infer<typeof KbReadQuery>;

/** The owner's search: the hits, best first, with how many matched. */
export function ownerKbSearch(store: ControlStore, s: KbSearchQuery): Record<string, unknown> {
  const kb = store.kb();
  const collections = s.collections?.length
    ? s.collections
    : kb.collections().map((c) => c.campaign);
  const r = kb.find(
    s.q,
    collections.map((campaign) => ({ campaign })),
    { kinds: s.kinds, limit: s.limit ?? KB_SEARCH_DEFAULT },
  );
  return {
    note: KB_IS_DATA,
    collections,
    matched: r.matched,
    hits: r.hits.map((x) => ({ id: x.id, ...hitOf(x, x), result: kb.resultOf(x) })),
  };
}

/** The owner's read of one item: one version whole, its links, and how many versions it has. */
export function ownerKbRead(
  store: ControlStore,
  q: KbReadQuery,
): Record<string, unknown> | { error: string } {
  const kb = store.kb();
  const x = kb.at(q.address);
  if (!x) return { error: `the knowledge base has no item ${q.address}` };
  const versions = kb.versions(x.id);
  const v =
    q.version === undefined ? versions.at(-1) : versions.find((o) => o.version === q.version);
  if (!v) return { error: `${q.address} has versions 1 to ${versions.length}, not ${q.version}` };
  const { excerpt: _e, why: _w, ...item } = hitOf(x);
  return {
    note: KB_IS_DATA,
    item: {
      id: x.id,
      ...item,
      title: v.title,
      version: v.version,
      at: v.at,
      text: v.body,
      versions: versions.length,
      links: v.links,
      result: kb.resultOf(x),
    },
  };
}
