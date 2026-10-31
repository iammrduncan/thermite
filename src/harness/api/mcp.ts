import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { McpCaller } from "../../agents/mcp/index.ts";
import { KB_SERVER, kbServer } from "../../agents/tools/index.ts";
import { workerSlot } from "../../core/kb.ts";
import type { KbCaller } from "../kb/index.ts";
import { type ApiContext, Unauthorized } from "./context.ts";

/**
 * The MCP gateway, through which the workers and the planner call their run's MCP servers, and
 * Thermite's own server (KB_SERVER), whose tools are the knowledge base's (goal 175).
 */
export function mcpRoutes(app: Hono, { service, trialOf }: ApiContext): void {
  // The MCP gateway for workers (their trial's token) and the planner (a credential the harness
  // made for one plan, or bound to its call in its own terminal): the tools their run's kit gives their kind of agent, never a secret.
  // The caller's slot in the knowledge base comes from the trial (its lane) or the plan.
  const callers = (header: string | undefined): { mcp: McpCaller; kb: KbCaller } => {
    const h = header ?? "";
    const given = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (given.startsWith("trial.")) {
      const t = trialOf(h).trial;
      return {
        mcp: { run: t.run, kind: "workers", source: `trial:${t.id}` },
        kb: { run: t.run, slot: workerSlot(t.lane) },
      };
    }
    // A credential made for a plan, or one bound to a call in its own terminal (goal 169).
    const caller = given.startsWith("mcp.")
      ? service.mcpTokenCaller(given)
      : given.startsWith("call.")
        ? service.callOf(given)?.caller
        : undefined;
    if (!caller) throw new Unauthorized("unauthorized");
    // A credential made for a plan is the planner's; one for another caller writes nothing.
    return {
      mcp: caller,
      kb: { run: caller.run, slot: caller.kind === "planner" ? "planner" : "" },
    };
  };
  // `?fresh=all` (or a server's name): the servers are asked now, not the list kept for a few
  // minutes (the owner's /mcp reconnect in a Pi worker's view, goal 169).
  app.get("/v1/mcp-tools", async (c) => {
    const fresh = c.req.query("fresh");
    const caller = callers(c.req.header("authorization")).mcp;
    return c.json(await service.mcp.tools(caller, fresh === "all" ? true : (fresh ?? false)));
  });
  app.post("/v1/mcp-call", bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const caller = callers(c.req.header("authorization"));
    const b = z
      .strictObject({
        server: z.string().min(1).max(64),
        tool: z.string().min(1).max(128),
        arguments: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(await c.req.json());
    if (b.server === KB_SERVER) {
      const r = await service.kbTools.call(caller.kb, b.tool, b.arguments);
      return c.json({
        content: [{ type: "text", text: r.text }],
        ...(r.isError ? { isError: true } : {}),
      });
    }
    return c.json(await service.mcp.call(caller.mcp, b.server, b.tool, b.arguments));
  });
  // One server as an MCP endpoint (streamable HTTP, stateless), for OpenCode, Claude Code and
  // Codex: the kit's servers, and Thermite's own.
  app.all("/v1/mcp/:server", bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const caller = callers(c.req.header("authorization"));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const name = c.req.param("server");
    const kb = service.kbTools;
    const server =
      name === KB_SERVER
        ? kbServer(kb.callFor(caller.kb), kb.writes(caller.kb.run, caller.kb.slot))
        : service.mcp.serverFor(caller.mcp, name);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
