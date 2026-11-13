import type { Hono } from "hono";
import { BadInput, Refusal } from "../../common/errors.ts";
import { BUS, BUS_MESSAGE, BUS_MESSAGES, SYSTEM } from "../../core/api/control/bus.ts";
import { busState } from "../bus/index.ts";
import {
  asText,
  SYSTEM_PARTS,
  type SystemPart,
  streamMessage,
  streamPage,
  streamReader,
} from "../system/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * The message bus's state (goal 168): its server, the streams control makes with what each
 * consumer has still to take, and the live stream's figures. The reader's token reads it, as it
 * reads /metrics; `thermite bus` prints it. With the bus off, it says so.
 *
 * The whole system's figures (goal 179), which Metrics shows: the reader's token reads them too.
 * A stream's messages, a page at a time, and one message whole: the owner's token only.
 */
export function busRoutes(app: Hono, api: ApiContext): void {
  const { store, parts, reader, admin } = api;
  app.get(BUS.path, reader, async (c) => c.json(await busState(store, parts.bus)));

  app.get(SYSTEM.path, reader, async (c) => {
    const asked = (c.req.query("part") ?? "").split(",").filter(Boolean);
    const unknown = asked.filter((p) => !(SYSTEM_PARTS as readonly string[]).includes(p));
    if (unknown.length)
      throw new BadInput(
        `part is refused: it is one or more of ${SYSTEM_PARTS.join(", ")}, by commas`,
      );
    const out: Record<string, unknown> = {};
    for (const p of (asked.length ? asked : SYSTEM_PARTS) as SystemPart[])
      out[p] = await parts.system.part(p, async () => parts.views());
    return c.json(out);
  });

  const place = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0)
      throw new BadInput(`${name} is refused: a place is 0 or more`);
    return n;
  };
  const busOf = () => {
    const bus = streamReader(parts.bus);
    if (!bus) throw new Refusal("control has no message bus to read");
    return bus;
  };

  app.get(BUS_MESSAGES.path, admin, async (c) =>
    c.json(
      await streamPage(busOf(), c.req.param("stream"), {
        subject: c.req.query("subject"),
        before: place(c.req.query("before"), "before"),
        after: place(c.req.query("after"), "after"),
      }),
    ),
  );

  app.get(BUS_MESSAGE.path, admin, async (c) => {
    const m = await streamMessage(busOf(), c.req.param("stream"), Number(c.req.param("seq")));
    if (!m) return c.json({ error: "the stream has no message at that place" }, 404);
    const { data, ...row } = m;
    const text = asText(data);
    return c.json({
      ...row,
      text,
      base64: text === null ? Buffer.from(data).toString("base64") : null,
    });
  });
}
