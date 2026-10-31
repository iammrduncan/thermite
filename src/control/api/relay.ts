import type { Hono } from "hono";
import { cancelCommand } from "../issue/index.ts";
import type { ApiContext } from "./context.ts";
import { supervisorRoutes } from "./supervisor.ts";

/**
 * What a rig's supervisor fetches from control over HTTPS, with the rig's token, beside the message
 * bus: the registration of its keys on the bus, and the kits control keeps, by git. Its reports,
 * commands, figures, live lines, screens, config and knowledge base go on the bus (bus/asks.ts and
 * the bus's consumers). The owner's cancel of a command still pending is here too.
 */
export function relayRoutes(app: Hono, api: ApiContext): void {
  const { store, opts, parts, admin, rigAuth } = api;

  app.post("/v1/commands/:id/cancel", admin, (c) =>
    cancelCommand(store, c.req.param("id"), "owner:api")
      ? c.json({ cancelled: true })
      : c.json({ error: "no such pending command" }, 404),
  );

  // The registration of the rig's keys on the bus (api/supervisor.ts).
  supervisorRoutes(app, rigAuth, { store, busUsers: opts.busUsers, busConfig: opts.busConfig });

  // A kit control keeps, as plain-HTTP git for a rig's supervisor to fetch by commit. Only the
  // files such a fetch reads are served; the query git sends first (?service=...) is ignored,
  // which tells git to fetch the plain way.
  app.get("/v1/rigs/:rig/git/kits/:repo/*", rigAuth, (c) => {
    const m = /^(.+)\.git$/.exec(c.req.param("repo"));
    const rel = c.req.path.split(`/git/kits/${c.req.param("repo")}/`)[1] ?? "";
    const body = m && parts.kits ? parts.kits.file(m[1] as string, rel) : undefined;
    if (!body) return c.text("not found", 404);
    return c.body(new Uint8Array(body), 200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    });
  });
}
