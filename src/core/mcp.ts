import { z } from "zod";

/**
 * MCP servers for a campaign's agents (goal 068). The owner adds a server once, in Settings, with
 * its sign-in; a campaign's kit (kit.json, or a research contract, which has no kit) names the
 * servers its agents use and which kinds of agent get each one. A kit may narrow a server to some
 * of its tools for a kind of agent. The judge never uses them. The secrets stay where no agent
 * can read them: control keeps them sealed, and the rig's harness (workers and the planner) or
 * supervisor (the advisors) makes the calls.
 */

/** A server's name in Settings, and how a kit names it: lowercase letters, digits and dashes. */
export const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * The name of Thermite's own MCP server, which gives every agent the knowledge base's tools (goal
 * 175) beside the kit's servers: no kit may name a server so.
 */
export const OWN_MCP_SERVER = "thermite";

/** An MCP tool's name (the protocol allows letters, digits and a few marks). */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_./-]{1,128}$/;

/** The kinds of agent a kit gives a server to. The judge is code, and never gets one. */
export const AGENT_KINDS = ["workers", "planner", "advisors"] as const;
export const AgentKind = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKind>;

const ToolNames = z
  .array(z.string().regex(MCP_TOOL_NAME, "an MCP tool's name"))
  .min(1, "a kind of agent with no tools: take it out of agents")
  .max(500)
  .refine((t) => new Set(t).size === t.length, "a tool is named twice");

/**
 * One server a kit names: which kinds of agent get it and, only when narrowed, the tools each
 * kind may call. A kind left out of `tools` gets every tool the server lists.
 */
export const McpUse = z
  .strictObject({
    name: z
      .string()
      .regex(MCP_SERVER_NAME, "a server's name: lowercase letters, digits, dashes")
      .refine(
        (n) => n !== OWN_MCP_SERVER,
        `${OWN_MCP_SERVER} is the name of Thermite's own tools: give the server another name`,
      ),
    agents: z
      .array(AgentKind)
      .min(1, "give the server to at least one kind of agent")
      .refine((a) => new Set(a).size === a.length, "a kind of agent is named twice"),
    tools: z
      .strictObject({
        workers: ToolNames.optional(),
        planner: ToolNames.optional(),
        advisors: ToolNames.optional(),
      })
      .optional(),
  })
  .superRefine((u, ctx) => {
    for (const k of AGENT_KINDS)
      if (u.tools?.[k] && !u.agents.includes(k))
        ctx.addIssue({
          code: "custom",
          path: ["tools", k],
          message: `the ${k} do not get this server: add ${k} to agents, or take out its tools`,
        });
  });
export type McpUse = z.infer<typeof McpUse>;

/** The servers a kit names, each once. */
export const McpUses = z
  .array(McpUse)
  .max(20)
  .refine((l) => new Set(l.map((u) => u.name)).size === l.length, "a server is named twice");
export type McpUses = z.infer<typeof McpUses>;

/** The servers that give tools to one kind of agent, each with the tools it may call (undefined: all). */
export function usesFor(
  uses: readonly McpUse[] | undefined,
  kind: AgentKind,
): { name: string; tools: string[] | undefined }[] {
  return (uses ?? [])
    .filter((u) => u.agents.includes(kind))
    .map((u) => ({ name: u.name, tools: u.tools?.[kind] }));
}

/** A list in one order, for comparing what a kit names with what a command says. */
export function canonicalUses(uses: readonly McpUse[] | undefined): McpUse[] {
  return [...(uses ?? [])]
    .map((u) => {
      const tools = u.tools
        ? Object.fromEntries(
            AGENT_KINDS.filter((k) => u.tools?.[k]).map((k) => [
              k,
              [...(u.tools?.[k] ?? [])].sort(),
            ]),
          )
        : undefined;
      return {
        name: u.name,
        agents: AGENT_KINDS.filter((k) => u.agents.includes(k)),
        ...(tools && Object.keys(tools).length ? { tools } : {}),
      } as McpUse;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Whether two lists name the same servers, for the same agents and tools. */
export const sameUses = (a: readonly McpUse[] | undefined, b: readonly McpUse[] | undefined) =>
  JSON.stringify(canonicalUses(a)) === JSON.stringify(canonicalUses(b));

/** A list in words, for a refusal: "gbrain (workers, planner)". */
export const usesWords = (uses: readonly McpUse[] | undefined) =>
  canonicalUses(uses)
    .map(
      (u) =>
        `${u.name} (${u.agents
          .map((k) => (u.tools?.[k] ? `${k}: ${u.tools[k]?.join(", ")}` : k))
          .join("; ")})`,
    )
    .join(", ") || "none";

/**
 * A server as a rig receives it from control: where it is, the headers its calls carry (the
 * sign-in, kept in memory only) and a revision that changes when any of it does.
 */
export const McpConnection = z.strictObject({
  name: z.string().regex(MCP_SERVER_NAME),
  url: z.url(),
  headers: z.record(z.string().min(1).max(200), z.string().max(16_384)),
  revision: z.string().min(1).max(64),
  /** The kinds of agent any run on the rig gives it to (the supervisor hands each its share). */
  agents: z.array(AgentKind).default([]),
});
export type McpConnection = z.infer<typeof McpConnection>;

/** A server a run names that the rig did not get, and why (a sign-in that ended, a deleted server). */
export const McpUnavailable = z.strictObject({
  name: z.string().regex(MCP_SERVER_NAME),
  why: z.string().max(500),
});
export type McpUnavailable = z.infer<typeof McpUnavailable>;

/** An MCP tool as an agent sees it: its server, its name, what it does and what it takes. */
export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** True when the server says the tool only reads (its readOnlyHint). */
  reads: boolean;
}

/**
 * A tool's name as one agent tool, unique among the tools given: mcp__<server>__<tool>, with any
 * character a model API refuses made an underscore, at most 64 characters.
 */
export function agentToolName(server: string, tool: string, taken: Set<string>): string {
  const base = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 60)}_${n}`;
  taken.add(name);
  return name;
}
