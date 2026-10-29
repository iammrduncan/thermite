import { gitHost } from "../../common/git-auth.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * What an assignment names that reaches past its rig: a Git access, a source the rig's supervisor
 * fetches, and the MCP servers its agents use with their sign-ins. The owner and the operator may
 * name them; an agent's token may not. A Git access is used only for the host it is for.
 */

interface Named {
  imports?: { path?: unknown; source?: { git?: unknown; url?: unknown; access?: unknown } }[];
  mcp_servers?: unknown;
  contract?: { mcp_servers?: unknown };
}

const listed = (v: unknown) => Array.isArray(v) && v.length > 0;

/**
 * Why an agent's token may not issue this assignment, in words, or "": it names a Git access, a
 * source to fetch (a git repository or a model's URL; a kit control keeps is not one), or MCP
 * servers.
 */
export function agentAssignRefusal(payload: unknown): string {
  const p = (payload ?? {}) as Named;
  const named: string[] = [];
  const imports = Array.isArray(p.imports) ? p.imports : [];
  if (imports.some((i) => i?.source?.access !== undefined)) named.push("a Git access");
  if (imports.some((i) => i?.source?.git !== undefined || i?.source?.url !== undefined))
    named.push("a source for its rig to fetch");
  if (listed(p.mcp_servers) || listed(p.contract?.mcp_servers)) named.push("MCP servers");
  if (!named.length) return "";
  return `An agent's token may not name ${named.join(", ")} in an assignment. The owner or the operator assigns such a campaign; an agent's token may assign one whose imports are in the rig's inbox already, or are kits control keeps.`;
}

/**
 * Why control refuses an assignment's Git access, in words, or "": each import that names one
 * must name an access Settings has, bound to a host, and fetch from that host.
 */
export function gitAccessRefusal(store: ControlStore, payload: unknown): string {
  const imports = ((payload ?? {}) as Named).imports;
  for (const i of Array.isArray(imports) ? imports : []) {
    const access = i?.source?.access;
    if (typeof access !== "string") continue;
    const g = store.gitAccess.get(access);
    if (!g) return `Settings has no Git access named ${access}.`;
    if (!g.host)
      return `The Git access ${access} is for no host yet: set the host it is for in Settings › Providers.`;
    const url = typeof i.source?.git === "string" ? i.source.git : "";
    const host = gitHost(url);
    if (host !== g.host)
      return `The Git access ${access} is for ${g.host} only, and ${String(i.path ?? "an import")} comes from ${host ?? "an address with no host"}.`;
  }
  return "";
}
