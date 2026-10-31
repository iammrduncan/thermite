import { z } from "zod";
import { KB_OUTCOMES, KbKind } from "../../core/kb.ts";
import {
  KB_IS_DATA,
  KB_OFFSET_MAX,
  KB_QUERIES_MAX,
  KB_SEARCH_DEFAULT,
  KB_SEARCH_MAX,
  KB_SEEN_MAX,
  kbSearchShape,
} from "../../core/link/kb.ts";
import type { ControlStore } from "../store/index.ts";
import { answerKbAsk, foundOf, hitOf, kbFindOf } from "./asks.ts";

/**
 * The owner's search of the knowledge base (goal 175), the same on REST (`GET /v1/kb/search`), MCP
 * (`kb_search`) and the command line (`thermite kb search`); the owner's read is in read.ts. Every
 * collection, or those named, searched as an agent searches (store/kb/search.ts), each
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
  types: kbSearchShape.types.describe(
    "Only items of these types: record (Thermite's own records of a run), blurb (a text an agent or the owner wrote) or file",
  ),
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
  as: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "A run control assigned: search as its agents do. The answer is the one their kb_search gets, from the run's own scope (its collection, or its own run when it started fresh, and the grants it includes), with that scope; collections, runs and slots only narrow it",
    ),
};
export const KbSearchQuery = z.strictObject(kbSearchFields);
export type KbSearchQuery = z.infer<typeof KbSearchQuery>;

/**
 * The owner's search as one run's agents search: the answer their kb_search gets, from the code
 * that answers their rig's ask (asks.ts), with the run and its rig. Undefined fields are left out,
 * as an ask leaves them.
 */
export function searchAsRun(store: ControlStore, run: string, s: Omit<KbSearchQuery, "as">) {
  const rig = store.runRegistry.assigned(run)?.rig;
  if (!rig) return { error: `control assigned no run ${run}: no agents search as it` } as const;
  const ask = Object.fromEntries(Object.entries({ ...s, run }).filter(([, v]) => v !== undefined));
  const a = answerKbAsk(store, rig, "search", ask);
  if ("refused" in a) return { error: a.refused } as const;
  if (!("hits" in a)) return { error: "the run's search gave no hits" } as const;
  return { as: run, rig, ...a };
}

/** The owner's search: a page of hits, best first, and what the search says beside them. */
export function ownerKbSearch(store: ControlStore, query: KbSearchQuery) {
  const { as, ...s } = query;
  if (as) return searchAsRun(store, as, s);
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
  if (r.refused) return { error: r.refused } as const;
  return {
    note: KB_IS_DATA,
    collections,
    ...foundOf(r),
    hits: r.hits.map((x) => ({ id: x.id, ...hitOf(x, x), result: kb.resultOf(x) })),
  };
}
