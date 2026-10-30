import type { Hono } from "hono";
import {
  KB_ITEM_TYPES,
  KB_LIST_SORTS,
  KB_OUTCOMES,
  type KbItemType,
  KbKind,
  type KbOutcome,
  KbSlot,
} from "../../core/kb.ts";
import { KB_OFFSET_MAX, KB_QUERY_MAX, KB_SEARCH_MAX } from "../../core/link/kb.ts";
import {
  KB_LIST_DEFAULT,
  type KbFolder,
  KbReadQuery,
  KbSearchQuery,
  kbFolders,
  ownerKbList,
  ownerKbRead,
  ownerKbSearch,
  PICKABLE,
  readKbPlace,
} from "../kb/index.ts";
import { esc } from "../ui/components/index.ts";
import {
  contentsHtml,
  crumbsHtml,
  type ExplorerQuery,
  type ExplorerSearch,
  explorerFrame,
  itemHtml,
  KNOWLEDGE_JS,
  pastWords,
  treeList,
} from "../ui/knowledge/index.ts";
import { knowledgeParts } from "../ui/urls.ts";
import { campaignModes } from "../views/index.ts";
import { campaignHelpers } from "./campaigns/shared.ts";
import type { Ctx, Dashboard } from "./context.ts";

/**
 * The Knowledge page (goal 176): the explorer of the knowledge base, at /ui/knowledge, a
 * collection's, a run's or a slot's address under it, or an item's own page; the tree's folders
 * asked for as a folder opens; its script; and Start a run's search of past research (goal 065).
 * What the page shows comes from the owner's reads that REST and MCP give too: kb_list, kb_search
 * and kb_read (control/kb/), each called here as there.
 */
export function knowledgeRoutes(app: Hono, dash: Dashboard): void {
  const { page, store, views } = dash;
  const { pastResults } = campaignHelpers(dash);

  /** A list in the page's address: given with commas or as a repeated parameter, each once. */
  const listOf = (c: Ctx, k: string) => [
    ...new Set(
      (c.req.queries(k) ?? [])
        .flatMap((v) => v.split(","))
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  /** What the address asks; a value the page does not know is left out. */
  const queryOf = (c: Ctx): ExplorerQuery => {
    const order = c.req.query("order");
    return {
      q: (c.req.query("q") ?? "").slice(0, KB_QUERY_MAX),
      kinds: listOf(c, "kind").filter((k): k is KbKind => KbKind.safeParse(k).success),
      outcomes: listOf(c, "outcome").filter((o): o is KbOutcome =>
        (KB_OUTCOMES as readonly string[]).includes(o),
      ),
      types: listOf(c, "type").filter((t): t is KbItemType =>
        (KB_ITEM_TYPES as readonly string[]).includes(t),
      ),
      slots: listOf(c, "slot").filter((s) => KbSlot.safeParse(s).success),
      sort: KB_LIST_SORTS.find((s) => s === c.req.query("sort")),
      order: order === "asc" || order === "desc" ? order : undefined,
      offset: Math.max(0, Math.floor(Number(c.req.query("offset")) || 0)),
    };
  };

  /** The explorer's page around its main part, with the tree open down to the open folder. */
  const explorer = (
    c: Ctx,
    o: { parts: string[]; names?: string[]; query: ExplorerQuery; main: string; summary?: string },
  ) => {
    const vs = views();
    const [campaign, run] = o.parts;
    const collections = kbFolders(store, vs, {}, { sort: "name" });
    const kids = new Map<string, KbFolder[]>();
    if (campaign && collections.some((f) => f.name === campaign))
      kids.set(campaign, kbFolders(store, vs, { campaign }, { sort: "name" }));
    if (campaign && run && kids.get(campaign)?.some((f) => f.name === run))
      kids.set(`${campaign}/${run}`, kbFolders(store, vs, { campaign, run }, { sort: "name" }));
    const folder = o.parts.slice(0, 3).join("/");
    const crumbs = o.parts.map((p, i) => ({
      path: o.parts.slice(0, i + 1).join("/"),
      name: o.names?.[i] ?? p,
    }));
    const items = collections.reduce((n, f) => n + f.items, 0);
    return page(
      c,
      {
        title: "Knowledge",
        summary:
          o.summary ??
          `${collections.length} ${collections.length === 1 ? "collection" : "collections"} · ${items} ${items === 1 ? "item" : "items"}`,
        active: "knowledge",
        flush: true,
      },
      explorerFrame({
        crumbs: crumbsHtml(crumbs, o.parts.join("/")),
        folder,
        query: o.query,
        collections,
        kids,
        current: folder,
        main: o.main,
      }),
      vs,
    );
  };
  /** What the explorer says when an address names nothing it holds. */
  const notFound = (c: Ctx, parts: string[], query: ExplorerQuery, words: string) => {
    c.status(404);
    // The crumbs go as far as the address names a place.
    let named = 0;
    while (named < Math.min(3, parts.length) && readKbPlace(parts.slice(0, named + 1).join("/")))
      named++;
    return explorer(c, {
      parts: parts.slice(0, named),
      query,
      main: `<div class="kx-none"><b>Not found.</b> ${esc(words)}</div>`,
    });
  };

  // ---------------------------------------------------------------- the Knowledge page (goal 176)
  const knowledgePage = (c: Ctx) => {
    const parts = knowledgeParts(new URL(c.req.url).pathname);
    const query = queryOf(c);
    if (!parts) return notFound(c, [], query, "This is not an address in the knowledge base.");
    const placeParts = parts.slice(0, 3);
    const at = readKbPlace(placeParts.join("/"));
    if (!at) return notFound(c, [], query, "This is not an address in the knowledge base.");
    const item = parts[3];
    if (item !== undefined) {
      const read = KbReadQuery.safeParse({
        address: parts.join("/"),
        ...(query.offset ? { offset: query.offset } : {}),
      });
      const r = read.success ? ownerKbRead(store, read.data) : { error: "not an item's address" };
      if ("error" in r) return notFound(c, parts, query, String(r.error));
      return explorer(c, {
        parts,
        names: [...placeParts, r.item.title || item],
        query: { ...query, q: "", offset: 0 },
        main: itemHtml(r.item, Date.now()),
      });
    }
    const vs = views();
    const searching = query.q.trim() !== "";
    const list = ownerKbList(store, vs, {
      at: placeParts.join("/"),
      ...(query.kinds.length ? { kinds: query.kinds } : {}),
      ...(query.outcomes.length ? { outcomes: query.outcomes } : {}),
      ...(query.types.length ? { types: query.types } : {}),
      ...(query.slots.length ? { slots: query.slots } : {}),
      sort: query.sort,
      order: query.order,
      offset: searching ? 0 : query.offset,
      // A search lists its hits: the list gives the folder alone.
      limit: searching ? 0 : KB_LIST_DEFAULT,
    });
    if ("error" in list) return notFound(c, placeParts, query, list.error);
    const search = searching ? searchFolder(at, query) : undefined;
    return explorer(c, {
      parts: placeParts,
      query,
      main: contentsHtml({
        place: list.at,
        query,
        list,
        search,
        pageSize: searching ? KB_SEARCH_MAX : KB_LIST_DEFAULT,
        now: Date.now(),
      }),
    });
  };

  /**
   * A search of the open folder, as the owner's search answers it (kb_search): its collection,
   * its run and its slot, with the filters it takes (kinds, outcomes and slots).
   */
  const searchFolder = (
    at: { campaign?: string | undefined; run?: string | undefined; slot?: string | undefined },
    query: ExplorerQuery,
  ): ExplorerSearch => {
    const none: ExplorerSearch = {
      matched: 0,
      next_offset: null,
      counts: { kind: {}, outcome: {}, slot: {} },
      hits: [],
    };
    // In a slot, a writer's filter that leaves the slot out keeps nothing.
    if (at.slot && query.slots.length && !query.slots.includes(at.slot)) return none;
    const slots = at.slot ? [at.slot] : query.slots;
    const s = KbSearchQuery.safeParse({
      q: query.q,
      ...(at.campaign ? { collections: [at.campaign] } : {}),
      ...(at.run ? { runs: [at.run] } : {}),
      ...(slots.length ? { slots } : {}),
      ...(query.kinds.length ? { kinds: query.kinds } : {}),
      ...(query.outcomes.length ? { outcomes: query.outcomes } : {}),
      offset: Math.min(query.offset, KB_OFFSET_MAX),
      limit: KB_SEARCH_MAX,
    });
    if (!s.success) return { ...none, error: "The search can't read these words." };
    const r = ownerKbSearch(store, s.data);
    if ("error" in r) return { ...none, error: r.error };
    return { matched: r.matched, next_offset: r.next_offset, counts: r.counts, hits: r.hits };
  };

  app.get("/ui/knowledge", knowledgePage);
  app.get("/ui/knowledge/*", knowledgePage);

  // The tree's folders under one folder, drawn for the page's script as a folder opens.
  app.get("/ui/kb/tree", (c) => {
    c.header("cache-control", "no-store");
    const at = readKbPlace(c.req.query("at") ?? "");
    if (!at?.campaign || at.slot) return c.text("no such folder", 404);
    return c.html(treeList(kbFolders(store, views(), at, { sort: "name" }), new Map(), ""));
  });

  app.get("/ui/assets/knowledge.js", (c) =>
    c.body(KNOWLEDGE_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  /**
   * Start a run's "From past research": a search of the collections one campaign may read (its own
   * and those granted), of the kinds a new run can start from. Agents' text, sent as JSON data.
   */
  app.get("/ui/kb/search.json", (c) => {
    c.header("cache-control", "no-store");
    const campaign = c.req.query("campaign") ?? "";
    if (!campaignModes(store, views()).has(campaign))
      return c.json({ error: "no such campaign" }, 404);
    const kb = store.kb();
    const collections = kb.readable(campaign);
    const items = pastResults(campaign, (c.req.query("q") ?? "").slice(0, 300));
    return c.json({
      campaign,
      collections,
      items: items.map((x) => {
        const w = pastWords(x, kb.resultOf(x));
        return {
          id: x.id,
          kind: x.kind,
          label: w.label,
          title: x.title,
          line: w.line,
          campaign: x.campaign,
          run: x.run,
          by: x.by,
          at: x.updated_at,
          goes: PICKABLE[x.kind],
        };
      }),
    });
  });
}
