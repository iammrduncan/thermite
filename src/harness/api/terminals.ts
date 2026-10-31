import type { Hono } from "hono";
import {
  ADVISOR_INPUT_OUTCOMES,
  ADVISOR_INPUTS,
  ADVISOR_INPUTS_WAIT_MAX_S,
  ADVISOR_TERMINALS,
} from "../../core/api/harness/terminals.ts";
import { type ApiContext, limitOf } from "./context.ts";

/**
 * The advisors' terminals between the harness and its supervisor (goal 169;
 * core/api/harness/terminals.ts): the supervisor says which advisors' calls run in their terminals
 * now, takes the owner's inputs that wait for them (held open until one comes), and says what
 * became of each, which the harness records as it records a trial's.
 */
export function advisorTerminalRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  app.put(ADVISOR_TERMINALS.path, supervisor, limitOf(ADVISOR_TERMINALS), async (c) => {
    const { calls } = ADVISOR_TERMINALS.body.parse(await c.req.json());
    service.consoles.setAdvisors(calls, (id) => service.advisorInputs.console(id));
    return c.json({ ok: true });
  });
  app.get(ADVISOR_INPUTS.path, supervisor, async (c) => {
    const wait = Number(c.req.query("wait") ?? "0");
    if (!Number.isFinite(wait) || wait < 0)
      return c.json({ error: "wait is a number of seconds from 0" }, 400);
    const inputs = await service.advisorInputs.take(
      Math.min(wait, ADVISOR_INPUTS_WAIT_MAX_S) * 1000,
    );
    return c.json({ inputs });
  });
  app.post(ADVISOR_INPUT_OUTCOMES.path, supervisor, limitOf(ADVISOR_INPUT_OUTCOMES), async (c) => {
    const { outcomes } = ADVISOR_INPUT_OUTCOMES.body.parse(await c.req.json());
    let taken = 0;
    for (const o of outcomes) if (service.advisorInputs.outcome(o)) taken++;
    return c.json({ taken });
  });
}
