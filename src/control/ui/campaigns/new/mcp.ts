import type { McpUse } from "../../../../core/mcp.ts";
import type { McpServer } from "../../../mcp-servers/index.ts";
import { esc } from "../../components/index.ts";

/**
 * The new-campaign page's MCP servers block (goal 068, as the owner approved it on 2026-10-20):
 * on How to measure, and on The question for a research campaign. Each server in Settings is a
 * row: tick it, then choose the agents that get it (workers, planner, advisors). An Advanced part
 * under each server, closed until opened, gives each kind of agent its own ticks per tool, with
 * the tools that write marked. kit.json follows the choices (`tools` only when narrowed). For a
 * kit in a repository the list comes from its kit.json, read only. The page's script
 * (new/client.ts) keeps the summary and kit.json in step. The Copy panel on a research
 * campaign's page (goal 069) uses the same rows, for the workers and the advisors only, ticked as
 * the source has them and named, so that its form posts them without a script.
 */

const AUTH_WORDS: Record<McpServer["auth"], string> = {
  oauth: "OAuth sign-in",
  key: "key in a header",
  client: "client ID and secret",
  none: "no sign-in",
};

export const AGENT_WORDS = [
  ["workers", "Workers", "The agents that change the code, one per lane."],
  ["planner", "Planner", "Gives each lane its next experiment."],
  ["advisors", "Advisors", "The teachers, the auditor and the review panel."],
] as const;

/** The kinds of agent a row offers, as AGENT_WORDS lists them. */
export type AgentWords = readonly (typeof AGENT_WORDS)[number][];

const infoLabel = (text: string, tip: string) =>
  `<span class="lb">${esc(text)}<i class="ii" tabindex="0" data-tip="${esc(tip)}">i</i></span>`;

/** A server's state in a few words: whether it works now, and how many tools it has. */
function stateLine(s: McpServer, missing: boolean): { text: string; bad: boolean } {
  if (missing) return { text: "Not in Settings", bad: true };
  const n = s.tools?.length ?? 0;
  if (s.status === "ok") return { text: `Connected · ${n} tool${n === 1 ? "" : "s"}`, bad: false };
  if (s.status === "needs_sign_in")
    return { text: s.signed_in ? "Its sign-in ended" : "Not signed in yet", bad: true };
  if (s.status === "failing") return { text: "Can't read its tools now", bad: true };
  return { text: n ? `${n} tools, not read again yet` : "Its tools are not read yet", bad: false };
}

/**
 * How a row is drawn besides its server:
 * - `kinds`: the kinds of agent it offers (all three by default);
 * - `picked`: ticked as this entry of a list says (unticked when there is none);
 * - `named`: its ticks carry form names, so that a form posts them without the page's script:
 *   `srv` (the server), `who:<server>` (each kind of agent) and `tool:<server>:<kind>` (each tool);
 * - `missing`: a server that a list names and Settings does not have;
 * - `toolsTip`: what the Tools label says, when not the New campaign page's words.
 */
export interface ServerRowOptions {
  kinds?: AgentWords | undefined;
  picked?: McpUse | undefined;
  named?: boolean | undefined;
  missing?: boolean | undefined;
  toolsTip?: string | undefined;
}

const TOOLS_TIP =
  "By default each agent you ticked gets every tool of the server. Untick a tool to keep it from that kind of agent. Tools marked writes change something on the server. kit.json names the tools only for a kind of agent you narrowed.";

const ticked = (yes: boolean) => (yes ? " checked" : "");

/** The Advanced part of one server: a tick per tool for each kind of agent. */
function toolTicks(prefix: string, s: McpServer, o: ServerRowOptions): string {
  const kinds = o.kinds ?? AGENT_WORDS;
  const tools = s.tools ?? [];
  // A kind of agent the entry narrows gets only the tools it names.
  const gets = (k: (typeof kinds)[number][0], tool: string) => {
    const only = o.picked?.tools?.[k];
    return !only || only.includes(tool);
  };
  const body = tools.length
    ? `<table class="tools mcp-tools"><thead><tr><th>Tool</th><th></th>${kinds.map(([, w]) => `<th>${w}</th>`).join("")}</tr></thead><tbody>${tools
        .map(
          (t) =>
            `<tr data-tool="${esc(t.name)}"><td title="${esc(t.description)}">${esc(t.name)}</td><td><span class="chip${t.reads ? "" : " warn"}">${t.reads ? "reads" : "writes"}</span></td>${kinds.map(([k, w]) => `<td><input type="checkbox" data-tool-who="${k}"${o.named ? ` name="tool:${esc(s.name)}:${k}" value="${esc(t.name)}"` : ""}${ticked(gets(k, t.name))} aria-label="${esc(t.name)} for the ${w.toLowerCase()}"></td>`).join("")}</tr>`,
        )
        .join("")}</tbody></table>`
    : `<div class="muted small">${o.missing ? "Control has no list of its tools: the server is not in Settings." : "Its tools are not read yet. Read them in Settings to choose some here."}</div>`;
  return `<details class="adv mcp-adv" id="${prefix}-adv-${esc(s.name)}"><summary>Advanced: its tools for each kind of agent</summary><div>${infoLabel("Tools", o.toolsTip ?? TOOLS_TIP)}${body}</div></details>`;
}

/** One server's row in the list of Settings' servers. */
export function serverRow(prefix: string, s: McpServer, o: ServerRowOptions = {}): string {
  const kinds = o.kinds ?? AGENT_WORDS;
  const st = stateLine(s, o.missing === true);
  const id = `${prefix}-srv-${s.name}`;
  const p = o.picked;
  // A form that posts without the page's script keeps every agent's tick usable: its script
  // greys out the ticks of a server that is not ticked.
  const off = !p && !o.named;
  return `<div class="sopt" data-srv="${esc(s.name)}" data-tools="${s.tools?.length ?? 0}" data-bad="${st.bad ? 1 : 0}"${o.missing ? ` data-missing="1"` : ""}><input type="checkbox" id="${esc(id)}" data-srv-on${o.named ? ` name="srv" value="${esc(s.name)}"` : ""}${ticked(p !== undefined)} aria-label="give ${esc(s.name)} to this campaign's agents"><span><label for="${esc(id)}" style="cursor:pointer"><b>${esc(s.name)}</b>${o.missing ? "" : ` <span class="muted small">· ${esc(AUTH_WORDS[s.auth])}</span>`}</label><span class="sd"><span class="${st.bad ? "bad" : "ok"}">${esc(st.text)}</span>. ${o.missing ? "Add it in Settings › MCP servers, or untick it." : esc(s.url)}</span><span class="mcp-who${off ? " off" : ""}">${kinds.map(([k, w, tip]) => `<label title="${esc(tip)}"><input type="checkbox" data-who="${k}"${o.named ? ` name="who:${esc(s.name)}" value="${k}"` : ""}${ticked(p?.agents.includes(k) === true)}>${w}</label>`).join("")}</span>${toolTicks(prefix, s, o)}</span><span class="sr muted">${s.tools?.length ?? 0} tools</span></div>`;
}

/** The block, for one pane: "k" (How to measure) or "r" (The question). */
export function kitMcpSection(prefix: "k" | "r", servers: McpServer[]): string {
  const research = prefix === "r";
  const rows = servers.length
    ? servers.map((s) => serverRow(prefix, s)).join("")
    : `<div class="card"><div class="empty">No MCP server in Settings yet. <a href="/ui/settings#add-mcp">Add one in Settings</a>, then come back: the agents have only Thermite's own tools until then.</div></div>`;
  return `<div class="sec" id="${prefix}-mcp" data-mcp-block="${prefix}" style="margin-top:22px;max-width:980px"><h2>MCP servers for the agents</h2><p class="lead">Tools from outside Thermite that this campaign's agents can call: a knowledge base, a code host, a search for papers or documentation. ${research ? "Control writes them into the campaign, with the agents that get each one." : "The kit names the servers and which agents get each one."} The judge never uses them. Servers are added in <a href="/ui/settings#mcp">Settings › MCP servers</a>.</p>
<div data-mk-kit="here">${infoLabel("Servers", "Tick a server to give its tools to this campaign's agents. Then choose which agents get it. An agent gets only the servers ticked for it, and never their secrets.")}<div class="mcp-pick" style="margin-top:8px">${rows}</div></div>
${research ? "" : `<div data-mk-kit="repo" hidden><div class="muted small" style="margin-bottom:6px" data-mcp-repo-said>Fill in the kit's repository and its commit: control reads the servers from its kit.json. To change them, change kit.json in the kit's repository.</div><div class="card flat" data-mcp-repo-list></div></div>`}
<p class="sum" data-mcp-sum style="margin:12px 0 6px"></p>
<details class="adv"><summary>What goes into ${research ? "the campaign" : "kit.json"}</summary><div><pre class="json" data-mcp-json></pre></div></details>
<div class="nc-does"><b>How the agents reach them.</b> Control gives each rig only the servers its runs name. The rig's harness makes the calls for the workers and the planner, and its supervisor makes them for the advisors. Both keep the server's secret in memory. Agents see the tools and their answers, never a secret. A server that fails during a run does not stop it: the agents go on without it, and the run's history says so.</div></div>`;
}
