import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { errorText, Refusal } from "../../common/errors.ts";
import { LOCAL_HTTP_HOSTS } from "../../common/mcp-client.ts";
import type { PageNotes } from "../notes.ts";
import type { ControlStore } from "../store/index.ts";
import { MCP_AUTHS, type McpServer, type McpServers, namedBy } from "./index.ts";

/**
 * MCP servers over control's REST API (goal 068): the owner lists, adds, changes, checks, signs
 * in and deletes them; the OAuth callback takes the browser back from a server's sign-in page;
 * and a rig's supervisor reads what its runs' kits name, with the sign-in as headers.
 */

/** Where a server's sign-in page sends the browser back: control's address, as the owner reaches it. */
export const OAUTH_CALLBACK = "/v1/mcp-oauth/callback";

/** Why a sign-in is refused without THERMITE_CONTROL_PUBLIC_URL, in words. */
export const PUBLIC_URL_NEEDED =
  "An MCP server's sign-in sends your browser back to control: set THERMITE_CONTROL_PUBLIC_URL to the address you reach control at. Without it, a sign-in works only when you reach control as localhost, 127.0.0.1 or [::1].";

/**
 * The address a server's sign-in page sends the browser back to: control's public address, or,
 * when none is set, the request's own address on control's machine (localhost, 127.0.0.1 or
 * [::1]). Any other name the request came with is refused (Refusal): a request's Host is the
 * caller's to choose.
 */
export function redirectUriOf(publicUrl: string | undefined, requestUrl: string): string {
  if (publicUrl) return `${publicUrl.replace(/\/$/, "")}${OAUTH_CALLBACK}`;
  const url = new URL(requestUrl);
  if (!LOCAL_HTTP_HOSTS.includes(url.hostname)) throw new Refusal(PUBLIC_URL_NEEDED);
  return `${url.origin}${OAUTH_CALLBACK}`;
}

/** What the owner sends to add a server, or to change one (each secret left out is kept). */
export const ServerBody = z.strictObject({
  name: z.string().min(1).max(64),
  url: z.string().min(1).max(500),
  auth: z.enum(MCP_AUTHS as [string, ...string[]]),
  header: z.string().max(100).optional(),
  secret: z.string().max(16_384).optional(),
  client_id: z.string().max(500).optional(),
  client_secret: z.string().max(16_384).optional(),
  scope: z.string().max(1000).optional(),
});

/** A server as the API, MCP and the CLI show it: with the kits that name it, never a secret. */
export const serverJson = (store: ControlStore, s: McpServer) => ({
  ...s,
  named_by: namedBy(store, s.name).map((n) => n.kit),
});

export function mountMcpServerRoutes(
  app: Hono,
  o: {
    store: ControlStore;
    servers: McpServers;
    admin: MiddlewareHandler;
    publicUrl?: string | undefined;
    /** Where the sign-in's own error words wait for Settings (notes.ts). */
    notes: PageNotes;
  },
): void {
  const { notes, store, servers } = o;
  const one = (name: string) => {
    const s = servers.get(name);
    return s ? serverJson(store, s) : undefined;
  };

  app.get("/v1/mcp-servers", o.admin, (c) =>
    c.json({ servers: servers.list().map((s) => serverJson(store, s)) }),
  );

  // Added: an OAuth server answers with its sign-in page's address; another is read at once.
  app.post("/v1/mcp-servers", o.admin, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const b = ServerBody.parse(await c.req.json());
    if (servers.get(b.name.trim()))
      return c.json(
        { error: `There is a server named ${b.name} already: change it instead.` },
        409,
      );
    try {
      servers.put({ ...b, auth: b.auth as McpServer["auth"] }, "owner:api");
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
    const name = b.name.trim();
    if (b.auth === "oauth") {
      try {
        const { url } = await servers.startSignIn(
          name,
          redirectUriOf(o.publicUrl, c.req.url),
          "owner:api",
        );
        return c.json({ server: one(name), sign_in_url: url }, 201);
      } catch (err) {
        return c.json({ server: one(name), error: errorText(err) }, 201);
      }
    }
    const why = await servers.check(name);
    return c.json({ server: one(name), ...(why ? { check_error: why } : {}) }, 201);
  });

  app.put("/v1/mcp-servers/:name", o.admin, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const name = c.req.param("name");
    const old = servers.get(name);
    if (!old) return c.json({ error: "Settings has no server of that name." }, 404);
    const b = ServerBody.partial({ name: true, url: true, auth: true }).parse(await c.req.json());
    try {
      servers.put(
        {
          ...b,
          name,
          url: b.url ?? old.url,
          auth: (b.auth ?? old.auth) as McpServer["auth"],
          header: b.header ?? old.header ?? undefined,
          client_id: b.client_id ?? old.client_id ?? undefined,
          scope: b.scope ?? old.scope ?? undefined,
        },
        "owner:api",
      );
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
    const now = servers.get(name);
    if (now?.auth === "oauth" && !now.signed_in)
      return c.json({ server: one(name), sign_in: "needed" });
    const why = await servers.check(name);
    return c.json({ server: one(name), ...(why ? { check_error: why } : {}) });
  });

  app.post("/v1/mcp-servers/:name/check", o.admin, async (c) => {
    const name = c.req.param("name");
    if (!servers.get(name)) return c.json({ error: "Settings has no server of that name." }, 404);
    const why = await servers.check(name);
    return c.json({ server: one(name), ...(why ? { check_error: why } : {}) });
  });

  app.post("/v1/mcp-servers/:name/sign-in", o.admin, async (c) => {
    const name = c.req.param("name");
    if (!servers.get(name)) return c.json({ error: "Settings has no server of that name." }, 404);
    try {
      return c.json(
        await servers.startSignIn(name, redirectUriOf(o.publicUrl, c.req.url), "owner:api"),
      );
    } catch (err) {
      return c.json({ error: errorText(err) }, 409);
    }
  });

  app.delete("/v1/mcp-servers/:name", o.admin, (c) => {
    const r = servers.delete(c.req.param("name"), "owner:api");
    if (r === "missing") return c.json({ error: "Settings has no server of that name." }, 404);
    if (r !== "deleted")
      return c.json(
        {
          error: `${r.named_by.join(" and ")} name${r.named_by.length === 1 ? "s" : ""} it. Take it out of ${r.named_by.length === 1 ? "that kit" : "those kits"} first.`,
          named_by: r.named_by,
        },
        409,
      );
    return c.json({ deleted: true });
  });

  // The browser comes back here from the server's sign-in page. No token: the state, made for
  // one sign-in and used once, is what binds it. The tab goes on to Settings, which says how it went.
  app.get(OAUTH_CALLBACK, async (c) => {
    c.header("cache-control", "no-store");
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const back = (k: "ok" | "error", m: string) =>
      c.redirect(
        `/ui/settings?${k}=${encodeURIComponent(k === "error" ? notes.put(m) : m)}&at=mcp#mcp`,
        303,
      );
    if (!state) return back("error", "The sign-in came back without its state. Start it again.");
    if (!code) {
      const said = (c.req.query("error_description") ?? c.req.query("error") ?? "")
        .replace(/[^\w .,:;'()-]/g, "")
        .slice(0, 200);
      const name = servers.cancelSignIn(
        state,
        `The server did not sign Thermite in${said ? `: ${said}` : ""}.`,
      );
      return back(
        "error",
        `${name ? `${name}: ` : ""}The server did not sign Thermite in${said ? `: ${said}` : ""}.`,
      );
    }
    const r = await servers.finishSignIn(state, code);
    if (r.error) return back("error", r.name ? `${r.name}: ${r.error}` : r.error);
    return back(
      "ok",
      `Signed in to ${r.name}. Control sealed the sign-in and renews it. It read ${r.tools} tool${r.tools === 1 ? "" : "s"}, and called none of them.`,
    );
  });
}
