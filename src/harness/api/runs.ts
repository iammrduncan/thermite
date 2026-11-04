import type { Hono } from "hono";
import { RUN_ANSWER, RUN_ASKS } from "../../core/api/harness/runs.ts";
import { type ApiContext, limitOf } from "./context.ts";

/** The longest the supervisor's take of the runners' asks waits for one, in milliseconds. */
const TAKE_WAIT_MAX_MS = 25_000;

/**
 * The core's asks of its runners (goal 206): the supervisor takes them, carries each on the bus,
 * and brings back each runner's answer. A rig with no runners has none, and its supervisor never
 * asks.
 */
export function runRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  app.get(RUN_ASKS.path, supervisor, async (c) => {
    const wait = Math.min(Math.max(Number(c.req.query("wait") ?? "0") || 0, 0), TAKE_WAIT_MAX_MS);
    const link = service.runners;
    if (link) return c.json({ asks: await link.take(wait) });
    // No runners: none ever comes, and the take waits all the same.
    await new Promise((r) => setTimeout(r, wait));
    return c.json({ asks: [] });
  });
  app.post(RUN_ANSWER.path, supervisor, limitOf(RUN_ANSWER), async (c) => {
    const body = RUN_ANSWER.body.parse(await c.req.json());
    const ok = service.runners?.answer(c.req.param("id"), body) ?? false;
    return ok ? c.json({ ok }) : c.json({ ok, error: "no such ask is open" }, 404);
  });
}
