import type { Context, Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import {
  type McpAuth,
  type McpServer,
  type McpServerInput,
  type McpServers,
  namedBy,
  redirectUriOf,
} from "../../mcp-servers/index.ts";
import type { ControlStore } from "../../store/index.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { ago, esc, icon } from "../../ui/components/index.ts";

/**
 * Settings › Providers › MCP servers (goal 068, as the owner approved it on 2026-10-20): a row
 * for each server with its state, its sign-in (only a secret's last four characters), the kits
 * that name it and its tools; its fields, to change them; and the form to add one. The routes
 * behind them use the dashboard's session and form token. An OAuth sign-in is a link that opens
 * the server's own page in a new tab; the tab comes back to Settings.
 */

// biome-ignore lint/suspicious/noExplicitAny: any route's context
type Ctx = Context<any, any, any>;

export const AUTH_WORDS: Record<McpAuth, string> = {
  oauth: "OAuth sign-in",
  key: "key in a header",
  client: "client ID and secret",
  none: "no sign-in",
};

/** What adding a server of each kind does, and the add button's words (the page's script switches them). */
export const MCP_ADD_SAYS: Record<McpAuth, [string, string]> = {
  oauth: [
    "Sign in and read its tools",
    "Control opens the server's sign-in page in a new tab. Allow Thermite there, and the tab comes back here. Control seals the sign-in, renews it, and reads the server's tools with it. It calls no tool yet.",
  ],
  key: [
    "Add and read its tools",
    "Control seals the value and reads the server's tools with it. It calls no tool yet.",
  ],
  client: [
    "Add and read its tools",
    "Control seals the secret, gets a token from the server with it, and reads the server's tools. It calls no tool yet.",
  ],
  none: [
    "Add and read its tools",
    "Control reads the server's tools. It calls no tool yet. Anyone who can reach a server with no sign-in can use it: add only public servers this way.",
  ],
};

const URL_TIP =
  "The server's address: streamable HTTP or SSE, as control reaches it. Use https. Put no secret in it: the secret has its own field.";
const HEADER_TIP =
  "The header the key goes in. Most servers take Authorization, with the key after Bearer.";
const CLIENT_TIP = "The client ID the server gave you for Thermite.";
/** How many tools a row shows before "show all". */
const TOOLS_SHOWN = 8;

/** Back to Settings, with what happened said in the MCP servers block (at=mcp), not at the top. */
export const settingsUrl = (k: "ok" | "error", m: string, more = "") =>
  `/ui/settings?${k}=${encodeURIComponent(m)}&at=mcp${more}#mcp`;

/** The row's chip: what signs the server in, as its last four characters only. */
function secretChip(s: McpServer): string {
  if (s.auth === "oauth")
    return s.signed_in && s.status !== "needs_sign_in"
      ? `<span class="chip">signed in · the sign-in renews itself</span>`
      : `<span class="chip warn">${s.signed_in ? "OAuth sign-in ended" : "not signed in yet"}</span>`;
  if (s.auth === "key")
    return `<span class="chip">${esc(s.header ?? "Authorization")} · key ${esc(s.secret_hint ?? "…")}</span>`;
  if (s.auth === "client")
    return `<span class="chip">client ${esc(s.client_id ?? "")} · secret ${esc(s.secret_hint ?? "…")}</span>`;
  return `<span class="chip">no secret</span>`;
}

/** The row's state line. */
function statusLine(s: McpServer, now: number): { text: string; bad: boolean } {
  const tools = s.tools?.length ?? 0;
  if (s.status === "needs_sign_in")
    return {
      text: s.signed_in
        ? (s.last_error ?? "The sign-in ended. Sign in again.")
        : (s.last_error ?? "Not signed in yet. Sign in to read its tools."),
      bad: true,
    };
  if (s.status === "failing")
    return {
      text: `${s.last_error ?? "It failed."}${s.checked_at ? ` (${ago(s.checked_at, now)} ago)` : ""}`,
      bad: true,
    };
  if (s.status === "ok")
    return {
      text: `Connected · ${tools} tool${tools === 1 ? "" : "s"} · read ${ago(s.tools_at, now)} ago`,
      bad: false,
    };
  return { text: "Its tools are not read yet. Press Read tools again.", bad: false };
}

/** The server's tools: name, what it does, reads or writes; the first few, then the rest folded. */
export function toolTable(tools: McpServer["tools"]): string {
  if (!tools?.length) return `<div class="muted small">No tools read yet.</div>`;
  const row = (t: NonNullable<McpServer["tools"]>[number]) =>
    `<tr><td>${esc(t.name)}</td><td>${esc(t.description || "—")}</td><td style="width:1%"><span class="chip${t.reads ? "" : " warn"}">${t.reads ? "reads" : "writes"}</span></td></tr>`;
  const first = tools.slice(0, TOOLS_SHOWN);
  const rest = tools.slice(TOOLS_SHOWN);
  return `<table class="tools">${first.map(row).join("")}</table>${
    rest.length
      ? `<details class="more-tools"><summary class="muted small">and ${rest.length} more · show all ${tools.length}</summary><table class="tools">${rest.map(row).join("")}</table></details>`
      : ""
  }`;
}

/** The sign-in fields of a server's own form, by how it signs in. */
function authFields(s: McpServer): string {
  if (s.auth === "oauth") {
    const ended = !s.signed_in || s.status === "needs_sign_in";
    return `<div class="fd" style="grid-column:1/-1">${infoLabel("Sign-in", "Control signed in with the server's own OAuth page. It keeps the sign-in sealed and renews it. Sign in again when the server ends it.")}<span class="act"><a class="btn sm${ended ? " primary" : ""}" href="/ui/settings/mcp/${encodeURIComponent(s.name)}/sign-in" target="_blank" rel="noopener">${ended ? "Sign in again ↗" : "Sign in again with another account ↗"}</a><span class="muted small">${ended ? (s.signed_in ? "The server ended the sign-in." : "Not signed in yet.") : "Signed in. It renews itself."}</span></span></div>
<label>${infoLabel("Client ID", "Optional. Most servers register Thermite by themselves when you sign in. Fill this in only if the server asks you to register Thermite first. A new client ID needs a new sign-in.")}<input name="client_id" maxlength="500" value="${esc(s.client_id ?? "")}" placeholder="optional: most servers need none"></label>`;
  }
  if (s.auth === "key")
    return `<label>${infoLabel("Header", HEADER_TIP)}<input name="header" maxlength="100" value="${esc(s.header ?? "Authorization")}"></label><label>${infoLabel("New value", "Control seals a new value at once and never shows it again. Leave it empty to keep the current one.")}<input name="secret" type="password" autocomplete="new-password" maxlength="16384" placeholder="empty keeps the one ending ${esc((s.secret_hint ?? "").replace("…", ""))}"></label>`;
  if (s.auth === "client")
    return `<label>${infoLabel("Client ID", CLIENT_TIP)}<input name="client_id" maxlength="500" value="${esc(s.client_id ?? "")}"></label><label>${infoLabel("New client secret", "Control seals a new secret at once and never shows it again. Leave it empty to keep the current one.")}<input name="client_secret" type="password" autocomplete="new-password" maxlength="16384" placeholder="empty keeps the one ending ${esc((s.secret_hint ?? "").replace("…", ""))}"></label><label>${infoLabel("Scopes", "Optional. The scopes to ask for, separated by spaces. Empty: what the server gives by default.")}<input name="scope" maxlength="1000" value="${esc(s.scope ?? "")}" placeholder="optional"></label>`;
  return `<div class="muted small" style="grid-column:1/-1">This server needs no sign-in. Anyone who can reach it can use it.</div>`;
}

/** One server's row: its state, its sign-in, the kits that name it, its tools and its fields. */
function serverRow(
  store: ControlStore,
  s: McpServer,
  t: string,
  now: number,
  open: boolean,
): string {
  const n = encodeURIComponent(s.name);
  const kits = namedBy(store, s.name).map((x) => x.kit);
  const st = statusLine(s, now);
  const signIn = s.auth === "oauth" && (!s.signed_in || s.status === "needs_sign_in");
  const kitsLine = kits.length ? `named by ${kits.map(esc).join(", ")}` : "no kit names it";
  const form = (action: string, label: string, cls = "sm") =>
    `<form class="inline" method="post" action="/ui/settings/mcp/${n}/${action}"><input type="hidden" name="csrf" value="${t}"><button class="${cls}">${label}</button></form>`;
  const side = signIn
    ? `<a class="btn sm primary" href="/ui/settings/mcp/${n}/sign-in" target="_blank" rel="noopener">${s.signed_in ? "Sign in again ↗" : "Sign in ↗"}</a>`
    : form("check", "Read tools again");
  const failingNote =
    st.bad && kits.length
      ? `<div class="card warn" style="margin:0 0 10px;padding:8px 12px"><span class="small"><b>${esc(kits.join(", "))} name${kits.length === 1 ? "s" : ""} it.</b> Runs that use ${kits.length === 1 ? "that kit" : "those kits"} go on without its tools until it works again, and their history says so.</span></div>`
      : "";
  const moved =
    s.migrated_from === "outside_kb"
      ? `<div class="muted small" style="margin:0 0 8px">Moved here from the outside knowledge base at the update to 0.1.0, with its token.</div>`
      : "";
  const del = kits.length
    ? `<button class="sm danger" disabled>Delete this server</button> <span class="muted small">${esc(kits.join(" and "))} name${kits.length === 1 ? "s" : ""} it. Take it out of ${kits.length === 1 ? "that kit" : "those kits"} first.</span>`
    : `${form("delete", "Delete this server", "sm danger")} <span class="muted small">Control forgets its secret. Nothing changes on the server.</span>`;
  return `<details class="dq${st.bad ? " dq-bad" : ""}" data-mcp="${esc(s.name)}"${open ? " open" : ""}><summary>
<span class="dq-kind"><span class="kind g">MCP</span></span>
<span class="dq-main"><span class="dq-head">${esc(s.name)} <span class="muted" style="font-weight:400">· ${esc(AUTH_WORDS[s.auth])}</span></span><span class="dq-why${st.bad ? " bad" : ""}">${esc(st.text)}</span><span class="dq-sub"><span class="dq-where">${esc(s.url)}</span>${secretChip(s)}${s.url.startsWith("http://") ? `<span class="chip warn">not HTTPS</span>` : ""}<span class="dq-where">${kitsLine}</span></span></span>
<span class="dq-side"><span class="dq-btns">${side}</span></span>
</summary><div class="dq-body">
${moved}${failingNote}<div class="lb" style="margin-bottom:6px">Its tools${s.status === "ok" || !s.tools_at ? "" : `, as last read ${esc(ago(s.tools_at, now))} ago`}</div>${toolTable(s.tools)}
<form method="post" action="/ui/settings/mcp/${n}" class="form-grid" autocomplete="off" style="margin-top:14px"><input type="hidden" name="csrf" value="${t}">
<label>${infoLabel("Name", "How kits name this server. It can't change: add a new server for another name.")}<input value="${esc(s.name)}" readonly></label>
<label style="grid-column:span 2">${infoLabel("MCP URL", `${URL_TIP} Another address needs the secret again.`)}<input name="url" maxlength="500" value="${esc(s.url)}"></label>
${authFields(s)}
<div class="form-end"><button class="primary">Save and read its tools</button></div></form>
<div style="margin-top:10px">${del}</div>
</div></details>`;
}

/** The add form: name, address, how it signs in, and that kind's fields. */
function addForm(t: string): string {
  return `<form class="form-grid" id="mcp-add" method="post" action="/ui/settings/mcp" autocomplete="off" data-says="${esc(JSON.stringify(MCP_ADD_SAYS))}"><input type="hidden" name="csrf" value="${t}">
<label>${infoLabel("Name", "How kits name this server, for example gbrain or github. Lowercase letters, digits and dashes.")}<input name="name" id="m-name" required maxlength="64" pattern="[a-z0-9][a-z0-9\\-]*" title="Lowercase letters, digits and dashes" placeholder="for example github"></label>
<label style="grid-column:span 2">${infoLabel("MCP URL", URL_TIP)}<input name="url" id="m-url" required maxlength="500" placeholder="https://…/mcp"></label>
<label>${infoLabel("Sign-in", "How the server knows Thermite. OAuth: you sign in on the server's own page, once. A key: a token the server gave you, sent in a header. A client ID and secret: for servers that give Thermite its own client. None: a public server.")}<select name="auth" id="m-auth"><option value="oauth">OAuth: sign in on its page</option><option value="key">A key or token in a header</option><option value="client">A client ID and secret</option><option value="none">None: a public server</option></select></label>
<label data-auth="key" hidden>${infoLabel("Header", HEADER_TIP)}<input name="header" id="m-header" value="Authorization" maxlength="100"></label>
<label data-auth="key" hidden>${infoLabel("Value", "The header's value, for example Bearer and the token. Control seals it at once and never shows it again.")}<input name="secret" id="m-key" type="password" autocomplete="new-password" maxlength="16384" placeholder="Bearer … · never shown again"></label>
<label data-auth="client" hidden>${infoLabel("Client ID", CLIENT_TIP)}<input name="client_id_client" id="m-cid" maxlength="500" placeholder="from the server's settings"></label>
<label data-auth="client" hidden>${infoLabel("Client secret", "The secret that goes with the client ID. Control seals it at once and never shows it again.")}<input name="client_secret" id="m-csec" type="password" autocomplete="new-password" maxlength="16384" placeholder="never shown again"></label>
<label data-auth="client" hidden>${infoLabel("Scopes", "Optional. The scopes to ask for, separated by spaces. Empty: what the server gives by default.")}<input name="scope" maxlength="1000" placeholder="optional"></label>
<label data-auth="oauth">${infoLabel("Client ID", "Optional. Most servers register Thermite by themselves when you sign in. Fill this in only if the server asks you to register Thermite first.")}<input name="client_id_oauth" maxlength="500" placeholder="optional: most servers need none"></label>
<div class="nc-does" id="m-does" style="grid-column:1/-1"><b>What happens.</b> ${esc(MCP_ADD_SAYS.oauth[1])}</div>
<div class="form-end"><button class="primary" id="m-go">${esc(MCP_ADD_SAYS.oauth[0])}</button></div></form>`;
}

/** The two blocks on the Providers page: the servers, and the form to add one. */
export function mcpSettingsBlocks(
  store: ControlStore,
  servers: McpServers,
  t: string,
  now: number,
  q: (k: string) => string | undefined,
): string {
  const list = servers.list();
  const opened = q("mcp") ?? "";
  const error = q("at") === "mcp" ? q("error") : undefined;
  const ok = q("at") === "mcp" ? q("ok") : undefined;
  const note = error
    ? `<div class="card warn" style="margin-bottom:10px"><b class="bad">Not done.</b> ${esc(error)}</div>`
    : ok
      ? `<div class="card" style="margin-bottom:10px"><b class="ok">${esc(ok)}</b></div>`
      : "";
  const signIn = q("signin");
  const signInCard =
    signIn && servers.get(signIn)?.auth === "oauth"
      ? `<div class="card" style="margin-bottom:10px"><b>Now sign in to ${esc(signIn)}.</b> <span class="small">The server's sign-in page opens in a new tab. Allow Thermite there, and the tab comes back here.</span><div class="act" style="margin-top:8px"><a class="btn sm primary" href="/ui/settings/mcp/${encodeURIComponent(signIn)}/sign-in" target="_blank" rel="noopener">Sign in to ${esc(signIn)} ↗</a></div></div>`
      : "";
  const migrated = list.filter((s) => s.migrated_from === "outside_kb");
  const movedRead = store.auditLog.last("owner:ui", "mcp_moved_note_read") !== undefined;
  const moved =
    migrated.length && !movedRead
      ? `<div class="card" id="moved" style="margin-bottom:10px"><div class="card-head">${icon.book}<span class="title">The outside knowledge base is now an MCP server</span><span class="right"><form class="inline" method="post" action="/ui/settings/mcp-moved"><input type="hidden" name="csrf" value="${t}"><button class="sm ghost">Got it</button></form></span></div><p class="small" style="margin:6px 0 0">${esc(migrated.map((s) => s.name).join(", "))} ${migrated.length === 1 ? "was your outside knowledge base" : "were your outside knowledge bases"}. At the update to 0.1.0, control kept ${migrated.length === 1 ? "it" : "them"} here as ordinary MCP servers, with ${migrated.length === 1 ? "its token" : "their tokens"}. Control no longer copies campaigns' collections to ${migrated.length === 1 ? "it" : "them"}; the pages it wrote there stay. Advisors no longer search ${migrated.length === 1 ? "it" : "them"} through a grant on the campaign's page. A kit names ${migrated.length === 1 ? "it" : "them"} instead, and the agents that kit names get the tools. Thermite's own knowledge base is as before.</p></div>`
      : "";
  const rows = list.length
    ? `<div class="dqs" id="mcp-list">${list.map((s, i) => serverRow(store, s, t, now, s.name === opened || (!opened && i === 0 && list.length === 1))).join("")}</div>`
    : `<div class="card"><div class="empty">No MCP server yet: add one below. A kit then names it, and the agents it names get its tools.</div></div>`;
  return `<div class="block" id="mcp"><div class="head"><h2>MCP servers</h2><span class="n" id="mcp-n">${list.length}</span><span class="right">tools for the agents; a campaign's kit says which servers its agents use</span></div>${note}${signInCard}${moved}${rows}</div>
<div class="block" id="add-mcp"><div class="head"><h2>Add an MCP server</h2></div><div class="card">${addForm(t)}</div></div>`;
}

/** The page's form fields as a server's input; the oauth and client forms each have a client ID. */
function inputOf(
  f: Record<string, unknown>,
  auth: McpAuth,
  name: string,
  url: string,
): McpServerInput {
  const s = (k: string) => {
    const v = f[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  return {
    name,
    url,
    auth,
    header: s("header"),
    secret: s("secret"),
    client_id: s("client_id") ?? (auth === "client" ? s("client_id_client") : s("client_id_oauth")),
    client_secret: s("client_secret"),
    scope: s("scope"),
  };
}

/** The routes behind the blocks (the dashboard's session and form token apply). */
export function mountMcpUi(
  app: Hono,
  o: { store: ControlStore; servers: McpServers; publicUrl?: string | undefined },
): void {
  const { servers } = o;
  const back = (c: Ctx, k: "ok" | "error", m: string, name?: string) =>
    c.redirect(settingsUrl(k, m, name ? `&mcp=${encodeURIComponent(name)}` : ""), 303);
  /** Reads the server's tools and says how it went; `kept`: what was done before, if anything. */
  const checked = async (c: Ctx, name: string, said: string, kept?: string) => {
    const why = await servers.check(name);
    return why
      ? back(c, "error", kept ? `${name} is ${kept}, but ${why}.` : `${name}: ${why}.`, name)
      : back(
          c,
          "ok",
          `${said} Control read ${servers.get(name)?.tools?.length ?? 0} tools, and called none of them. Next: name it in a kit, on a campaign's How to measure step.`,
          name,
        );
  };

  app.post("/ui/settings/mcp", async (c) => {
    const f = await c.req.parseBody();
    const name = String(f.name ?? "").trim();
    const auth = String(f.auth ?? "") as McpAuth;
    if (servers.get(name)) return back(c, "error", `There is a server named ${name} already.`);
    try {
      servers.put(inputOf(f, auth, name, String(f.url ?? "")), "owner:ui");
    } catch (err) {
      return back(c, "error", errorText(err));
    }
    // An OAuth server: the sign-in opens from a link (a form may not go to another site).
    if (auth === "oauth")
      return c.redirect(
        settingsUrl(
          "ok",
          `${name} is kept. Now sign in: the server's page opens in a new tab.`,
          `&signin=${encodeURIComponent(name)}&mcp=${encodeURIComponent(name)}`,
        ),
        303,
      );
    return checked(c, name, `${name} is kept${auth === "none" ? "" : ", sealed"}.`, "kept");
  });

  app.post("/ui/settings/mcp/:name", async (c) => {
    const name = c.req.param("name");
    const old = servers.get(name);
    if (!old) return back(c, "error", "Settings has no server of that name.");
    const f = await c.req.parseBody();
    try {
      servers.put(
        {
          ...inputOf(f, old.auth, name, String(f.url ?? old.url)),
          header:
            typeof f.header === "string" && f.header.trim()
              ? f.header.trim()
              : (old.header ?? undefined),
          client_id:
            typeof f.client_id === "string"
              ? f.client_id.trim() || undefined
              : (old.client_id ?? undefined),
          scope:
            typeof f.scope === "string" ? f.scope.trim() || undefined : (old.scope ?? undefined),
        },
        "owner:ui",
      );
    } catch (err) {
      return back(c, "error", errorText(err), name);
    }
    const now = servers.get(name);
    if (now?.auth === "oauth" && !now.signed_in)
      return c.redirect(
        settingsUrl(
          "ok",
          `${name} is saved. Sign in again: its address or client changed.`,
          `&signin=${encodeURIComponent(name)}&mcp=${encodeURIComponent(name)}`,
        ),
        303,
      );
    return checked(c, name, `${name} is saved.`, "saved");
  });

  app.post("/ui/settings/mcp/:name/check", async (c) => {
    const name = c.req.param("name");
    if (!servers.get(name)) return back(c, "error", "Settings has no server of that name.");
    return checked(c, name, `${name} answers.`);
  });

  // A link, not a form: it opens the server's own sign-in page in the tab it opened.
  app.get("/ui/settings/mcp/:name/sign-in", async (c) => {
    const name = c.req.param("name");
    try {
      const { url } = await servers.startSignIn(
        name,
        redirectUriOf(o.publicUrl, c.req.url),
        "owner:ui",
      );
      return c.redirect(url, 302);
    } catch (err) {
      return back(c, "error", `${name}: ${errorText(err)}`, name);
    }
  });

  app.post("/ui/settings/mcp/:name/delete", (c) => {
    const name = c.req.param("name");
    const r = servers.delete(name, "owner:ui");
    if (r === "missing") return back(c, "error", "Settings has no server of that name.");
    if (r !== "deleted")
      return back(
        c,
        "error",
        `${r.named_by.join(" and ")} name it. Take it out of those kits first.`,
        name,
      );
    return back(
      c,
      "ok",
      `${name} is deleted. Control keeps nothing of its secrets. Nothing changed on the server.`,
    );
  });

  app.post("/ui/settings/mcp-moved", (c) => {
    o.store.auditLog.add("owner:ui", "mcp_moved_note_read", {});
    return c.redirect("/ui/settings#mcp", 303);
  });
}
