import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { jsonBody } from "../../common/errors.ts";
import { KB_ITEM, KB_SEARCH, PROPAGATE } from "../../core/api/control/owner.ts";
import { CHAMPION_PATCH } from "../../core/api/control/rigs.ts";
import { keepChampionPatch } from "../champions.ts";
import { type ExportFiles, mountExports } from "../exports.ts";
import { propagateChampion } from "../issue/index.ts";
import { KbReadQuery, KbSearchQuery, ownerKbRead, ownerKbSearch } from "../kb/index.ts";
import { resultsLeft } from "../results-left.ts";
import { leaderboard } from "../views/index.ts";
import { type ApiContext, clampLimit } from "./context.ts";

/**
 * What rigs' runs produce, and the owner reads: the knowledge base, champions' patches as the rigs
 * upload them (the owner reads them under the run: api/runs.ts), exports (`exportFiles`: where
 * control keeps them; none, it takes none), daily reports (the rigs send them on the message bus:
 * bus/asks.ts), the leaderboard, and a champion propagated to another rig.
 */
export function resultRoutes(
  app: Hono,
  api: ApiContext,
  exportFiles: ExportFiles | undefined,
): void {
  const { store, privateKeyPem, opts, admin, rigAuth } = api;

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
  app.post(PROPAGATE.path, admin, bodyLimit({ maxSize: PROPAGATE.maxBytes }), async (c) => {
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
