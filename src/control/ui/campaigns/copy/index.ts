import type { AgentsContext } from "../../../../core/compaction.ts";
import { isRigCheck, NAME_PATTERN, NAME_WORDS } from "../../../../core/ids.ts";
import {
  AGENT_KINDS,
  type AgentKind,
  type McpUse,
  McpUses,
  sameUses,
} from "../../../../core/mcp.ts";
import type { McpServer } from "../../../mcp-servers/index.ts";
import { esc } from "../../components/index.ts";
import { contextFields, fieldValues } from "../context/index.ts";
import { AGENT_WORDS, infoLabel, serverRow } from "../new/index.ts";

export { COPY_JS } from "./client.ts";

/**
 * The Copy panel on a campaign's page (goal 069, as the owner approved its mockup on
 * 2026-10-21). Copy, beside Start a run, opens it: the copy's name, checked as you type with the
 * New campaign page's name rules, and for a research campaign the MCP servers its agents use, as
 * the source has them, in the New campaign page's rows (the workers and the advisors: a research
 * run's planner takes no servers). A hill-climb or goal campaign's servers are in its kit's kit.json, which a
 * copy does not change: the panel lists them, read only. Then the copy's Agents' context (goal
 * 070): its context window and compaction point, as the source has them. Its form posts without
 * the page's script (/ui/assets/copy.js, copy/client.ts), which checks the name and the
 * numbers and keeps the summary, the request over REST and the command line, and the Copy button
 * in step.
 */

/** A research run's kinds of agent that take servers, as the rows offer them: not its planner. */
const RESEARCH_WORDS = AGENT_WORDS.filter(([k]) => k !== "planner");

export interface CopyPanel {
  /** The campaign to copy. */
  campaign: string;
  research: boolean;
  /** What a copy takes, in words: "version 3 of q4-gemv", or the assignment it copies. */
  what: string;
  csrf: string;
  open: boolean;
  /** The name field's value. */
  name: string;
  /** Every name control knows a campaign by, which a copy may not take. */
  taken: readonly string[];
  /** Of those, the names only Thermite's knowledge base knows: a folder or a grant. */
  folderOnly: readonly string[];
  /** The MCP servers in Settings. */
  servers: readonly McpServer[];
  /** The source's servers: a research contract's, or its kit's kit.json's. */
  source: readonly McpUse[];
  /** A research copy's servers as ticked when the panel opens: the source's by default. */
  picked?: readonly McpUse[] | undefined;
  /** Why control did not copy at the last try, in its words. */
  error?: string | undefined;
  /** The source's Agents' context (goal 070): the copy's starts as it. */
  context?: AgentsContext | undefined;
  /** The copy's Agents' context as typed at the last try, to show again. */
  typed?: { cw: string; ca: string } | undefined;
}

/**
 * A free name for the copy: the source's name and -b (or the next free letter after one, as
 * gemv-b gives gemv-c), or "" when none fits.
 */
export function suggestCopyName(base: string, taken: ReadonlySet<string>): string {
  const m = /^(.*)-([b-y])$/.exec(base);
  const stem = m?.[1] ?? base;
  for (let c = m?.[2] ? m[2].charCodeAt(0) + 1 : 98; c <= 122; c++) {
    const name = `${stem}-${String.fromCharCode(c)}`;
    if (!taken.has(name) && NAME_PATTERN.test(name) && !isRigCheck(name)) return name;
  }
  return "";
}

const listed = (a: readonly string[]) =>
  a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a.at(-1)}` : (a[0] ?? "");

/** The request the panel sends, as REST and the command line send it: shown under a fold. */
function requestWords(from: string, name: string, servers: readonly McpUse[] | undefined) {
  const body = { name: name || "NAME", ...(servers ? { mcp_servers: servers } : {}) };
  return {
    json: `POST /v1/campaigns/${from}/copy\n${JSON.stringify(body, null, 2)}`,
    cli: `Command line: thermite campaign copy ${from} ${name || "NAME"}${servers ? " --mcp-servers-json servers.json" : ""}. MCP: copy_campaign, with from: ${from}.`,
  };
}

/** The copy's Agents' context (goal 070): the two fields, as the source has them. */
function contextPart(p: CopyPanel): string {
  const typed = p.typed;
  const start = typed ? { cw: typed.cw, at: typed.ca } : fieldValues(p.context);
  return `<div class="sfd">${infoLabel("Agents' context", "The copy's own context window and compaction point, for every agent of its runs. They start as the source has them. Empty: the rig's. Control refuses to start a run of the copy on a rig where the model of an agent takes less than its window.")}${contextFields("copy", start, typed ? "" : `<span class="ok">✓ As ${esc(p.campaign)}.</span>`)}</div>`;
}

/** A hill-climb or goal campaign's servers, read only: they are in its kit's kit.json. */
function kitServers(p: CopyPanel): string {
  const inSettings = new Map(p.servers.map((s) => [s.name, s]));
  const rows = p.source
    .map((u) => {
      const s = inSettings.get(u.name);
      const total = s?.tools?.length ?? 0;
      const what = !s
        ? `Not in Settings. Add an MCP server named ${u.name} in Settings, or runs of the copy can't start.`
        : u.tools
          ? AGENT_KINDS.filter((k) => u.tools?.[k])
              .map((k) => `The ${k} get ${u.tools?.[k]?.length ?? 0} of its ${total} tools.`)
              .join(" ")
          : `All its ${total} tools.`;
      return `<div class="ck"><span class="ck-res"><span class="chip ${s ? "ok" : "bad"}">${s ? "✓ in Settings" : "✕ missing"}</span></span><span class="ck-main"><span><b>${esc(u.name)}</b> <span class="muted small">for the ${esc(listed(u.agents))}</span></span><span class="ck-what">${esc(what)}</span></span><span></span></div>`;
    })
    .join("");
  return `<div class="sfd"><span class="lb">MCP servers for its agents<i class="ii" tabindex="0" data-tip="${esc("A hill-climb or goal campaign keeps its MCP servers in its kit's kit.json. The copy has the same kit, so its agents get the same servers and tools. To change them, change kit.json and make a new campaign.")}">i</i></span>${
    rows
      ? `<div class="card flat">${rows}</div>`
      : `<div class="muted small">Its kit names no MCP server: the agents have only Thermite's own tools.</div>`
  }<div class="muted small">This campaign's MCP servers are in its kit's kit.json: change them on the <a href="/ui/campaigns/new">New campaign</a> page. The copy keeps them as they are.</div></div>`;
}

/** A server a list names that Settings does not have, for its row: only its name is known. */
const absent = (name: string): McpServer => ({
  name,
  url: "",
  auth: "none",
  header: null,
  client_id: null,
  scope: null,
  secret_hint: null,
  signed_in: false,
  status: "unchecked",
  last_error: null,
  tools: null,
  tools_at: null,
  checked_at: null,
  migrated_from: null,
  created_at: "",
  created_by: "",
  updated_at: "",
});

/** A research campaign's servers: the rows of Settings' servers, ticked as the source has them. */
function researchServers(p: CopyPanel): string {
  const picked = p.picked ?? p.source;
  const have = new Set(p.servers.map((s) => s.name));
  // A server the list names that Settings lacks gets a row too, so that it can be unticked.
  const missing = [...p.source, ...picked]
    .filter((u, i, all) => !have.has(u.name) && all.findIndex((x) => x.name === u.name) === i)
    .map((u) => u.name);
  const rows = [
    ...p.servers.map((s) => ({ s, missing: false })),
    ...missing.map((name) => ({ s: absent(name), missing: true })),
  ]
    .map(({ s, missing }) =>
      serverRow("c", s, {
        kinds: RESEARCH_WORDS,
        picked: picked.find((u) => u.name === s.name),
        named: true,
        missing,
        toolsTip:
          "By default each kind of agent you ticked gets every tool of the server. Untick a tool to keep it from that kind of agent. Tools marked writes change something on the server. The copy's contract names the tools only for a kind of agent you narrowed.",
      }),
    )
    .join("");
  const same = sameUses(picked, p.source);
  return `<div class="sfd"><span class="lb">MCP servers for its agents<i class="ii" tabindex="0" data-tip="${esc("The tools from outside Thermite that the copy's agents can call. The list starts as the source has it. Change it to give the copy's agents other servers or tools. A research run's planner takes no servers: its workers and advisors do. Open Advanced under a server to choose its tools for each kind of agent. Servers are added in Settings › MCP servers.")}">i</i></span><input type="hidden" name="mcp" value="1">${
    rows
      ? `<div class="mcp-pick" data-c-mcp>${rows}</div>`
      : `<div class="card"><div class="empty">No MCP server in Settings yet. <a href="/ui/settings#add-mcp">Add one in Settings</a>: the copy's agents have only Thermite's own tools until then.</div></div>`
  }<div class="cp-mcp-sum" data-c-mcp-sum aria-live="polite">${
    same
      ? `<span class="ok">✓ The same as ${esc(p.campaign)}.</span>`
      : `<span><b class="warn">Not as ${esc(p.campaign)}.</b> The copy's contract names these servers, so its hash is its own. Its page says that its servers are not its source's.</span>`
  }</div><div><button type="button" class="sm" data-c-mcp-reset${same ? " hidden" : ""}>Use the servers of ${esc(p.campaign)} again</button></div></div>`;
}

/** The panel: a drawer like Start a run's, open when the page asks for it (?copy=1 or a refusal). */
export function copyDrawer(p: CopyPanel): string {
  const href = `/ui/campaigns/${encodeURIComponent(p.campaign)}`;
  const picked = p.research ? (p.picked ?? p.source) : p.source;
  const changed = p.research && !sameUses(picked, p.source);
  const req = requestWords(p.campaign, p.name, changed ? picked : undefined);
  const data = {
    from: p.campaign,
    what: p.what,
    research: p.research,
    taken: p.taken,
    folderOnly: p.folderOnly,
    source: p.source,
    context: { cw: p.context?.context_window ?? null, at: p.context?.compact_at ?? null },
  };
  return `<div class="drawer-wrap" id="copy"${p.open ? "" : " hidden"}><a class="drawer-bg" href="${href}" data-close aria-label="Close"></a>
<aside class="drawer" aria-label="Copy the campaign"><form method="post" action="${href}/copy" class="drawer-form" data-copy="${esc(JSON.stringify(data))}" autocomplete="off">
<header><h3>Copy ${esc(p.campaign)}</h3><span class="grow"></span><a class="btn sm ghost" href="${href}" data-close>Close</a></header>
<div class="drawer-body"><input type="hidden" name="csrf" value="${esc(p.csrf)}">
${p.error ? `<div class="card warn" data-c-error><b class="bad">Not copied.</b> ${esc(p.error)}</div>` : ""}
<p class="cp-why">Copy it to start from zero: the copy gets its own empty collection in the knowledge base, so its runs read nothing that the runs of <b>${esc(p.campaign)}</b> recorded.</p>
<label class="sfd"><span class="lb">Name of the copy<i class="ii" tabindex="0" data-tip="${esc(`As on the New campaign page: ${NAME_WORDS}. No campaign can have it yet: not one with runs, a saved one, or a folder in the knowledge base. The copy's runs are named after it: name-1, name-2.`)}">i</i></span><input name="name" value="${esc(p.name)}" data-c-name required spellcheck="false" autocapitalize="off" maxlength="90">${
    // The name the panel offers is free; after a refusal, the card above says why not.
    p.error
      ? `<span class="cp-say" data-c-name-say aria-live="polite"></span>`
      : p.name
        ? `<span class="cp-say ok" data-c-name-say aria-live="polite">✓ Free. Its runs are named ${esc(p.name)}-1, ${esc(p.name)}-2, and so on.</span>`
        : `<span class="cp-say" data-c-name-say aria-live="polite">Write a name for the copy.</span>`
  }</label>
${p.research ? researchServers(p) : kitServers(p)}
${contextPart(p)}
<details class="adv"><summary>The same over REST, MCP and the command line</summary><div><pre class="json cp-req" data-c-json>${esc(req.json)}</pre><div class="muted small cp-req" data-c-cli>${esc(req.cli)}</div></div></details>
</div>
<footer><span class="grow small muted" data-c-sum>Copies ${esc(p.what)}: the same contract${p.research ? "" : " and kit"}, with the new name. No runs yet.</span><button class="primary" data-c-go>Copy</button></footer>
</form></aside></div>
<script src="/ui/assets/copy.js" defer></script>`;
}

type FormBody = Record<string, string | File | (string | File)[]>;
const values = (f: FormBody, key: string): string[] =>
  [f[key] ?? []].flat().filter((v): v is string => typeof v === "string");

/**
 * A research copy's servers as the panel posted them: each ticked server, with the kinds of agent
 * ticked for it and, for a kind given fewer than all of the server's tools, the tools ticked.
 * What the panel cannot show stays as the source has it: the planner (a research run's takes no
 * servers, so the panel offers no tick for it) and the tools of a server whose tools Settings has not read.
 * `tools`: each server in Settings with its tools as control last read them (null: not read).
 * `problems`: what stops the copy, in the panel's words. With problems, `uses` is the panel's
 * state as sent, to draw it again: a server with no agent, a kind of agent with no tool.
 */
export function postedUses(
  f: FormBody,
  tools: ReadonlyMap<string, readonly string[] | null>,
  source: readonly McpUse[],
): { uses: McpUse[]; problems: string[] } {
  const uses: McpUse[] = [];
  const problems: string[] = [];
  for (const name of [...new Set(values(f, "srv"))]) {
    const src = source.find((u) => u.name === name);
    const who = new Set(values(f, `who:${name}`));
    const agents = AGENT_KINDS.filter((k) =>
      k === "planner" ? src?.agents.includes(k) === true : who.has(k),
    );
    if (!agents.length) problems.push(`Choose the agents that get ${name}, or untick it.`);
    const all = tools.get(name) ?? null;
    const only: Partial<Record<AgentKind, string[]>> = {};
    for (const k of agents) {
      if (k === "planner" || !all?.length) {
        const kept = src?.tools?.[k];
        if (kept) only[k] = [...kept];
        continue;
      }
      const on = new Set(values(f, `tool:${name}:${k}`));
      const ticked = all.filter((t) => on.has(t));
      if (!ticked.length)
        problems.push(`The ${k} get no tool of ${name}: give them one, or untick ${k}.`);
      if (ticked.length < all.length) only[k] = ticked;
    }
    uses.push({ name, agents, ...(Object.keys(only).length ? { tools: only } : {}) });
  }
  if (!problems.length) {
    const ok = McpUses.safeParse(uses);
    if (!ok.success)
      problems.push(
        `The MCP servers can't be named so: ${ok.error.issues.map((i) => i.message).join("; ")}.`,
      );
  }
  return { uses, problems };
}
