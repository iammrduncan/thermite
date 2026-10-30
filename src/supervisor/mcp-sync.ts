import { ApiError } from "../common/api/call.ts";
import { harnessClient } from "../common/api/harness.ts";
import { log } from "../common/env.ts";
import { MCP_SERVERS_GET, MCP_SERVERS_PUT } from "../core/api/harness/supervisor.ts";
import type { McpServersValue } from "../core/link/config.ts";

/**
 * The MCP servers control gives the rig (goal 068): those the kits of the runs it assigned the
 * rig name, each with its sign-in as headers, in the rig's config on the message bus (config/).
 * The supervisor hands the harness the servers its workers and planner use (the harness makes
 * their calls), and keeps the advisors' in memory for the calls it makes for them. Nothing here
 * writes a secret to disk or a log.
 */

export interface McpHand {
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
}

export type McpFromControl = McpServersValue;

/** A call's answer, or undefined when the route answers 404: a harness with no agents. */
async function unlessMissing<T>(call: Promise<T>): Promise<T | undefined> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") return undefined;
    throw err;
  }
}

/**
 * Hands the harness its share of the servers control gave when it differs from what the harness
 * holds. Returns what control gave, all of it: the advisors' share stays with the supervisor.
 */
export async function handMcpServers(
  s: McpHand,
  given: McpFromControl,
): Promise<McpFromControl & { handed: "unchanged" | "set" | "no_agents" }> {
  const harness = harnessClient({
    url: s.harnessUrl,
    token: s.harnessToken,
    fetchImpl: s.fetchImpl,
  });
  // The harness gets only the servers its agents use: workers and the planner.
  const share = given.servers.filter((c) =>
    c.agents.some((a) => a === "workers" || a === "planner"),
  );
  const had = await unlessMissing(harness.call(MCP_SERVERS_GET));
  if (!had) return { ...given, handed: "no_agents" };
  const key = (x: {
    servers: { name: string; revision: string }[];
    unavailable: { name: string; why: string }[];
  }) =>
    JSON.stringify([
      x.servers.map((c) => `${c.name}@${c.revision}`).sort(),
      x.unavailable.map((u) => `${u.name}:${u.why}`).sort(),
    ]);
  if (key(had) === key({ servers: share, unavailable: given.unavailable }))
    return { ...given, handed: "unchanged" };
  await harness.call(MCP_SERVERS_PUT, { body: { servers: share, unavailable: given.unavailable } });
  log("supervisor", "MCP servers handed to the harness", {
    servers: share.map((c) => c.name),
    unavailable: given.unavailable.map((u) => u.name),
  });
  return { ...given, handed: "set" };
}
