import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import {
  type CommandKind,
  MCP_AGENT_KINDS,
  MCP_OPERATOR_KINDS,
  MCP_OWNER_KINDS,
} from "../../core/commands.ts";
import type { BuildInfo } from "../../core/version.ts";
import type { Credential } from "../credential.ts";
import type { KitRepos } from "../kits/index.ts";
import type { DeploymentDriver, RunpodDriver } from "../lifecycle.ts";
import type { McpServers } from "../mcp-servers/index.ts";
import type { ControlParts } from "../parts.ts";
import type { RunpodRigs, RunpodTests } from "../runpod/index.ts";
import { keyHint } from "../secrets.ts";
import type { ControlStore } from "../store/index.ts";
import { findRun, type RigView, type RunOnRig, rigView } from "../views/index.ts";

/**
 * What MCP's tools share: control's options for MCP, the caller's role, and the context built once
 * for each request's server (who calls, which commands they may issue, the audit of every call).
 */

export type Role = "owner" | "operator" | "agent" | "reader";

export interface McpOptions {
  admin: Credential;
  operator?: Credential | undefined;
  agent?: Credential | undefined;
  read?: Credential | undefined;
  privateKeyPem: string;
  staleAfterMs: number;
  /** A rig is offline after this long without a report. */
  offlineAfterMs?: number | undefined;
  /** Control's own build, which rigs' builds are compared with. */
  control?: BuildInfo | undefined;
  /** Test pods on GPU clouds; without it the RunPod tools are not offered. */
  runpodTests?: RunpodTests | undefined;
  /** Rigs the owner launches on GPU clouds; without it the RunPod rig tools are not offered. */
  runpodRigs?: RunpodRigs | undefined;
  /** Their lifecycle driver (stop, start, restart, terminate): runpod_rig, the owner's. */
  runpodDriver?: RunpodDriver | undefined;
  /** The driver for other rigs, which a full reset restarts after its wipe. */
  driver?: DeploymentDriver | undefined;
  /** What control is made of (parts.ts): the operations MCP shares with the dashboard and REST. */
  parts: ControlParts;
  /** MCP servers for the agents (goal 068): the owner manages them here too. */
  mcpServers?: McpServers | undefined;
  /** Control's address as the owner reaches it: where a server's sign-in page sends the browser back. */
  publicUrl?: string | undefined;
  /** The MCP request's own address: control's address when publicUrl is not set. */
  requestUrl?: string | undefined;
  /** The kits control keeps (goal 096); without it the kit tools are not offered. */
  kits?: KitRepos | undefined;
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

/** What every module of tools takes, built once for each request's server by toolContext. */
export interface ToolContext {
  server: McpServer;
  store: ControlStore;
  opts: McpOptions;
  /** Who calls, as commands record their issuer. */
  actor: string;
  role: Role;
  /** Every token but the reader's issues commands. */
  canCommand: boolean;
  /** The kinds of command the caller's token may issue. */
  kinds: readonly CommandKind[];
  /** A tool whose call is in the audit log; `hide`: arguments that are secrets, logged as their last four characters. */
  audited: <A>(
    tool: string,
    fn: (args: A) => unknown,
    hide?: string[],
  ) => (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
  /** A rig's view, or an error that names it. */
  view: (rig: string) => RigView;
  /** A run wherever it ran (goal 170), with its rig's view, or an error that names it. */
  run: (run: string) => Promise<RunOnRig>;
}

export function toolContext(
  server: McpServer,
  store: ControlStore,
  opts: McpOptions,
  actor: string,
  role: Role,
): ToolContext {
  const canCommand = role !== "reader";
  const kinds =
    role === "owner" ? MCP_OWNER_KINDS : role === "operator" ? MCP_OPERATOR_KINDS : MCP_AGENT_KINDS;
  /** A tool whose call is in the audit log; `hide`: arguments that are secrets, logged as their last four characters. */
  const audited = <A>(tool: string, fn: (args: A) => unknown, hide: string[] = []) => {
    return async (args: A) => {
      const logged: Record<string, unknown> = { ...((args ?? {}) as Record<string, unknown>) };
      for (const k of hide)
        if (typeof logged[k] === "string") logged[k] = `given (${keyHint(String(logged[k]))})`;
      store.auditLog.add(actor, `mcp:${tool}`, logged);
      try {
        return json(await fn(args));
      } catch (err) {
        // With any secret it names masked: what the caller reads and the audit log keeps.
        const error = redact(errorText(err));
        // A refusal is in the audit log too, as the dashboard's are.
        store.auditLog.refusal(actor, "refused", { tool: `mcp:${tool}`, why: error });
        return { ...json({ error }), isError: true };
      }
    };
  };
  const viewOpts = {
    staleAfterMs: opts.staleAfterMs,
    offlineAfterMs: opts.offlineAfterMs,
    control: opts.control,
  };
  const view = (rig: string) => {
    const v = rigView(store, rig, viewOpts);
    if (!v) throw new Error(`no rig ${rig}`);
    return v;
  };
  const run = async (id: string) => {
    const x = await findRun(store, id, viewOpts);
    if (!x) throw new Error(`no run ${id}`);
    return x;
  };
  return { server, store, opts, actor, role, canCommand, kinds, audited, view, run };
}
