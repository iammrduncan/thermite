import type { Hono } from "hono";
import { promptRecord, sectionsText } from "../../agents/prompt.ts";
import {
  KEEP_PROMPT,
  PROMPT_PREVIEW,
  RUN_PROMPT,
  RUN_PROMPTS,
} from "../../core/api/harness/prompts.ts";
import { type ApiContext, limitOf } from "./context.ts";

/**
 * The prompts a run's agents were sent (goal 166): the supervisor keeps its advisors' here, and
 * reads a run's prompts, one whole, and a preview of a role's next one, rendered on the rig with
 * no side effect. The harness keeps its own agents' prompts as it sends them.
 */
export function promptRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  app.post(KEEP_PROMPT.path, supervisor, limitOf(KEEP_PROMPT), async (c) => {
    const { run, ...record } = KEEP_PROMPT.body.parse(await c.req.json());
    if (!service.ledger.runs.get(run)) return c.json({ error: `no run ${run}` }, 404);
    return c.json({ id: service.ledger.prompts.record("supervisor", run, record) }, 201);
  });

  app.get(RUN_PROMPTS.path, supervisor, (c) =>
    c.json({ prompts: service.ledger.prompts.list(c.req.param("run")) }),
  );

  app.get(RUN_PROMPT.path, supervisor, (c) => {
    const p = service.ledger.prompts.get(Number(c.req.param("id")));
    if (!p || p.run !== c.req.param("run"))
      return c.json({ error: `no prompt ${c.req.param("id")} in ${c.req.param("run")}` }, 404);
    return c.json(p);
  });

  // A role's next prompt, rendered now: nothing is kept, no message is marked as given.
  app.get(PROMPT_PREVIEW.path, supervisor, (c) => {
    const run = c.req.param("run");
    const role = c.req.query("role") ?? "worker";
    if (role !== "worker" && role !== "planner")
      return c.json({ error: "a preview is of the worker's or the planner's next prompt" }, 400);
    if (!service.ledger.runs.get(run)) return c.json({ error: `no run ${run}` }, 404);
    if (!service.promptPreview)
      return c.json({ error: "this rig runs no agents, so it renders no prompt" }, 409);
    const p = service.promptPreview(run, {
      role,
      lane: c.req.query("lane"),
      experiment: c.req.query("experiment"),
    });
    const { role: r, program, sections } = promptRecord(p, {});
    return c.json({ role: r, program, sections, text: sectionsText(p.message) });
  });
}
