import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  cleanMcpError,
  headerSecrets,
  type McpCallResult,
  type McpConnect,
  type McpListedTool,
  type McpSession,
  mcpConnect,
} from "../../common/mcp-client.ts";
import type { EventBodies } from "../../core/events/bodies.ts";
import type {
  AgentKind,
  McpConnection,
  McpToolInfo,
  McpUnavailable,
  McpUse,
} from "../../core/mcp.ts";

/**
 * The harness's MCP gateway (goal 068): workers and the planner call the MCP servers their run's
 * kit names through here, as they reach the model through the model proxy. The rig's supervisor
 * hands the harness the servers control gave the rig, with their sign-in as headers, kept in
 * memory only: no lane can read them, and no answer carries them. Each caller gets only the
 * servers its run's kit gives its kind of agent, and only the tools the kit gives it there.
 *
 * A server that fails never stops a run: the agents get a tool error that says so and go on, and
 * the run's history records the failure once (`mcp_server_failed`), and the return
 * (`mcp_server_back`).
 */

/** Who is calling: a run, its kind of agent, and its line in the live view. */
export interface McpCaller {
  run: string;
  kind: AgentKind;
  /** The live view's source: the trial's (`trial:<id>`) or the planner's. */
  source: string;
}

/** How long a server's tool list is kept before it is read again. */
const LIST_MS = 5 * 60_000;

/** Why a server the run names can't be called, when control has said nothing of it yet. */
export const NOT_HANDED = "control has not given it to this rig yet";

/** A verb for a kind of agent: the planner is one ("goes"), the workers and advisors many ("go"). */
const verb = (kind: AgentKind, one: string, many: string) => (kind === "planner" ? one : many);

export interface McpGatewayDeps {
  /** The run's servers: what its kit names, from the run's signed assignment. */
  uses(run: string): McpUse[];
  /** One event in the run's history (mcp_server_failed or mcp_server_back). */
  record<K extends "mcp_server_failed" | "mcp_server_back">(
    run: string,
    kind: K,
    body: EventBodies[K],
  ): void;
  /** One line in the live view. */
  say?: ((source: string, run: string, text: string) => void) | undefined;
  connect?: McpConnect | undefined;
}

export class McpGateway {
  private conns = new Map<string, McpConnection>();
  private missing = new Map<string, string>();
  private lists = new Map<string, { revision: string; at: number; tools: McpListedTool[] }>();
  /** Failures recorded and not yet over, by run, server and kind of agent. */
  private failing = new Map<string, string>();
  private readonly deps: McpGatewayDeps;
  private readonly connect: McpConnect;

  constructor(deps: McpGatewayDeps) {
    this.deps = deps;
    this.connect = deps.connect ?? mcpConnect(undefined, "thermite-harness");
  }

  /** The servers control gave the rig, as the supervisor hands them (they replace the last). */
  set(servers: McpConnection[], unavailable: McpUnavailable[]): void {
    this.conns = new Map(servers.map((s) => [s.name, s]));
    this.missing = new Map(unavailable.map((u) => [u.name, u.why]));
    for (const [name, l] of this.lists)
      if (this.conns.get(name)?.revision !== l.revision) this.lists.delete(name);
  }

  /** What the harness holds, without a secret: each server's revision, and those it lacks. */
  info(): { servers: { name: string; revision: string }[]; unavailable: McpUnavailable[] } {
    return {
      servers: [...this.conns.values()].map((s) => ({ name: s.name, revision: s.revision })),
      unavailable: [...this.missing].map(([name, why]) => ({ name, why })),
    };
  }

  /** The servers one kind of agent of a run gets, by name, each with the tools it may call. */
  given(run: string, kind: AgentKind): { name: string; tools: string[] | undefined }[] {
    return this.deps
      .uses(run)
      .filter((u) => u.agents.includes(kind))
      .map((u) => ({ name: u.name, tools: u.tools?.[kind] }));
  }

  /**
   * The servers a run's workers or planner get that the rig does not hold now, by name: each with
   * control's reason when control said it can't give it, else none (not handed over yet).
   */
  lacking(run: string): { name: string; why?: string }[] {
    const names = new Set(
      this.deps
        .uses(run)
        .filter((u) => u.agents.includes("workers") || u.agents.includes("planner"))
        .map((u) => u.name),
    );
    return [...names]
      .sort()
      .filter((name) => !this.conns.has(name))
      .map((name) => {
        const why = this.missing.get(name);
        return why === undefined ? { name } : { name, why };
      });
  }

  private key = (c: McpCaller, server: string) => `${c.run}\0${server}\0${c.kind}`;

  /**
   * A failure, recorded once until the server works again; the agents go on without it. `say`:
   * a line in Live too (the supervisor says its own).
   */
  private failed(c: McpCaller, server: string, why: string, say = true): void {
    const k = this.key(c, server);
    if (this.failing.get(k) === why) return;
    const first = !this.failing.has(k);
    this.failing.set(k, why);
    if (!first) return;
    this.deps.record(c.run, "mcp_server_failed", { server, agents: c.kind, error: why });
    if (say)
      this.deps.say?.(
        c.source,
        c.run,
        `the MCP server ${server} failed: ${why}. The ${c.kind} ${verb(c.kind, "goes", "go")} on without it.`,
      );
  }

  private worked(c: McpCaller, server: string, say = true): void {
    const k = this.key(c, server);
    if (!this.failing.delete(k)) return;
    this.deps.record(c.run, "mcp_server_back", { server, agents: c.kind });
    if (say) this.deps.say?.(c.source, c.run, `the MCP server ${server} works again.`);
  }

  /**
   * A failure or a return the supervisor saw for the advisors, whose calls it makes: recorded in
   * the run's history as the gateway records its own. The supervisor's own gateway has said it
   * in Live already, so it is not said twice.
   */
  report(c: McpCaller, server: string, ok: boolean, why = "it failed"): void {
    if (ok) this.worked(c, server, false);
    else this.failed(c, server, why, false);
  }

  /** Why a server can't be called now: not handed to the rig, or none of that name. */
  private reachable(server: string): McpConnection | string {
    const conn = this.conns.get(server);
    if (conn) return conn;
    return this.missing.get(server) ?? NOT_HANDED;
  }

  private async session<T>(conn: McpConnection, use: (s: McpSession) => Promise<T>): Promise<T> {
    const s = await this.connect(conn.url, conn.headers);
    try {
      return await use(s);
    } finally {
      await s.close().catch(() => {});
    }
  }

  /**
   * A server's tools as it lists them (kept for a few minutes), or why not. `fresh`: asked of the
   * server now, whatever is kept (the owner's /mcp reconnect in the Pi view, goal 169).
   */
  private async listed(
    c: McpCaller,
    server: string,
    fresh = false,
  ): Promise<McpListedTool[] | string> {
    const conn = this.reachable(server);
    if (typeof conn === "string") {
      this.failed(c, server, conn);
      return conn;
    }
    const kept = this.lists.get(server);
    if (!fresh && kept && kept.revision === conn.revision && Date.now() - kept.at < LIST_MS)
      return kept.tools;
    try {
      const tools = await this.session(conn, (s) => s.listTools());
      this.lists.set(server, { revision: conn.revision, at: Date.now(), tools });
      this.worked(c, server);
      return tools;
    } catch (err) {
      const why = cleanMcpError(err, headerSecrets(conn.headers));
      this.failed(c, server, why);
      return kept?.revision === conn.revision ? kept.tools : why;
    }
  }

  /** One server's tools that this caller may use (none when it fails); `fresh`: listed now. */
  async serverTools(
    c: McpCaller,
    server: string,
    fresh = false,
  ): Promise<McpListedTool[] | string> {
    const g = this.given(c.run, c.kind).find((x) => x.name === server);
    if (!g) return `the ${c.kind} of this run ${verb(c.kind, "does", "do")} not get ${server}`;
    const tools = await this.listed(c, server, fresh);
    if (typeof tools === "string") return tools;
    return g.tools ? tools.filter((t) => g.tools?.includes(t.name)) : tools;
  }

  /**
   * Every tool this caller may use, with the servers that failed and why. `fresh`: the servers are
   * asked now, whatever was kept: `true` every one, or one by its name.
   */
  async tools(
    c: McpCaller,
    fresh: boolean | string = false,
  ): Promise<{ tools: McpToolInfo[]; unavailable: { server: string; why: string }[] }> {
    const tools: McpToolInfo[] = [];
    const unavailable: { server: string; why: string }[] = [];
    for (const g of this.given(c.run, c.kind)) {
      const listed = await this.serverTools(c, g.name, fresh === true || fresh === g.name);
      if (typeof listed === "string") {
        unavailable.push({ server: g.name, why: listed });
        continue;
      }
      for (const t of listed)
        tools.push({
          server: g.name,
          name: t.name,
          description: (t.description ?? t.title ?? "").slice(0, 4000),
          input_schema:
            t.inputSchema && t.inputSchema.type === "object"
              ? t.inputSchema
              : { type: "object", properties: {} },
          reads: t.annotations?.readOnlyHint === true,
        });
    }
    return { tools, unavailable };
  }

  /**
   * One tool call for this caller: only a server its kind gets, and only a tool it was given
   * there. A failure is a tool error in words (never a secret), and the run goes on.
   */
  async call(
    c: McpCaller,
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const err = (text: string): McpCallResult => ({
      content: [{ type: "text", text }],
      isError: true,
    });
    const g = this.given(c.run, c.kind).find((x) => x.name === server);
    if (!g)
      return err(
        `The ${c.kind} of this run ${verb(c.kind, "does", "do")} not get the MCP server ${server}.`,
      );
    if (g.tools && !g.tools.includes(tool))
      return err(`The campaign's kit does not give the ${c.kind} the tool ${tool} of ${server}.`);
    const conn = this.reachable(server);
    if (typeof conn === "string") {
      this.failed(c, server, conn);
      return err(`The MCP server ${server} can't be used now: ${conn}. Go on without it.`);
    }
    try {
      const r = await this.session(conn, (s) => s.callTool(tool, args));
      this.worked(c, server);
      return r;
    } catch (e) {
      const why = cleanMcpError(e, headerSecrets(conn.headers));
      this.failed(c, server, why);
      return err(`The MCP server ${server} failed: ${why}. Go on without it.`);
    }
  }

  /**
   * An MCP server that serves one server's tools to one caller, for OpenCode and Claude Code:
   * its list is the tools the caller may use, and each call goes through call().
   */
  serverFor(c: McpCaller, server: string): Server {
    const s = new Server(
      { name: `thermite-${server}`, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    s.setRequestHandler(ListToolsRequestSchema, async () => {
      const listed = await this.serverTools(c, server);
      return {
        tools: (typeof listed === "string" ? [] : listed).map((t) => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description ?? "",
          inputSchema:
            t.inputSchema && t.inputSchema.type === "object"
              ? (t.inputSchema as { type: "object" })
              : { type: "object" as const, properties: {} },
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      };
    });
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const r = await this.call(c, server, req.params.name, req.params.arguments ?? {});
      return {
        content: Array.isArray(r.content) ? r.content : [],
        ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
        ...(r.isError ? { isError: true } : {}),
      } as never;
    });
    return s;
  }
}
