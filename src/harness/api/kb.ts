import type { Hono } from "hono";
import {
  KB_ANSWERS,
  KB_ASKS,
  KB_ASKS_WAIT_MAX_S,
  KB_WRITE,
  KB_WRITES,
} from "../../core/api/harness/supervisor.ts";
import { type ApiContext, limitOf } from "./context.ts";

/**
 * The knowledge base's channel between the harness and its supervisor (goal 175): the supervisor
 * takes the agents' searches and reads that wait (held open until one comes), hands back control's
 * answers, and records an advisor's kb_write in the advisor's slot. The agents' own calls come
 * through the MCP gateway (api/mcp.ts).
 */
export function kbRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  app.get(KB_ASKS.path, supervisor, async (c) => {
    const wait = Number(c.req.query("wait") ?? "0");
    if (!Number.isFinite(wait) || wait < 0)
      return c.json({ error: "wait is a number of seconds from 0" }, 400);
    const asks = await service.kbAsks.take(Math.min(wait, KB_ASKS_WAIT_MAX_S) * 1000);
    return c.json({ asks });
  });
  app.post(KB_ANSWERS.path, supervisor, limitOf(KB_ANSWERS), async (c) => {
    const body = KB_ANSWERS.body.parse(await c.req.json());
    let taken = 0;
    for (const a of body.answers) if (service.kbAsks.answer(a.id, a.answer)) taken++;
    return c.json({ taken });
  });
  app.get(KB_WRITES.path, supervisor, (c) =>
    c.json({ kinds: service.kbTools.writes(c.req.query("run") ?? "", c.req.query("slot") ?? "") }),
  );
  app.post(KB_WRITE.path, supervisor, limitOf(KB_WRITE), async (c) => {
    const b = KB_WRITE.body.parse(await c.req.json());
    return c.json(await service.kbTools.call({ run: b.run, slot: b.slot }, "kb_write", b.args));
  });
}
