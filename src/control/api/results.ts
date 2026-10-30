import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { jsonBody } from "../../common/errors.ts";
import { KB_ITEM, KB_SEARCH, PROPAGATE } from "../../core/api/control/owner.ts";
import {
  CHAMPION_PATCH,
  KB,
  KB_NOT_ASSIGNED,
  KB_READ_ASK,
  KB_SEARCH_ASK,
  REPORTS,
} from "../../core/api/control/rigs.ts";
import { keepChampionPatch } from "../champions.ts";
import { type ExportFiles, mountExports } from "../exports.ts";
import { propagateChampion } from "../issue/index.ts";
import {
  answerKbAsk,
  KbReadQuery,
  KbSearchQuery,
  kbAskLimit,
  ownerKbRead,
  ownerKbSearch,
} from "../kb/index.ts";
import { resultsLeft } from "../results-left.ts";
import { leaderboard } from "../views/index.ts";
import { type ApiContext, clampLimit } from "./context.ts";

/**
 * What rigs' runs produce, and the owner reads: the knowledge base's items for a run's agents,
 * champions' patches as the rigs upload them (the owner reads them under the run: api/runs.ts),
 * exports (`exportFiles`: where control keeps them; none, it takes none),
 * daily reports, the leaderboard, and a champion propagated to another rig.
 */
export function resultRoutes(
  app: Hono,
  api: ApiContext,
  exportFiles: ExportFiles | undefined,
): void {
  const { store, privateKeyPem, opts, admin, rigAuth } = api;

  // Past research for a run's agents (goal 065): the items of the collections the run's campaign
  // may read, after the supervisor's cursor. Only the rig's own runs; never a collection not granted.
  app.get(KB.path, rigAuth, (c) => {
    c.header("cache-control", "no-store");
    const run = c.req.query("run") ?? "";
    const after = Number(c.req.query("after") ?? "0");
    if (!run) return c.json({ error: "run is required" }, 400);
    if (!Number.isSafeInteger(after) || after < 0)
      return c.json({ error: "after is a whole number from 0" }, 400);
    // Only a run control assigned to this rig, of the campaign control assigned: a rig cannot
    // read another campaign's collections by naming it in its own events.
    const assigned = store.runRegistry.assignedCampaigns(c.req.param("rig")).get(run);
    if (!assigned) {
      const error = `control did not assign run ${run} to this rig`;
      return c.json({ error, code: KB_NOT_ASSIGNED }, 404);
    }
    const sync = store.kb().sync(c.req.param("rig"), run, after);
    if (!sync) return c.json({ error: `this rig has no run ${run}` }, 404);
    if (sync.campaign !== assigned)
      return c.json({ error: `run ${run} is not of the campaign control assigned` }, 409);
    return c.json(sync);
  });

  // A search or a read of the knowledge base for an agent of one of the rig's runs (goal 175), for
  // a rig not on the message bus: the answer the bus gives, a refusal in words included.
  for (const [route, kind] of [
    [KB_SEARCH_ASK, "search"],
    [KB_READ_ASK, "read"],
  ] as const)
    app.post(route.path, rigAuth, bodyLimit({ maxSize: route.maxBytes }), async (c) => {
      c.header("cache-control", "no-store");
      const body = await c.req.json().catch(() => undefined);
      const rig = c.req.param("rig");
      return c.json(await kbAskLimit.run(rig, () => answerKbAsk(store, rig, kind, body)));
    });

  // The owner's search of the knowledge base, and one item read (goal 175): as MCP's kb_search and
  // kb_read. A list of names is given with commas, or as a repeated parameter; more queries
  // (`query`) and the addresses seen (`seen`) only as a repeated parameter.
  app.get(KB_SEARCH.path, admin, (c) => {
    const list = (k: string) =>
      (c.req.queries(k) ?? []).flatMap((v) => v.split(",")).filter(Boolean);
    const many = (k: string) => (c.req.queries(k) ?? []).filter(Boolean);
    const num = (k: string) => {
      const v = c.req.query(k);
      return v === undefined ? {} : { [k]: Number(v) };
    };
    const lists = {
      collections: list("collection"),
      kinds: list("kind"),
      outcomes: list("outcome"),
    };
    const more = {
      runs: list("run"),
      slots: list("slot"),
      queries: many("query"),
      seen: many("seen"),
    };
    const q = KbSearchQuery.safeParse({
      q: c.req.query("q") ?? "",
      ...Object.fromEntries(Object.entries({ ...lists, ...more }).filter(([, v]) => v.length)),
      ...(c.req.query("mode") ? { mode: c.req.query("mode") } : {}),
      ...(c.req.query("like") ? { like: c.req.query("like") } : {}),
      ...num("offset"),
      ...num("limit"),
    });
    if (!q.success) return c.json({ error: queryRefusal(q.error) }, 400);
    const r = ownerKbSearch(store, q.data);
    return "error" in r ? c.json(r, 400) : c.json(r);
  });
  app.get(KB_ITEM.path, admin, (c) => {
    const v = c.req.query("version");
    const at = c.req.query("offset");
    const q = KbReadQuery.safeParse({
      address: c.req.query("address") ?? "",
      ...(v !== undefined ? { version: Number(v) } : {}),
      ...(at !== undefined ? { offset: Number(at) } : {}),
    });
    if (!q.success) return c.json({ error: queryRefusal(q.error) }, 400);
    const r = ownerKbRead(store, q.data);
    return "error" in r ? c.json(r, 404) : c.json(r);
  });

  // A champion's patch, uploaded by the rig's supervisor once its export is published. It is
  // kept only if its sha256 is the one the rig's signed champion_published event names.
  app.post(
    CHAMPION_PATCH.path,
    rigAuth,
    bodyLimit({ maxSize: CHAMPION_PATCH.maxBytes }),
    async (c) => {
      const seq = Number(c.req.param("seq"));
      if (!Number.isInteger(seq) || seq < 1) return c.json({ error: "bad seq" }, 400);
      const patch = Buffer.from(await c.req.arrayBuffer());
      const r = await keepChampionPatch(store, c.req.param("rig"), c.req.param("run"), seq, patch);
      if (r === "not_published")
        return c.json({ error: "control has no champion_published event for it yet" }, 409);
      if (r === "mismatch")
        return c.json({ error: "the patch is not the one the rig published" }, 422);
      return c.json({ stored: true }, 201);
    },
  );

  // Exports a rig without a results repository sends to control, and the owner reads back.
  mountExports(app, {
    store,
    files: exportFiles,
    rigAuth,
    admin,
  });
  // Have all of a rig's results left it? (What a terminate waits for: goal 023.)
  app.get("/v1/rigs/:rig/results-left", admin, (c) =>
    c.json(resultsLeft(store, c.req.param("rig"), { export: c.req.query("export") || undefined })),
  );

  app.post(REPORTS.path, rigAuth, bodyLimit({ maxSize: REPORTS.maxBytes }), async (c) => {
    const body = REPORTS.body.parse(await jsonBody(c.req));
    return c.json({ id: store.rigReports.add(c.req.param("rig"), body.kind, body.body) }, 201);
  });

  app.get("/v1/reports", admin, (c) =>
    c.json({
      reports: store.rigReports.list(
        clampLimit(c.req.query("limit"), 20),
        c.req.query("rig") || undefined,
      ),
    }),
  );

  app.get("/v1/leaderboard", admin, (c) =>
    c.json({ campaigns: leaderboard(store, { staleAfterMs: opts.staleAfterMs }) }),
  );

  // One run's published champion to another run of its campaign, each named alone (goal 170).
  app.post(PROPAGATE.path, admin, async (c) => {
    const body = PROPAGATE.body.parse(await jsonBody(c.req));
    const r = await propagateChampion(store, privateKeyPem, {
      run: body.run,
      toRun: body.to_run,
      issuedBy: "owner:api",
      staleAfterMs: opts.staleAfterMs,
    });
    return c.json(r, 201);
  });
}

/** A query refused, in words: each field and what is wrong with it. */
function queryRefusal(err: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return `bad request: ${err.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ")}`;
}
