import type { Hono } from "hono";
import { busState } from "../bus/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * The message bus's state (goal 168): its server, the streams control makes with what each
 * consumer has still to take, and the live stream's figures. The reader's token reads it, as it
 * reads /metrics. With the bus off, it says so.
 */
export function busRoutes(app: Hono, api: ApiContext): void {
  const { store, parts, reader } = api;
  app.get("/v1/bus", reader, async (c) => c.json(await busState(store, parts.bus)));
}
