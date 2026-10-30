import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { buildInfo } from "../../common/build-info.ts";
import { redact } from "../../common/env.ts";
import type { ControlStore } from "../store/index.ts";
import { registerAgentReads } from "./agents.ts";
import { registerCampaignSettings, registerRunStarts } from "./campaigns.ts";
import {
  registerAddClusterRig,
  registerClusterRigs,
  registerReachableAddresses,
} from "./clusters.ts";
import { registerCommands } from "./commands.ts";
import { type McpOptions, type Role, toolContext } from "./context.ts";
import { registerControl, registerModelPrice } from "./control.ts";
import { registerKnowledgeBase } from "./kb.ts";
import { registerKits } from "./kits.ts";
import { registerReads } from "./reads.ts";
import { registerRigModels } from "./rig-models.ts";
import { registerRigReads } from "./rig-reads.ts";
import { registerRetire, registerRigSettings } from "./rigs.ts";
import { registerRunpod } from "./runpod.ts";
import { registerMcpServers } from "./servers.ts";

export type { McpOptions } from "./context.ts";

/**
 * Control over MCP (streamable HTTP at /mcp, stateless). The admin token may read and issue
 * commands; a read token (optional) may only read. Every call is written to the audit log.
 * The same views and the same signed-command path as the dashboard and the REST API.
 *
 * Each group of tools is a module in mcp/ that registers them on the server, with what it takes
 * from the context built once for the request (mcp/context.ts: the caller's role, the kinds of
 * command it may issue, the audit of every call). They are registered in this order, the order of
 * the list an MCP client sees, and each module says which tokens get its tools.
 */
function buildServer(store: ControlStore, opts: McpOptions, actor: string, role: Role): McpServer {
  const server = new McpServer({
    name: "thermite-control",
    version: (opts.control ?? buildInfo()).version,
  });
  const tools = toolContext(server, store, opts, actor, role);
  const { audited, canCommand } = tools;

  registerReads(tools);
  registerCommands(tools);
  registerKnowledgeBase(tools);

  // Control itself, for whoever runs it (not the agents of a campaign): its log and its providers.
  if (role !== "agent") {
    registerRigReads(server, audited, store, opts.runpodRigs, role !== "reader");
    // The agents' roles and a run's prompts (goal 166): the owner's and an operator's.
    registerAgentReads(tools);
    registerControl(tools);
    registerAddClusterRig(tools);
    // Each agent's model, as Edit rig's section "2 · The agents" (goal 029): read by every
    // token but the agent's, as Providers is; set by the owner's and an operator's.
    registerRigModels(server, audited, store, actor, canCommand);
    registerRigSettings(tools);
    registerModelPrice(tools);
    registerRunStarts(tools);
    registerKits(tools);
    registerCampaignSettings(tools);
    registerClusterRigs(tools);
    registerReachableAddresses(tools);
    registerMcpServers(tools);
    registerRetire(tools);
    registerRunpod(tools);
  }

  return server;
}

/**
 * The largest MCP request control reads, in bytes: room for a kit's bundle in base64
 * (MCP_KIT_BASE64_MAX) or a command's payload (COMMAND_MAX_BYTES), with the rest of the call. A
 * larger one is answered 413.
 */
export const MCP_BODY_MAX = 4 * 1024 * 1024;

export function mountMcp(app: Hono, store: ControlStore, opts: McpOptions): void {
  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const role: Role | undefined = opts.admin.matches(token)
      ? "owner"
      : opts.operator?.matches(token)
        ? "operator"
        : opts.agent?.matches(token)
          ? "agent"
          : opts.read?.matches(token)
            ? "reader"
            : undefined;
    if (!role) return c.json({ error: "unauthorized" }, 401);
    // Stateless: a fresh server and transport per request. The actor is what commands record as
    // their issuer, and only "owner:" issuers pass the harness's owner-only gates: an operator
    // acts for the owner (its kinds are limited above), an agent does not.
    const actor = {
      owner: "owner:mcp",
      operator: "owner:operator",
      agent: "agent:mcp",
      reader: "reader:mcp",
    }[role];
    const server = buildServer(store, { ...opts, requestUrl: c.req.url }, actor, role);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MCP_BODY_MAX,
    });
    await server.connect(transport);
    const answer = await transport.handleRequest(c.req.raw);
    await auditRefusedCalls(store, actor, answer.clone());
    return answer;
  });
}

/**
 * The calls the MCP SDK refused before a tool ran, in the audit log as refused, as the tools' own
 * refusals are: a tool the caller's token does not have, or inputs that don't match the tool. The
 * SDK answers each as a tool error whose text starts with `MCP error` and names the tool.
 */
async function auditRefusedCalls(store: ControlStore, actor: string, answer: Response) {
  if (!answer.headers.get("content-type")?.startsWith("application/json")) return;
  const body: unknown = await answer.json().catch(() => undefined);
  for (const m of Array.isArray(body) ? body : [body]) {
    const r = (m as { result?: { isError?: boolean; content?: { text?: unknown }[] } } | null)
      ?.result;
    const text = r?.isError ? r.content?.[0]?.text : undefined;
    if (typeof text !== "string" || !text.startsWith("MCP error ")) continue;
    const tool = /\btool (\S+?)(?=:| not found| disabled)/i.exec(text)?.[1] ?? "unknown";
    store.auditLog.refusal(actor, "refused", { tool: `mcp:${tool}`, why: redact(text) });
  }
}
