import type { AuditEntry, CommandRow } from "../store/index.ts";
import { commandStatus } from "./commands/index.ts";
import { ago, esc, filterForm, infoLabel, pagerHtml } from "./components/index.ts";

/**
 * The audit log page (goal 181, from the owner's mockup): who did what through control, and what
 * control refused, with the commands in it, each with its delivery and outcome, which the Commands
 * page showed before. Drop-down filters by kind, by who and by rig, a search, and pages of
 * AUDIT_PAGE, newest first. MCP calls are left out unless their kind is picked.
 */

/** How many entries a page of the audit log shows. */
export const AUDIT_PAGE = 50;

/** Each kind of entry, as the Type filter names it. */
const AUDIT_KIND_WORDS: Record<string, string> = {
  command: "Commands",
  refusal: "Refused",
  export: "Exports",
  rig: "Rigs",
  kb: "Knowledge base",
  session: "Sign-ins",
  other: "Settings and the rest",
  mcp: "MCP calls",
};

/** Each kind of actor, as the Who filter names it. */
const AUDIT_ACTOR_WORDS: Record<string, string> = {
  owner: "You",
  operator: "Operators",
  agent: "Agents",
  rig: "Rigs",
  control: "Control",
};

/** The audit log page's filters, as its address gives them, and its cursor. */
export interface AuditQuery {
  type: string[];
  who: string[];
  rig: string[];
  q: string;
  before?: number | undefined;
  after?: number | undefined;
}

/** The kinds a page shows when its address names none: every kind but MCP calls. */
export const AUDIT_DEFAULT_KINDS = Object.keys(AUDIT_KIND_WORDS).filter((k) => k !== "mcp");

/** The audit log page's address with these filters, at this cursor. */
function auditHref(q: AuditQuery): string {
  const p = new URLSearchParams();
  const kinds = q.type.length ? q.type : AUDIT_DEFAULT_KINDS;
  // The default kinds need no words in the address.
  if (kinds.join() !== AUDIT_DEFAULT_KINDS.join()) for (const v of kinds) p.append("type", v);
  for (const v of q.who) p.append("who", v);
  for (const v of q.rig) p.append("rig", v);
  if (q.q.trim()) p.set("q", q.q.trim());
  if (q.before !== undefined) p.set("before", String(q.before));
  if (q.after !== undefined) p.set("after", String(q.after));
  const s = p.toString();
  return `/ui/audit${s ? `?${s}` : ""}`;
}

/** The kind an entry has, as the store works it out: for its chip. */
function auditKindOf(action: string): string {
  if (action.startsWith("mcp:")) return "mcp";
  if (action.startsWith("command_")) return "command";
  if (action === "refused" || action.includes("refused") || action.includes("throttled"))
    return "refusal";
  if (action.startsWith("export")) return "export";
  if (action.startsWith("kb_")) return "kb";
  if (/^(rig_|runpod_|machine_|cluster_|tunnel_|join)/.test(action)) return "rig";
  if (/^(login|session|sign)/.test(action)) return "session";
  return "other";
}

/** A command entry's row of the commands, where control has it. */
function commandCell(row: CommandRow | undefined): string {
  if (!row) return "";
  const s = commandStatus(row);
  const out = row.outcome as { result?: { error?: unknown } } | null;
  const why = typeof out?.result?.error === "string" ? out.result.error : "";
  return `<span class="chip ${s.tone}">${esc(s.word)}</span>${why ? ` <span class="muted small">${esc(why)}</span>` : ""}`;
}

export function auditBody(o: {
  entries: AuditEntry[];
  query: AuditQuery;
  /** Every rig control knows: the Rig filter's choices. */
  rigs: string[];
  /** A command entry's command, by its id. */
  command: (id: string) => CommandRow | undefined;
  /** Where the page is in the list: its first entry's place, and how many match in all. */
  from: number;
  total: number;
  older: number | null;
  newer: number | null;
  now: number;
}): string {
  const q = o.query;
  const kinds = q.type.length ? q.type : AUDIT_DEFAULT_KINDS;
  const filters = filterForm({
    action: "/ui/audit",
    filters: [
      {
        name: "type",
        label: "Type",
        tip: "The kind of entry. MCP calls, one for each call of a tool, are left out unless you pick them.",
        choices: Object.entries(AUDIT_KIND_WORDS).map(([value, label]) => ({ value, label })),
        picked: kinds,
      },
      {
        name: "who",
        label: "Who",
        tip: "Who did it: you (on the dashboard, over REST or MCP), an operator's or an agent's token, a rig, or control itself.",
        choices: Object.entries(AUDIT_ACTOR_WORDS).map(([value, label]) => ({ value, label })),
        picked: q.who,
      },
      {
        name: "rig",
        label: "Rig",
        tip: "The rig the entry is about, where it names one.",
        choices: o.rigs.map((r) => ({ value: r, label: r })),
        picked: q.rig,
      },
    ],
    search: { name: "q", value: q.q, placeholder: "Search actions and details" },
    href: (picked, search) =>
      auditHref({
        type: [...(picked.type ?? [])],
        who: [...(picked.who ?? [])],
        rig: [...(picked.rig ?? [])],
        q: search,
      }),
  });
  // A repeated refusal is one entry: when it came first, how often, and when last.
  const when = (x: AuditEntry) =>
    `<span title="${esc(x.at)}">${esc(ago(x.at, o.now))} ago</span>${x.count > 1 ? `<div class="xs">${x.count} times, the last ${esc(ago(x.last_at, o.now))} ago</div>` : ""}`;
  const rows = o.entries
    .map((x) => {
      const kind = auditKindOf(x.action);
      const body = (x.body ?? {}) as { rig?: unknown; id?: unknown };
      const rig = typeof body.rig === "string" ? body.rig : "";
      const cmd =
        x.action === "command_issued" && typeof body.id === "string"
          ? o.command(body.id)
          : undefined;
      const detail = JSON.stringify(x.body ?? {});
      return `<tr data-entry="${x.id}"><td class="muted nowrap">${when(x)}</td><td>${esc(x.actor)}</td><td><span class="chip">${esc(AUDIT_KIND_WORDS[kind] ?? kind)}</span> <b>${esc(x.action.replace(/_/g, " "))}</b> <span class="muted xs">${esc(x.action)}</span>${cmd ? ` <span class="small">${esc(cmd.kind)}</span>` : ""}</td><td class="small">${rig ? `<a href="/ui/rigs/${encodeURIComponent(rig)}">${esc(rig)}</a>` : `<span class="muted">—</span>`}</td><td>${commandCell(cmd)}</td><td><details class="aud-d" data-k="a-${x.id}"><summary class="muted small">Detail</summary><code class="aud-json">${esc(detail)}</code>${cmd ? `<div class="small"><b>Outcome:</b> <code>${esc(JSON.stringify(cmd.outcome ?? null))}</code></div>` : ""}</details></td></tr>`;
    })
    .join("");
  const pager = pagerHtml({
    from: o.entries.length ? o.from : 0,
    to: o.entries.length ? o.from + o.entries.length - 1 : 0,
    total: o.total,
    newest: o.newer !== null ? auditHref({ ...q, before: undefined, after: undefined }) : null,
    newer: o.newer !== null ? auditHref({ ...q, before: undefined, after: o.newer }) : null,
    older: o.older !== null ? auditHref({ ...q, after: undefined, before: o.older }) : null,
  });
  return `<p class="muted small" style="margin:0 0 10px">Everything you, operators, agents and rigs did through control, and what control refused. Commands are here with their delivery and outcome; MCP calls are left out unless you pick them under Type.</p>${filters}<div class="card flat" style="overflow-x:auto"><table><thead><tr><th>When</th><th>Who</th><th>${infoLabel("What", "The action. A command shows its kind; Detail has its payload and the rig's whole answer.")}</th><th>Rig</th><th>${infoLabel("Status", "A command's delivery and outcome: pending (not taken yet), delivered (the rig took it), rejected (the rig refused it, with why), failed, cancelled or expired. Other entries have none.")}</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty">No entry matches.</td></tr>`}</tbody></table></div>${pager}`;
}
