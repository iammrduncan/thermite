import type { Hono } from "hono";
import { ADVISOR_ROUTES, MODEL_ROUTE } from "../../core/api/control/rigs.ts";
import { advisorRoutesOf, configOnBusRefusal, modelRoutesOf } from "../rigs/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * The model routes a rig's supervisor fetches, with the rig's token: its workers' and its
 * planner's, and its advisors' by role, each with its provider's key or a subscription's token
 * (rigs/model-routes.ts). A rig on the message bus gets them in its config there, and only there:
 * these routes refuse it (409).
 */
export function modelRoutes(app: Hono, api: ApiContext): void {
  const { parts, rigAuth } = api;

  // The provider and model this rig's agents use, with the provider's key, for the rig's supervisor
  // alone: it hands them to its harness. 409 when the key can't be opened.
  app.get(MODEL_ROUTE.path, rigAuth, async (c) => {
    c.header("cache-control", "no-store");
    const rig = c.req.param("rig");
    const onBus = configOnBusRefusal(parts.store, rig);
    if (onBus) return c.json({ error: onBus }, 409);
    const r = await modelRoutesOf(parts, rig);
    return "error" in r ? c.json({ error: r.error }, 409) : c.json(r);
  });

  // The advisors' routes, by role, when the owner gave them models.
  app.get(ADVISOR_ROUTES.path, rigAuth, async (c) => {
    c.header("cache-control", "no-store");
    const rig = c.req.param("rig");
    const onBus = configOnBusRefusal(parts.store, rig);
    if (onBus) return c.json({ error: onBus }, 409);
    return c.json(await advisorRoutesOf(parts, rig));
  });
}
