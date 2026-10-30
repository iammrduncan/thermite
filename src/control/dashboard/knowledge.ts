import type { Hono } from "hono";
import { KB_OUTCOMES } from "../../core/kb.ts";
import { PICKABLE } from "../kb/index.ts";
import { knowledgePage, pastWords, SEARCH_KINDS } from "../ui/knowledge.ts";
import { runHref } from "../ui/urls.ts";
import { campaignModes } from "../views/index.ts";
import { campaignHelpers, modeWords } from "./campaigns/shared.ts";
import type { Dashboard } from "./context.ts";

/** The Knowledge page (goal 065) and its search. */
export function knowledgeRoutes(app: Hono, dash: Dashboard): void {
  const { page, store, views } = dash;
  const { pastResults } = campaignHelpers(dash);

  /**
   * An item's run's page, wherever the run ran (goal 170): a run of a retired rig, or from before
   * a full reset, has one too. None for a run no rig created.
   */
  const runLink = (run: string) => {
    const r = store.runRegistry.created(run);
    return r ? runHref({ id: run, campaign: r.campaign }) : undefined;
  };

  // ---------------------------------------------------------------- the Knowledge page (goal 065)
  app.get("/ui/knowledge", (c) => {
    const vs = views();
    const kb = store.kb();
    const collections = kb.collections();
    const q = (c.req.query("q") ?? "").slice(0, 300);
    const kind = SEARCH_KINDS.find((k) => k === c.req.query("kind")) ?? "";
    const outcome = KB_OUTCOMES.find((k) => k === c.req.query("outcome")) ?? "";
    const collection =
      collections.find((f) => f.campaign === c.req.query("collection"))?.campaign ?? "";
    const limit = 100;
    const where = (collection ? [collection] : collections.map((f) => f.campaign)).map(
      (campaign) => ({ campaign }),
    );
    const found = kb.find(q, where, {
      ...(kind ? { kinds: [kind] } : {}),
      ...(outcome ? { outcomes: [outcome] } : {}),
      limit,
    });
    return page(
      c,
      {
        title: "Knowledge",
        summary:
          "Thermite's knowledge base: a collection for each campaign, and what each may read",
        active: "knowledge",
      },
      knowledgePage({
        collections,
        mode: modeWords(campaignModes(store, vs)),
        q,
        kind,
        outcome,
        collection,
        results: found.hits,
        matched: found.matched,
        counts: found.counts,
        limit,
        now: Date.now(),
        link: runLink,
        result: (x) => kb.resultOf(x),
      }),
      vs,
    );
  });

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
