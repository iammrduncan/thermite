import type { Hono } from "hono";
import { copiedFromRecords, untriedOf } from "../campaigns/index.ts";
import { cursorOf } from "../store/index.ts";
import { findRun, rigEventsPage, rigView } from "../views/index.ts";
import { agentRoutes } from "./agents.ts";
import { type ApiContext, clampLimit } from "./context.ts";
import { runRoutes } from "./runs.ts";

/**
 * What control recorded of a rig, for the owner: its live lines (the reader's token reads them
 * too) and its events; and, on the rig's page beside them, the acceptance of its pending report key.
 */
export function rigRecordRoutes(app: Hono, api: ApiContext): void {
  const { store, admin, reader } = api;

  app.get("/v1/rigs/:rig/live", reader, (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const source = c.req.query("source") || undefined;
    const limit = clampLimit(c.req.query("limit"), 500);
    return c.json({
      sources: store.liveLines.sources(c.req.param("rig")),
      entries: after
        ? store.liveLines.after(c.req.param("rig"), after, limit, source)
        : store.liveLines.tail(c.req.param("rig"), limit, source),
    });
  });

  app.post("/v1/rigs/:rig/key/accept", admin, (c) =>
    store.reportedRigs.acceptPendingKey(
      c.req.param("rig"),
      "owner:api",
      c.req.query("fingerprint") ?? "",
    )
      ? c.json({ accepted: true })
      : c.json({ error: "no pending key" }, 404),
  );

  // Read from the message bus's events stream: each event's seq is its place there.
  app.get("/v1/rigs/:rig/events", admin, async (c) => {
    const after = Math.max(0, Math.trunc(Number(c.req.query("after") ?? "0")) || 0);
    const limit = clampLimit(c.req.query("limit"), 500);
    return c.json({
      events: await rigEventsPage(store, { rig: c.req.param("rig"), after, limit }),
    });
  });
}

/** Control's audit log, a page at a time; a rig's view; and one run by its name (api/runs.ts). */
export function recordRoutes(app: Hono, api: ApiContext): void {
  const { store, viewOpts, admin } = api;

  // A page of the audit log, newest first; older and newer are the cursors for the next pages.
  app.get("/v1/audit", admin, (c) => {
    const raw = { before: c.req.query("before"), after: c.req.query("after") };
    const before = cursorOf(raw.before);
    const after = cursorOf(raw.after);
    // A cursor that is not a number (a script's "null") is refused: the newest page again would loop.
    if (
      (raw.before !== undefined && before === undefined) ||
      (raw.after !== undefined && after === undefined)
    )
      return c.json({ error: "before and after are whole numbers" }, 400);
    if (before !== undefined && after !== undefined)
      return c.json({ error: "give before or after, not both" }, 400);
    const p = store.auditLog.page(clampLimit(c.req.query("limit"), 200), {}, { before, after });
    return c.json({ audit: p.entries, older: p.older, newer: p.newer });
  });

  app.get("/v1/rigs/:rig/view", admin, (c) => {
    const v = rigView(store, c.req.param("rig"), viewOpts);
    return v ? c.json(v) : c.json({ error: "not found" }, 404);
  });

  // One run by its name, wherever it ran: the run itself, of a size an agent can read, one of
  // its attempts, its untried experiments, its directions and its champions' patches
  // (src/control/api/runs.ts).
  runRoutes(app, admin, {
    store,
    find: (run) => findRun(store, run, viewOpts),
    untried: (r, campaign) => copiedFromRecords(store, campaign, untriedOf(r).slice(0, 500)),
  });
  // The agents' roles, and the prompts a run's agents were sent (src/control/api/agents.ts).
  agentRoutes(app, admin, { store, find: (run) => findRun(store, run, viewOpts) });
}
