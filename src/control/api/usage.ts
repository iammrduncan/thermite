import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { jsonBody } from "../../common/errors.ts";
import { busMetricsText, healthMetricsText, metricsText } from "../metrics.ts";
import { modelPrices, modelUsage, setModelPrice, usageQueryRefusal } from "../usage.ts";
import type { ApiContext } from "./context.ts";

/**
 * Control's metrics, and the agents' model usage and the models' prices: the reader's token reads
 * them, the owner's sets a price.
 */
export function usageRoutes(app: Hono, api: ApiContext): void {
  const { store, opts, parts, admin, reader } = api;

  // Health's series follow control's own (goal 173), then, with the message bus, the bus's.
  app.get("/metrics", reader, async (c) =>
    c.text(
      metricsText(store, opts.staleAfterMs) +
        healthMetricsText(store, parts.loops, opts.staleAfterMs) +
        (await busMetricsText(store, parts.bus)),
      200,
      { "content-type": "text/plain; version=0.0.4" },
    ),
  );

  // The agents' model usage (goal 075): a run's, a campaign's or the whole system's, for a period.
  app.get("/v1/usage", reader, (c) => {
    const q = Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== ""));
    const refused = usageQueryRefusal(q);
    if (refused) return c.json({ error: refused }, 400);
    return c.json(modelUsage(store, q));
  });

  // The models' prices that model usage costs calls at (goal 075): the providers' listed ones and
  // the owner's. The owner sets or clears a price for a model whose list gives none.
  app.get("/v1/model-prices", reader, (c) => c.json({ prices: modelPrices(store) }));
  app.post("/v1/model-prices", admin, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const out = setModelPrice(store, await jsonBody(c.req), "owner:api");
    return out.ok ? c.json(out.answer) : c.json({ error: out.error }, out.status);
  });
}
