import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { log } from "../../common/env.ts";
import { errorText, faultAnswer } from "../../common/errors.ts";
import { HEALTH } from "../../core/api/harness/supervisor.ts";
import type { HarnessService } from "../service/index.ts";
import { advisorRoutes } from "./advisors.ts";
import { type ApiTokens, allows, apiContext, type HarnessApiExtras, statusFor } from "./context.ts";
import { kbRoutes } from "./kb.ts";
import { mcpRoutes } from "./mcp.ts";
import { promptRoutes } from "./prompts.ts";
import { proxyRoutes } from "./proxy.ts";
import { refusalWords } from "./refusal.ts";
import { exportRoutes, liveRoutes, reportRoutes } from "./relay.ts";
import { rigRoutes } from "./rig.ts";
import { advisorTerminalRoutes } from "./terminals.ts";
import { trialRoutes } from "./trials.ts";
import { usageRoutes } from "./usage.ts";
import { workRoutes } from "./work.ts";

export type { ApiTokens, HarnessApiExtras, Scope } from "./context.ts";

/**
 * Harness HTTP API. Only the rig's own supervisor reaches it over the network; proposers
 * (workers) reach it locally. Every route except /v1/health needs a bearer token whose scope
 * allows it; /v1/health says without one only whether the harness is well and its disk at its
 * floor.
 *
 * Each section of the API is a module in api/ that adds its routes to the app, with what it takes
 * from the context built once here (api/context.ts: the scopes, the caller's trial, how an error
 * becomes a status). They are added in this order, the order Hono matches them in.
 */
export function createHarnessApi(
  service: HarnessService,
  tokens: ApiTokens,
  extras: HarnessApiExtras = {},
): Hono {
  const app = new Hono();
  const api = apiContext(service, tokens, extras);

  // A request the schema refused says which field and why (goal 143), from the body it sent. A
  // body past its route's limit keeps its own answer, 413. A fault is answered with an id only,
  // which the harness's log line gives with the fault's own words.
  app.onError(async (err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const status = statusFor(err);
    if (status === 500) {
      const fault = faultAnswer();
      const where = { method: c.req.method, path: c.req.path, id: fault.id };
      log("harness", "request failed", { ...where, error: errorText(err) }, "error");
      return c.json({ error: fault.error }, 500);
    }
    if (!(err instanceof z.ZodError)) return c.json({ error: err.message }, status);
    const body = await c.req.json().catch(() => undefined);
    const why = refusalWords(err, body);
    log("harness", "request refused", { method: c.req.method, path: c.req.path, why }, "warn");
    return c.json({ error: `invalid request: ${why}` }, status);
  });

  // 503 when a loop is late (goal 173), and `degraded` while the disk is at its floor: that holds
  // new work, but the harness is well, so it answers 200. That is all a probe gets; the
  // supervisor's token also gets each loop with its age, the rig and the disk's reading.
  app.get(HEALTH.path, (c) => {
    const h = service.loops.health();
    const disk = service.disk?.summary();
    const said = { ok: h.ok, ...(disk ? { degraded: disk.low } : {}) };
    if (!allows(tokens, ["supervisor"], c.req.header("authorization")))
      return c.json(said, h.ok ? 200 : 503);
    return c.json({ ...h, ...said, rig: service.rig, ...(disk ? { disk } : {}) }, h.ok ? 200 : 503);
  });

  proxyRoutes(app, api);
  rigRoutes(app, api);
  mcpRoutes(app, api);
  kbRoutes(app, api);
  advisorTerminalRoutes(app, api);
  reportRoutes(app, api);
  advisorRoutes(app, api);
  liveRoutes(app, api);
  trialRoutes(app, api);
  usageRoutes(app, api);
  promptRoutes(app, api);
  exportRoutes(app, api);
  workRoutes(app, api);

  return app;
}
