import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { jsonBody } from "../../common/errors.ts";
import { ACK, GIT_ACCESS, INGEST, LIVE, PENDING_COMMANDS } from "../../core/api/control/rigs.ts";
import { readReport } from "../../core/link/report.ts";
import { takeReport } from "../ingest.ts";
import { cancelCommand, pendingFor } from "../issue/index.ts";
import { takeLive } from "../live/index.ts";
import { closedRuns } from "../views/index.ts";
import type { ApiContext } from "./context.ts";
import { supervisorRoutes } from "./supervisor.ts";

/** How long a report refused for now tells its sender to wait before it sends it again. */
const RETRY_SECONDS = 5;

/**
 * What a rig's supervisor relays to control and fetches from it, with the rig's token: its reports,
 * the commands it fetches and acknowledges (and the owner's cancel of one still pending), its own
 * figures, the live view, the kits control keeps, and Git access for a private repository.
 */
export function relayRoutes(app: Hono, api: ApiContext): void {
  const { store, privateKeyPem, opts, control, parts, admin, rigAuth } = api;
  const { secrets } = parts;

  // A report the rig's supervisor posts; with the message bus, control also folds them from there.
  // Control answers once the report's events are on its events stream and applied; 503 refuses it
  // for now, and the supervisor sends it again.
  const intake = { store, control, requireKeyAcceptance: Boolean(opts.requireKeyAcceptance) };
  app.post(INGEST.path, rigAuth, bodyLimit({ maxSize: INGEST.maxBytes }), async (c) => {
    const read = readReport(await jsonBody(c.req));
    const [status, answer] = await takeReport(intake, c.req.param("rig"), read);
    if (status === 503) return c.json(answer, status, { "retry-after": String(RETRY_SECONDS) });
    return c.json(answer, status);
  });

  app.get(PENDING_COMMANDS.path, rigAuth, (c) =>
    c.json(pendingFor(store, privateKeyPem, c.req.param("rig"), c.req.query())),
  );

  app.post("/v1/commands/:id/cancel", admin, (c) =>
    cancelCommand(store, c.req.param("id"), "owner:api")
      ? c.json({ cancelled: true })
      : c.json({ error: "no such pending command" }, 404),
  );

  app.post(ACK.path, rigAuth, bodyLimit({ maxSize: ACK.maxBytes }), async (c) => {
    const body = ACK.body.parse(await jsonBody(c.req));
    const ok = store.commands.ack(c.req.param("rig"), c.req.param("id"), body.status, body.outcome);
    return ok ? c.json({ ok }) : c.json({ error: "no such pending command" }, 404);
  });

  // The supervisor's own figures, with its keys on the bus (api/supervisor.ts).
  supervisorRoutes(app, rigAuth, { store, busUsers: opts.busUsers, busConfig: opts.busConfig });

  // The live view: the harness's signed lines, and the supervisor's own (live/take.ts).
  app.post(LIVE.path, rigAuth, bodyLimit({ maxSize: LIVE.maxBytes }), async (c) => {
    const [status, answer] = takeLive(store, c.req.param("rig"), await jsonBody(c.req));
    return c.json(answer, status);
  });

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

  // Git access for a private repository, to a rig while a live assignment of it names the access,
  // with the host it is for; otherwise refused. The secret leaves control only here, never in a
  // signed command.
  app.get(GIT_ACCESS.path, rigAuth, (c) => {
    const rig = c.req.param("rig");
    const name = c.req.param("name");
    const g = store.gitAccess.get(name);
    if (!g?.host || !store.commands.rigUsesGitAccess(rig, name, closedRuns(store, rig)))
      return c.json({ error: "no such Git access for this rig" }, 404);
    let secret: string;
    try {
      secret = secrets.open(g.secret_sealed);
    } catch {
      return c.json(
        { error: "the Git access could not be unsealed (control's secrets key?)" },
        500,
      );
    }
    store.auditLog.add(`rig:${rig}`, "git_access_handed", { name });
    c.header("cache-control", "no-store");
    return c.json(
      g.kind === "ssh"
        ? { kind: "ssh", private_key: secret, host: g.host }
        : { kind: "token", token: secret, username: g.username ?? undefined, host: g.host },
    );
  });
}
