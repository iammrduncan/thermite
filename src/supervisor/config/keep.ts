import { log } from "../../common/env.ts";
import type { ConfigKey } from "../../core/link/config.ts";
import type { McpConnection, McpUnavailable } from "../../core/mcp.ts";
import { handMcpServers } from "../mcp-sync.ts";
import { handModelRoute } from "../model-route.ts";
import type { RigConfig } from "./bus.ts";

/**
 * Keeps the rig's agents on control's config: the model route and the MCP servers, handed to the
 * harness, and the advisors' share of the servers. Each value comes from the rig's config on the
 * message bus and is applied as it comes (bus.ts); every THERMITE_MODEL_ROUTE_POLL_SECONDS the
 * supervisor only looks at its own harness, handing over again what the harness lost, as after the
 * harness restarted.
 */

/** What keeping the config needs. */
export interface KeepConfig {
  rig: string;
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
  /** The rig's config from the bus. */
  known: RigConfig;
  /** The advisors' MCP servers, which the supervisor calls for them. */
  setAdvisorMcp: (servers: McpConnection[], unavailable: McpUnavailable[]) => void;
  /** How often to look, in milliseconds; 0: never. */
  everyMs: number;
  stopping: () => boolean;
  pause: (ms: number) => Promise<void>;
}

/** The servers the advisors use, of those control gave. */
const advisorsShare = (servers: McpConnection[]) =>
  servers.filter((c) => c.agents.includes("advisors"));

/**
 * Hands what the rig's config from the bus holds for `key` to where it is used: the route to the
 * harness, the MCP servers to the advisors and to the harness, each only when it changed. The
 * advisors' routes need nothing here: the advisors' next round reads them. A key with no value
 * yet changes nothing. Throws when the harness can't be reached.
 */
export async function applyConfig(k: KeepConfig, known: RigConfig, key: ConfigKey): Promise<void> {
  if (key === "model-route") {
    const given = known.get("model-route");
    if (given) await handModelRoute(k, given);
  } else if (key === "mcp-servers") {
    const given = known.get("mcp-servers");
    if (!given) return;
    k.setAdvisorMcp(advisorsShare(given.servers), given.unavailable);
    await handMcpServers(k, given);
  }
}

/** One look: the harness against what the bus gave. */
async function lookOnce(k: KeepConfig, failing: { route: boolean; mcp: boolean }): Promise<void> {
  const said = (what: "route" | "mcp", err?: unknown) => {
    if (err === undefined) {
      failing[what] = false;
      return;
    }
    const error = String(err).slice(0, 300);
    if (!failing[what])
      log(
        "supervisor",
        what === "route" ? "model route error" : "MCP servers error",
        { error },
        "error",
      );
    failing[what] = true;
  };
  await applyConfig(k, k.known, "model-route").then(
    () => said("route"),
    (err) => said("route", err),
  );
  await applyConfig(k, k.known, "mcp-servers").then(
    () => said("mcp"),
    (err) => said("mcp", err),
  );
}

/** Looks every `everyMs` until the supervisor stops. */
export async function keepConfig(k: KeepConfig): Promise<void> {
  const failing = { route: false, mcp: false };
  while (!k.stopping() && k.everyMs > 0) {
    await lookOnce(k, failing);
    await k.pause(k.everyMs);
  }
}
