import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";

/**
 * A stand-in for an MCP server and its OAuth server, for tests (goal 068). On a free local port:
 *
 * - /mcp: an MCP server over streamable HTTP with three tools: `search` and `get_page` (they say
 *   they only read) and `put_page` (it writes). It takes the sign-in the test sets: a bearer
 *   token, a key in a header of its own, an access token from its own OAuth server, or none;
 * - its OAuth server, at the same address: protected resource metadata, authorization server
 *   metadata, client registration (RFC 7591), an authorization page that allows at once and sends
 *   the browser back with a code, and a token endpoint for codes (with PKCE), refresh tokens and
 *   client credentials.
 *
 * It keeps every request's headers and every call, so a test can see what reached it and what
 * did not. Nothing in it reaches the internet.
 */

export type FakeAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "header"; header: string; value: string }
  | { kind: "oauth" };

export interface FakeMcp {
  /** The MCP URL. */
  url: string;
  /** The server's address (its OAuth server's too). */
  origin: string;
  auth: FakeAuth;
  /** Every request to /mcp: its headers, as lowercase names. */
  requests: { path: string; headers: Record<string, string> }[];
  /** Every tool call, with its arguments. */
  calls: { tool: string; args: Record<string, unknown> }[];
  pages: Map<string, string>;
  /** When true, /mcp answers 503 to everything (a server that is down). */
  down: boolean;
  /** OAuth: the clients registered, the clients a test made (id → secret), the tokens given. */
  registered: { client_id: string; redirect_uris: string[] }[];
  clients: Map<string, string>;
  accessTokens: Set<string>;
  refreshTokens: Set<string>;
  /** How long an access token lasts (seconds). */
  expiresIn: number;
  /** OAuth: whether the server registers clients by itself. */
  dcr: boolean;
  /** Token requests, by grant type. */
  grants: string[];
  close(): Promise<void>;
}

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

export async function startFakeMcp(auth: FakeAuth = { kind: "none" }): Promise<FakeMcp> {
  const fake: FakeMcp = {
    url: "",
    origin: "",
    auth,
    requests: [],
    calls: [],
    pages: new Map([["notes/start", "The first page of the fake brain."]]),
    down: false,
    registered: [],
    clients: new Map(),
    accessTokens: new Set(),
    refreshTokens: new Set(),
    expiresIn: 3600,
    dcr: true,
    grants: [],
    close: async () => {},
  };
  let n = 0;
  const codes = new Map<
    string,
    { client_id: string; redirect_uri: string; challenge: string; resource: string | null }
  >();
  const text = (t: string, isError = false) => ({
    content: [{ type: "text" as const, text: t }],
    ...(isError ? { isError: true } : {}),
  });
  const build = () => {
    const server = new McpServer({ name: "fake-mcp", version: "1.0.0" });
    server.registerTool(
      "search",
      {
        description: "Finds pages by words.",
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        fake.calls.push({ tool: "search", args });
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = [...fake.pages.entries()]
          .filter(([, c]) => words.every((w) => c.toLowerCase().includes(w)))
          .map(([slug]) => slug);
        return text(JSON.stringify({ hits }));
      },
    );
    server.registerTool(
      "get_page",
      {
        description: "Reads one page.",
        inputSchema: { slug: z.string() },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        fake.calls.push({ tool: "get_page", args });
        const page = fake.pages.get(args.slug);
        return page === undefined ? text(`no page ${args.slug}`, true) : text(page);
      },
    );
    server.registerTool(
      "put_page",
      {
        description: "Writes a whole page.",
        inputSchema: { slug: z.string(), content: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async (args) => {
        fake.calls.push({ tool: "put_page", args });
        fake.pages.set(args.slug, args.content);
        return text(JSON.stringify({ slug: args.slug }));
      },
    );
    return server;
  };
  const signedIn = (h: Record<string, string>) => {
    const a = fake.auth;
    if (a.kind === "none") return true;
    if (a.kind === "bearer") return h.authorization === `Bearer ${a.token}`;
    if (a.kind === "header") return h[a.header.toLowerCase()] === a.value;
    const t = h.authorization?.startsWith("Bearer ") ? h.authorization.slice(7) : "";
    return fake.accessTokens.has(t);
  };
  const app = new Hono();
  app.all("/mcp", async (c) => {
    const u = new URL(c.req.url);
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    fake.requests.push({ path: `${u.pathname}${u.search}`, headers });
    if (fake.down) return c.json({ error: "down for a test" }, 503);
    if (!signedIn(headers))
      return c.json({ error: "unauthorized" }, 401, {
        "www-authenticate": `Bearer resource_metadata="${fake.origin}/.well-known/oauth-protected-resource/mcp"`,
      });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await build().connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  // ---- its OAuth server
  const resourceMeta = (c: { json: (v: unknown, s?: number) => Response }) =>
    fake.auth.kind === "oauth"
      ? c.json({ resource: `${fake.origin}/mcp`, authorization_servers: [fake.origin] })
      : c.json({ error: "not found" }, 404);
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => resourceMeta(c));
  app.get("/.well-known/oauth-protected-resource", (c) => resourceMeta(c));
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: fake.origin,
      authorization_endpoint: `${fake.origin}/authorize`,
      token_endpoint: `${fake.origin}/token`,
      ...(fake.dcr ? { registration_endpoint: `${fake.origin}/register` } : {}),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    }),
  );
  app.get("/.well-known/openid-configuration", (c) => c.json({ error: "not found" }, 404));
  app.post("/register", async (c) => {
    if (!fake.dcr) return c.json({ error: "not supported" }, 404);
    const body = (await c.req.json()) as { redirect_uris?: string[] };
    const client_id = `registered-client-${++n}`;
    fake.registered.push({ client_id, redirect_uris: body.redirect_uris ?? [] });
    return c.json({ ...body, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
  });
  // The owner allows at once: the browser goes back with a code.
  app.get("/authorize", (c) => {
    const q = (k: string) => c.req.query(k) ?? "";
    const back = new URL(q("redirect_uri"));
    back.searchParams.set("state", q("state"));
    const known =
      fake.registered.some((r) => r.client_id === q("client_id")) ||
      fake.clients.has(q("client_id"));
    if (!known || q("code_challenge_method") !== "S256" || !q("code_challenge")) {
      back.searchParams.set("error", "invalid_request");
      return c.redirect(back.href, 302);
    }
    const code = `code-${++n}`;
    codes.set(code, {
      client_id: q("client_id"),
      redirect_uri: q("redirect_uri"),
      challenge: q("code_challenge"),
      resource: c.req.query("resource") ?? null,
    });
    back.searchParams.set("code", code);
    return c.redirect(back.href, 302);
  });
  const issue = (c: { json: (v: unknown, s?: number) => Response }, refresh: boolean) => {
    const access = `access-${++n}`;
    fake.accessTokens.add(access);
    const out: Record<string, unknown> = {
      access_token: access,
      token_type: "Bearer",
      expires_in: fake.expiresIn,
    };
    if (refresh) {
      const r = `refresh-${++n}`;
      fake.refreshTokens.add(r);
      out.refresh_token = r;
    }
    return c.json(out);
  };
  app.post("/token", async (c) => {
    const f = new URLSearchParams(await c.req.text());
    const grant = f.get("grant_type") ?? "";
    fake.grants.push(grant);
    const bad = (error: string) => c.json({ error }, 400);
    if (grant === "authorization_code") {
      const code = codes.get(f.get("code") ?? "");
      codes.delete(f.get("code") ?? "");
      if (!code) return bad("invalid_grant");
      if (code.client_id !== f.get("client_id") || code.redirect_uri !== f.get("redirect_uri"))
        return bad("invalid_grant");
      if (s256(f.get("code_verifier") ?? "") !== code.challenge) return bad("invalid_grant");
      return issue(c, true);
    }
    if (grant === "refresh_token") {
      const r = f.get("refresh_token") ?? "";
      if (!fake.refreshTokens.has(r)) return bad("invalid_grant");
      fake.refreshTokens.delete(r);
      return issue(c, true);
    }
    if (grant === "client_credentials") {
      let id = f.get("client_id") ?? "";
      let secret = f.get("client_secret") ?? "";
      const basic = c.req.header("authorization") ?? "";
      if (basic.startsWith("Basic ")) {
        const [a, b] = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":");
        id = decodeURIComponent(a ?? "");
        secret = decodeURIComponent(b ?? "");
      }
      if (!fake.clients.has(id) || fake.clients.get(id) !== secret) return bad("invalid_client");
      return issue(c, false);
    }
    return bad("unsupported_grant_type");
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  fake.origin = `http://127.0.0.1:${port}`;
  fake.url = `${fake.origin}/mcp`;
  fake.close = () =>
    new Promise<void>((r) => {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close(() => r());
    });
  return fake;
}
