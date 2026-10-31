import { createServer, type Server } from "node:http";
import { parseListen } from "../common/env.ts";
import type { Loops } from "../common/health.ts";
import { log } from "../common/log.ts";
import { sameSecret } from "../common/secrets.ts";
import { SUPERVISOR_HEALTH_LISTEN } from "../core/health.ts";

/** Where the supervisor answers its health route: `host:port`, in its own container by default. */
export const HEALTH_LISTEN_SETTING = "THERMITE_SUPERVISOR_HEALTH_LISTEN";

/**
 * The supervisor's health route (goal 173): `GET /v1/health` answers `{ok}`, and 503 when one of
 * its report, command and live loops is past its limit; with the supervisor's token for its
 * harness (`token`), also `rig` and `loops`, each loop with the time since it last came around.
 * It is all the server answers: anything else is a 404. It listens on the container's loopback by
 * default, so only a check inside the container reaches it.
 */
export function serveHealth(
  env: Record<string, string | undefined>,
  rig: string,
  loops: Loops,
  token: string,
): Server {
  const { host, port } = parseListen(env[HEALTH_LISTEN_SETTING] || SUPERVISOR_HEALTH_LISTEN);
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/v1/health") {
      res.writeHead(404).end();
      return;
    }
    const h = loops.health();
    const details = token !== "" && sameSecret(req.headers.authorization ?? "", `Bearer ${token}`);
    res
      .writeHead(h.ok ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify(details ? { ...h, rig } : { ok: h.ok }));
  });
  server.on("error", (err) =>
    log("supervisor", "the health route can't listen", { host, port, error: err.message }, "error"),
  );
  server.listen(port, host);
  server.unref();
  return server;
}
