import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import {
  Commit,
  DEVICE,
  DEVICE_GIT,
  DeviceAsk,
  MirrorName,
} from "../../core/api/harness/device.ts";
import { HEALTH } from "../../core/api/harness/supervisor.ts";
import type { DevRuns, LaneRunner } from "../agents/index.ts";
import { type ApiTokens, allows } from "../api/index.ts";
import { DeviceRefusal, type DeviceServer } from "./device.ts";
import { type LaneHost, LaneRefusal } from "./lanes.ts";
import { laneRoutes } from "./trial-api.ts";

/**
 * A follower's API (goal 205): its health, and its judge GPUs and lanes for the leader
 * (core/api/harness/device.ts). Only its own supervisor reaches those, with the supervisor's
 * token, and passes on the leader's asks. Its lanes' trials reach their own routes with their
 * trial's token (trial-api.ts).
 */
export function followerApi(
  device: DeviceServer,
  tokens: ApiTokens,
  rig: string,
  lanes?: { host: LaneHost; lanes: LaneRunner; devRuns?: DevRuns | undefined } | undefined,
  /** Its own report-signing key's public part, which its supervisor registers (step 3). */
  reportKey?: string | undefined,
): Hono {
  const app = new Hono();

  // A refused ask says why: a card the follower lacks, a folder it did not name, a field the
  // schema refused. A failure is logged and answered with its words, which the leader's judge
  // records as an infrastructure failure.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof z.ZodError)
      return c.json({ error: `invalid request: ${err.issues[0]?.message ?? "bad body"}` }, 400);
    if (err instanceof DeviceRefusal || err instanceof LaneRefusal)
      return c.json({ error: err.message }, 409);
    const error = errorText(err);
    log("harness", "device ask failed", { path: c.req.path, error }, "error");
    return c.json({ error: error.slice(0, 2000) }, 500);
  });

  app.get(HEALTH.path, (c) =>
    c.json(
      allows(tokens, ["supervisor"], c.req.header("authorization"))
        ? { ok: true, rig, follower: true, ...(reportKey ? { report_key: reportKey } : {}) }
        : { ok: true },
    ),
  );

  const supervisorOnly: MiddlewareHandler = async (c, next) => {
    if (!allows(tokens, ["supervisor"], c.req.header("authorization")))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  app.use(DEVICE.path, supervisorOnly);
  app.use(`${DEVICE.path}/*`, supervisorOnly);

  app.post(DEVICE.path, bodyLimit({ maxSize: DEVICE.maxBytes }), async (c) =>
    c.json(await device.ask(DeviceAsk.parse(await c.req.json()))),
  );

  app.post(DEVICE_GIT.path, bodyLimit({ maxSize: DEVICE_GIT.maxBytes }), async (c) => {
    const repo = MirrorName.parse(c.req.param("repo"));
    const commit = Commit.parse(c.req.param("commit"));
    await device.takeGit(repo, commit, Buffer.from(await c.req.arrayBuffer()));
    return c.json({ ok: true });
  });

  if (lanes) laneRoutes(app, lanes.host, lanes);

  return app;
}
