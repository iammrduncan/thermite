import type { Hono, MiddlewareHandler } from "hono";
import { AGENT_ROLE, AGENT_ROLES, RUN_PROMPT, RUN_PROMPTS } from "../../core/api/control/agents.ts";
import { role, roles, runPrompt, runPrompts } from "../prompts.ts";
import type { ControlStore } from "../store/index.ts";
import type { RunOnRig } from "../views/index.ts";

/**
 * Control's REST routes for the agents' roles and the prompts a run's agents were sent (goal 166),
 * the owner's: every role's definition (`?texts=true` with its texts), one
 * role whole, a run's prompts, and one prompt with its sections' sources and texts.
 */
export function agentRoutes(
  app: Hono,
  admin: MiddlewareHandler,
  deps: { store: ControlStore; find(run: string): Promise<RunOnRig | undefined> },
): void {
  app.get(AGENT_ROLES.path, admin, (c) =>
    c.json({ roles: roles({ texts: c.req.query("texts") === "true" }) }),
  );

  app.get(AGENT_ROLE.path, admin, (c) => {
    const r = role(c.req.param("role"));
    return r ? c.json(r) : c.json({ error: `no role ${c.req.param("role")}` }, 404);
  });

  app.get(RUN_PROMPTS.path, admin, async (c) => {
    const run = c.req.param("run");
    const found = await deps.find(run);
    if (!found) return c.json({ error: `no run ${run}` }, 404);
    return c.json({ run, rig: found.rig.id, prompts: await runPrompts(deps.store, found) });
  });

  app.get(RUN_PROMPT.path, admin, async (c) => {
    const run = c.req.param("run");
    const found = await deps.find(run);
    if (!found) return c.json({ error: `no run ${run}` }, 404);
    const id = Number(c.req.param("id"));
    const p = Number.isInteger(id) ? await runPrompt(deps.store, found, id) : undefined;
    return p ? c.json(p) : c.json({ error: `no prompt ${c.req.param("id")} in ${run}` }, 404);
  });
}
