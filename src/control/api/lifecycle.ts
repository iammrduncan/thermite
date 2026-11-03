import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { errorText, jsonBody } from "../../common/errors.ts";
import {
  RESET,
  RESET_CANCEL,
  RESET_CONFIRM,
  RESETS,
  RESTART,
} from "../../core/api/control/owner.ts";
import { advanceResets, cancelReset, confirmReset } from "../lifecycle.ts";
import { runpodResetRefusal } from "../runpod/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * Lifecycle (owner): restart through the deployment driver (RunPod's for a rig on RunPod); the
 * full reset with state wipe.
 */
export function lifecycleRoutes(app: Hono, api: ApiContext): void {
  const { store, privateKeyPem, opts, parts, admin } = api;
  const { runpodDriver } = parts;

  app.post(RESTART.path, admin, bodyLimit({ maxSize: RESTART.maxBytes }), async (c) => {
    const rig = c.req.param("rig");
    const onRunpod = runpodDriver.serves(rig);
    const driver = onRunpod ? runpodDriver : opts.driver;
    if (!driver) return c.json({ error: "no deployment driver is configured" }, 409);
    const body = RESTART.body.parse(await c.req.json().catch(() => ({})));
    store.auditLog.add("owner:api", "restart", { rig, components: body.components });
    if (!onRunpod) return c.json({ restarted: await driver.restart(rig, body.components) });
    try {
      return c.json({ restarted: await driver.restart(rig, body.components, "owner:api") });
    } catch (err) {
      return c.json({ error: errorText(err) }, 409);
    }
  });

  app.post(RESET.path, admin, bodyLimit({ maxSize: RESET.maxBytes }), async (c) => {
    const rig = c.req.param("rig");
    const body = RESET.body.parse(await jsonBody(c.req));
    if (body.confirm !== `reset ${rig}`)
      return c.json({ error: `confirm with "reset ${rig}"` }, 400);
    // A rig on RunPod: its pod must run, with no stop, start or terminate under way.
    const refused = runpodResetRefusal(store, rig);
    if (refused) return c.json({ error: refused }, 409);
    const id = store.fullResets.create(rig, "owner:api");
    await advanceResets({
      store,
      privateKeyPem,
      driver: opts.driver,
      staleAfterMs: opts.staleAfterMs,
    });
    return c.json({ reset: id }, 201);
  });

  app.get(RESETS.path, admin, (c) => c.json({ resets: store.fullResets.list() }));

  app.post(RESET_CONFIRM.path, admin, async (c) => {
    confirmReset(store, Number(c.req.param("id")), "owner:api");
    await advanceResets({
      store,
      privateKeyPem,
      driver: opts.driver,
      staleAfterMs: opts.staleAfterMs,
    });
    return c.json({ ok: true });
  });

  app.post(RESET_CANCEL.path, admin, (c) => {
    cancelReset(store, Number(c.req.param("id")), "owner:api");
    return c.json({ ok: true });
  });
}
