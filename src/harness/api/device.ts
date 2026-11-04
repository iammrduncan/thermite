import type { Hono } from "hono";
import { DEVICE_ANSWER, DEVICE_ASKS } from "../../core/api/harness/device.ts";
import { type ApiContext, limitOf } from "./context.ts";

/** The longest the supervisor's take of the followers' asks waits for one, in milliseconds. */
const TAKE_WAIT_MAX_MS = 25_000;

/**
 * The leader's asks of its followers (goal 205): the supervisor takes them, carries each on the
 * bus, and brings back each follower's answer. A rig with no followers has none.
 */
export function deviceRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  app.get(DEVICE_ASKS.path, supervisor, async (c) => {
    const wait = Math.min(Math.max(Number(c.req.query("wait") ?? "0") || 0, 0), TAKE_WAIT_MAX_MS);
    const link = service.followers;
    if (link) return c.json({ asks: await link.take(wait) });
    // No followers: none ever comes, and the take waits all the same, so the supervisor's
    // next comes no sooner than it would with followers.
    await new Promise((r) => setTimeout(r, wait));
    return c.json({ asks: [] });
  });
  app.post(DEVICE_ANSWER.path, supervisor, limitOf(DEVICE_ANSWER), async (c) => {
    const body = DEVICE_ANSWER.body.parse(await c.req.json());
    const ok = service.followers?.answer(c.req.param("id"), body) ?? false;
    return ok ? c.json({ ok }) : c.json({ ok, error: "no such ask is open" }, 404);
  });
}
