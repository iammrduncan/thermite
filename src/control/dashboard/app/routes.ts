import type { Hono } from "hono";
import { HOME, RUN_OVERVIEW } from "../../../core/api/control/dashboard.ts";
import type { Dashboard } from "../context.ts";
import { homeAnswer } from "./home.ts";
import { runOverviewAnswer } from "./run.ts";

/**
 * The reads of the dashboard's app that still stand on page code (goal 243): Home, and a run's
 * Overview. They are routes of /v1, with their contracts in core, guarded as the owner's routes
 * are; the pages add them because their words and cards are the pages' own. Each moves to the API
 * when its words leave page code (goals 244, 246 and 247).
 */
export function appReadRoutes(app: Hono, dash: Dashboard): void {
  const { archivedNames, needs, notArchived, opts, parts, store, views } = dash;
  const noStore = { "cache-control": "no-store" };

  app.get(HOME.path, opts.ownerOnly, async (c) => {
    const now = Date.now();
    const vs = await views();
    const archived = await archivedNames();
    const feed = notArchived(vs, await needs(c, vs, now), archived);
    return c.json(await homeAnswer(store, vs, feed, archived, now), 200, noStore);
  });

  app.get(RUN_OVERVIEW.path, opts.ownerOnly, async (c) => {
    const now = Date.now();
    const run = c.req.param("run") ?? "";
    const x = await parts.run(run);
    if (!x) return c.json({ error: `no run ${run}` }, 404);
    const feed = (await needs(c, [x.rig], now)).filter((n) => n.run === x.run.id);
    return c.json(await runOverviewAnswer(store, x.rig, x.run, feed, now), 200, noStore);
  });
}
