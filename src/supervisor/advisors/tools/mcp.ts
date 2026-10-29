import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Context, Hono } from "hono";
import {
  KB_SERVER,
  KB_TOOLS,
  type KbCall,
  KbReadArgs,
  KbSearchArgs,
  KbWriteArgs,
  kbTools,
} from "../../../agents/tools/index.ts";
import { type AdvisorCode, CODE_TOOL_NAMES, registerCodeTools } from "./code.ts";
import { type AdvisorPaper, PAPER_TOOL_NAMES, registerPaperTools } from "./paper.ts";
import { type AdvisorResearch, RESEARCH_TOOL_NAMES, registerResearchTools } from "./research.ts";

/**
 * Thermite's own tools for an advisor in Claude Code, OpenCode or the Codex CLI (goals 065, 073
 * and 175). Each runs with none of its own tools (the supervisor holds git and model credentials),
 * so the supervisor serves them over MCP: on localhost, for the length of one call, behind a token
 * made for that call, as the server KB_SERVER. Claude Code is given those servers alone
 * (`--strict-mcp-config`) and only their tools; OpenCode and Codex get them in their configuration
 * for the call (advisors/cli.ts), with the token in their environment.
 */

/** The server's name in each program's MCP configuration. */
export const PAST_MCP_SERVER = KB_SERVER;

/**
 * Thermite's knowledge base for an advisor's call (goal 175): the kinds its slot may write, and its
 * tools, run by the supervisor for that slot (kb_search and kb_read asked of control, kb_write
 * recorded by the harness).
 */
export interface AdvisorKb {
  writes: string[];
  call: KbCall;
}

/** Each tool's arguments, as the MCP server lists and checks them. */
const KB_SHAPES = {
  [KB_TOOLS.search]: KbSearchArgs.shape,
  [KB_TOOLS.read]: KbReadArgs.shape,
  [KB_TOOLS.write]: KbWriteArgs.shape,
} as const;

export interface PastSearchServer {
  /** The MCP address (no token in it). */
  url: string;
  /** Claude Code's flags: the server, and permission for its one tool. */
  args: string[];
  /**
   * Each server as another CLI's configuration names it (goal 073: OpenCode and Codex): its name
   * and its address, no token in it. The past-research search is PAST_MCP_SERVER.
   */
  servers: { name: string; url: string }[];
  /** The bearer token the servers take, made for this call alone. */
  token: string;
  close(): Promise<void>;
}

/**
 * An advisor's MCP servers for one call of Claude Code (goal 068): each server the run's kit
 * gives the advisors, as the supervisor serves it on localhost (each call goes through the
 * supervisor, which holds the sign-in), and the past-research search when there is one.
 */
export interface AdvisorServers {
  servers: string[];
  serverFor(server: string): Server;
}

/**
 * Starts the advisor's local MCP servers on a free port: the past-research search, the
 * teachers' code and evidence reads (goal 081) and their reads of the run's own research (goal
 * 098) at /mcp, the server named PAST_MCP_SERVER, and each MCP server the advisor gets at
 * /mcp/<name>. Claude Code is given them alone, and permission for their tools only. Close it
 * when the call ends.
 */
export async function serveAdvisorTools(o: {
  /** Thermite's knowledge base's tools (goal 175), on the same server. */
  kb?: AdvisorKb | undefined;
  mcp?: AdvisorServers | undefined;
  /** The teachers' read-only tools for the run's code and evidence (goal 081), on the same server. */
  code?: AdvisorCode | undefined;
  /** The teachers' read-only tools for the run's own research (goal 098), on the same server. */
  research?: AdvisorResearch | undefined;
  /** The final writer's checks of its paper (goal 112), on the same server. */
  paper?: AdvisorPaper | undefined;
}): Promise<PastSearchServer> {
  const token = randomBytes(24).toString("hex");
  const kb = o.kb;
  const code = o.code;
  const research = o.research;
  const paper = o.paper;
  const build = () => {
    const server = new McpServer({ name: "thermite-past-research", version: "1.0.0" });
    if (code) registerCodeTools(server, code);
    if (research) registerResearchTools(server, research);
    if (paper) registerPaperTools(server, paper);
    if (kb)
      for (const t of kbTools(kb.writes))
        server.registerTool(
          t.name,
          {
            description: t.description,
            inputSchema: KB_SHAPES[t.name as keyof typeof KB_SHAPES],
            annotations: { readOnlyHint: t.reads },
          },
          async (a: Record<string, unknown>) => {
            const r = await kb.call(t.name, a);
            return {
              content: [{ type: "text" as const, text: r.text }],
              ...(r.isError ? { isError: true } : {}),
            };
          },
        );
    return server;
  };
  const app = new Hono();
  const serving = (make: () => McpServer | Server) => async (c: Context) => {
    if (c.req.header("authorization") !== `Bearer ${token}`)
      return c.json({ error: "unauthorized" }, 401);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await make().connect(transport);
    return transport.handleRequest(c.req.raw);
  };
  const thermite = Boolean(kb || code || research || paper);
  if (thermite) app.all("/mcp", serving(build));
  const mcp = o.mcp;
  if (mcp)
    app.all("/mcp/:server", async (c) => {
      const name = c.req.param("server");
      if (!mcp.servers.includes(name)) return c.json({ error: "not found" }, 404);
      return serving(() => mcp.serverFor(name))(c);
    });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const headers = { Authorization: `Bearer ${token}` };
  const servers = [
    ...(thermite ? [{ name: PAST_MCP_SERVER, url }] : []),
    ...(mcp?.servers ?? []).map((s) => ({ name: s, url: `${url}/${encodeURIComponent(s)}` })),
  ];
  const config = {
    mcpServers: Object.fromEntries(
      servers.map((s) => [s.name, { type: "http", url: s.url, headers }]),
    ),
  };
  return {
    url,
    servers,
    token,
    args: [
      "--mcp-config",
      JSON.stringify(config),
      "--allowedTools",
      ...(kb ? kbTools(kb.writes).map((t) => `mcp__${PAST_MCP_SERVER}__${t.name}`) : []),
      ...(code ? CODE_TOOL_NAMES.map((n) => `mcp__${PAST_MCP_SERVER}__${n}`) : []),
      ...(research ? RESEARCH_TOOL_NAMES.map((n) => `mcp__${PAST_MCP_SERVER}__${n}`) : []),
      ...(paper ? PAPER_TOOL_NAMES.map((n) => `mcp__${PAST_MCP_SERVER}__${n}`) : []),
      // A server's name allows each of its tools.
      ...(mcp?.servers ?? []).map((s) => `mcp__${s}`),
    ],
    close: () =>
      new Promise<void>((r) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
