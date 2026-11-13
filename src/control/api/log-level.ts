import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CONTROL_LOG_LEVEL, SET_CONTROL_LOG_LEVEL } from "../../core/api/control/owner.ts";
import { controlLogLevelOf, setControlLogLevel } from "../log-level.ts";
import type { ApiContext } from "./context.ts";

/**
 * Control's own log level, with the owner's token (control/log-level.ts), as MCP's
 * control_log_level and set_control_log_level and `thermite log-level control`: read, or set at
 * once and kept. A rig's parts change theirs by the signed `log_level` command (`POST /v1/commands`).
 */
export function logLevelRoutes(app: Hono, api: ApiContext): void {
  const { store, admin } = api;
  app.get(CONTROL_LOG_LEVEL.path, admin, async (c) => c.json(await controlLogLevelOf(store)));
  app.put(
    SET_CONTROL_LOG_LEVEL.path,
    admin,
    bodyLimit({ maxSize: SET_CONTROL_LOG_LEVEL.maxBytes }),
    async (c) => {
      const body = await c.req.json().catch(() => undefined);
      const o = await setControlLogLevel(store, body, "owner:api");
      return o.ok
        ? c.json({ ...o.level, said: o.said })
        : c.json({ error: `bad request: ${o.error}` }, 400);
    },
  );
}
