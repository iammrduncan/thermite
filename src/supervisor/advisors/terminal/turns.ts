import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { TurnDelivery } from "../../../agents/cli/index.ts";
import { sameSecret } from "../../../common/secrets.ts";
import { TURN_OFFER, TURN_TAKEN } from "../../../core/api/harness/turn.ts";

/**
 * The owner's messages inside an advisor's turn (goal 169), as the supervisor serves them for one
 * call in its program's own terminal: TURN_OFFER and TURN_TAKEN, on localhost for the length of the
 * call, as the harness serves them for a trial. They take only a credential made for the call
 * (`call.<hex>`), which Thermite's hook program and its OpenCode plugin send from the program's
 * environment, and ask the call's delivery (TurnMessages) while its terminal runs.
 */
export interface AdvisorTurns {
  /** Where the hooks and the plugin ask, as THERMITE_HARNESS_URL names it. */
  url: string;
  /** The call's credential, as THERMITE_TRIAL_AUTH holds it. */
  auth: string;
  /** Who answers now: the call's delivery while its terminal runs, else none. */
  set(d: TurnDelivery | undefined): void;
  close(): Promise<void>;
}

/** Starts the call's turn routes on a free local port. Close them when the call ends. */
export async function serveAdvisorTurns(): Promise<AdvisorTurns> {
  const auth = `call.${randomBytes(24).toString("hex")}`;
  let delivery: TurnDelivery | undefined;
  const app = new Hono();
  const allowed = (header: string | undefined) => sameSecret(header ?? "", `Bearer ${auth}`);
  app.post(TURN_OFFER.path, bodyLimit({ maxSize: TURN_OFFER.maxBytes }), async (c) => {
    if (!allowed(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const body = TURN_OFFER.body.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "a place to offer at: after-tool or turn-end" }, 400);
    return c.json(delivery?.offer(body.data.at) ?? { offer: null, text: "" });
  });
  app.post(TURN_TAKEN.path, bodyLimit({ maxSize: TURN_TAKEN.maxBytes }), async (c) => {
    if (!allowed(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const body = TURN_TAKEN.body.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "an offer's id" }, 400);
    return c.json({ messages: delivery?.taken(body.data.offer) ?? [] });
  });
  app.all("*", (c) => c.json({ error: "not found" }, 404));
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    auth,
    set: (d) => {
      delivery = d;
    },
    close: () =>
      new Promise<void>((r) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
