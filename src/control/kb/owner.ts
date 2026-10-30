import { z } from "zod";
import { KB_OUTCOMES, KbAddress, KbKind } from "../../core/kb.ts";
import {
  KB_IS_DATA,
  KB_OFFSET_MAX,
  KB_QUERIES_MAX,
  KB_READ_PAGE,
  KB_SEARCH_DEFAULT,
  KB_SEARCH_MAX,
  KB_SEEN_MAX,
  kbSearchShape,
} from "../../core/link/kb.ts";
import type { ControlStore } from "../store/index.ts";
import { foundOf, hitOf, kbFindOf, textPage } from "./asks.ts";

/**
 * The owner's search and read of the knowledge base (goal 175), the same on REST (`GET
 * /v1/kb/search`, `GET /v1/kb/item`), MCP (`kb_search`, `kb_read`) and the command line (`thermite
 * kb`): every collection, or those named, searched as an agent searches (store/kb/search.ts), each
 * hit with its id (Start a run's `past` takes it), its address, its slot, its outcome, an excerpt,
 * why it matched, its passage and, for an experiment, its result; with how many matched, the next
 * page, where the words land and how many items hold each.
 */

/** A search's fields over REST and MCP: an agent's (kbSearchShape), with each one's words. */
export const kbSearchFields = {
  q: kbSearchShape.q
    .default("")
    .describe(
      "Words to find; an item matches with any of them, and those with more of them, and rarer ones, come first. Common words are left out, and failed, slower and faster also find the words Thermite's records say them with. Empty: the newest items. With mode exact, FTS5's own query syntax",
    ),
  queries: kbSearchShape.queries.describe(
    `Up to ${KB_QUERIES_MAX} more searches, each its own words, fused with q's by reciprocal rank fusion: an item several of them find comes first`,
  ),
  mode: kbSearchShape.mode.describe(
    "words (the default): any words, forgiving. exact: FTS5's query syntax as written: \"a phrase\", prefix*, a AND b, a OR b, a NOT b, NEAR(a b, 10), (groups), and title:, context: or body: before a word; a query it can't read is answered in words",
  ),
  like: kbSearchShape.like.describe(
    "An item's address: more like it, by its own most telling words (the item itself is left out)",
  ),
  seen: kbSearchShape.seen.describe(
    `Items to leave out, by address: those already seen (at most ${KB_SEEN_MAX})`,
  ),
  collections: z
    .array(z.string().min(1).max(200))
    .max(100)
    .optional()
    .describe("The collections to search, by campaign; left out: every collection"),
  kinds: z.array(KbKind).max(KbKind.options.length).optional().describe("Only these kinds of item"),
  outcomes: kbSearchShape.outcomes.describe(
    `Only experiments and attempts that ended so: ${KB_OUTCOMES.join(", ")}`,
  ),
  runs: kbSearchShape.runs.describe("Only these runs' items"),
  slots: kbSearchShape.slots.describe(
    "Only these slots' items: records (Thermite's own records of a run), planner, worker-<lane>, teacher, merged-by, auditor, review-panel, synthesizer, final-writer",
  ),
  offset: kbSearchShape.offset.describe(
    `Where the page starts: next_offset of the page before (at most ${KB_OFFSET_MAX})`,
  ),
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
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `Where its text starts, in characters: a hit's passage.from, or next_offset of the read before. A read gives ${KB_READ_PAGE.toLocaleString("en-US")} characters at most`,
    ),
};
export const KbReadQuery = z.strictObject(kbReadFields);
export type KbReadQuery = z.infer<typeof KbReadQuery>;

/** The owner's search: a page of hits, best first, and what the search says beside them. */
export function ownerKbSearch(
  store: ControlStore,
  s: KbSearchQuery,
): Record<string, unknown> | { error: string } {
  const kb = store.kb();
  const collections = s.collections?.length
    ? s.collections
    : kb.collections().map((c) => c.campaign);
  const { collections: _c, ...rest } = s;
  const r = kb.find(
    [s.q, ...(s.queries ?? [])],
    collections.map((campaign) => ({ campaign })),
    kbFindOf(rest),
  );
  if (r.refused) return { error: r.refused };
  return {
    note: KB_IS_DATA,
    collections,
    ...foundOf(r),
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
  const { excerpt: _e, why: _w, passage: _p, ...item } = hitOf(x);
  return {
    note: KB_IS_DATA,
    item: {
      id: x.id,
      ...item,
      title: v.title,
      version: v.version,
      at: v.at,
      ...textPage(v.body, q.offset),
      versions: versions.length,
      links: v.links,
      result: kb.resultOf(x),
    },
  };
}
