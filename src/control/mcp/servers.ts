import { z } from "zod";
import { redirectUriOf, ServerBody, serverJson } from "../mcp-servers/index.ts";
import type { ToolContext } from "./context.ts";

/** MCP servers for the agents (goal 068): the owner's, as in Settings › Providers. */
export function registerMcpServers(tools: ToolContext): void {
  const { server, store, opts, actor, role, audited } = tools;

  const mcp = opts.mcpServers;
  if (mcp) {
    server.registerTool(
      "mcp_servers",
      {
        title: "MCP servers",
        description:
          "The MCP servers in Settings › Providers: each one's address, how it signs in, its state, its last error, its tools (with whether each only reads) and the kits that name it. Never a key, a client secret or a sign-in: only a secret's last four characters.",
        inputSchema: {},
      },
      audited("mcp_servers", () => ({ servers: mcp.list().map((s) => serverJson(store, s)) })),
    );
  }
  if (mcp && role === "owner") {
    const auth = z.enum(["oauth", "key", "client", "none"]);
    server.registerTool(
      "mcp_server_add",
      {
        title: "Add an MCP server",
        description:
          "Adds an MCP server to Settings, for the kits that name it. auth: oauth (answers with sign_in_url: open it in a browser and allow Thermite; the server's page sends the browser back to control), key (header, default Authorization, and secret: the header's whole value, such as Bearer and the token), client (client_id and client_secret: control gets a token with them) or none (a public server). url: https, or http for localhost only. Control seals each secret, never shows it again, and reads the server's tools; it calls none of them. The owner's token only.",
        inputSchema: ServerBody.shape,
      },
      audited("mcp_server_add", async (a: z.infer<typeof ServerBody>) => {
        if (mcp.get(a.name.trim())) throw new Error(`There is a server named ${a.name} already.`);
        mcp.put({ ...a, auth: auth.parse(a.auth) }, actor);
        const name = a.name.trim();
        if (a.auth === "oauth") {
          const { url } = await mcp.startSignIn(
            name,
            redirectUriOf(opts.publicUrl, opts.requestUrl ?? "http://localhost"),
            actor,
          );
          return {
            server: serverJson(store, mcp.get(name) as NonNullable<ReturnType<typeof mcp.get>>),
            sign_in_url: url,
          };
        }
        const why = await mcp.check(name);
        return {
          server: serverJson(store, mcp.get(name) as NonNullable<ReturnType<typeof mcp.get>>),
          ...(why ? { check_error: why } : {}),
        };
      }),
    );
    server.registerTool(
      "mcp_server_change",
      {
        title: "Change an MCP server",
        description:
          "Changes a server's address, header, client ID, scopes or secrets. A secret left out is kept, except for another address or another way to sign in, which need it again. Then control reads its tools again. The owner's token only.",
        inputSchema: ServerBody.partial({ url: true, auth: true }).shape,
      },
      audited(
        "mcp_server_change",
        async (a: Partial<z.infer<typeof ServerBody>> & { name: string }) => {
          const old = mcp.get(a.name);
          if (!old) throw new Error(`Settings has no server named ${a.name}.`);
          mcp.put(
            {
              ...a,
              url: a.url ?? old.url,
              auth: auth.parse(a.auth ?? old.auth),
              header: a.header ?? old.header ?? undefined,
              client_id: a.client_id ?? old.client_id ?? undefined,
              scope: a.scope ?? old.scope ?? undefined,
            },
            actor,
          );
          const now = mcp.get(a.name);
          if (now?.auth === "oauth" && !now.signed_in)
            return { server: serverJson(store, now), sign_in: "needed: call mcp_server_sign_in" };
          const why = await mcp.check(a.name);
          return {
            server: serverJson(store, mcp.get(a.name) as NonNullable<ReturnType<typeof mcp.get>>),
            ...(why ? { check_error: why } : {}),
          };
        },
      ),
    );
    server.registerTool(
      "mcp_server_check",
      {
        title: "Read an MCP server's tools again",
        description:
          "Control reads the server's tools again with its sign-in, and keeps them with its state. It calls no tool. The owner's token only.",
        inputSchema: { name: z.string().min(1) },
      },
      audited("mcp_server_check", async (a: { name: string }) => {
        if (!mcp.get(a.name)) throw new Error(`Settings has no server named ${a.name}.`);
        const why = await mcp.check(a.name);
        return {
          server: serverJson(store, mcp.get(a.name) as NonNullable<ReturnType<typeof mcp.get>>),
          ...(why ? { check_error: why } : {}),
        };
      }),
    );
    server.registerTool(
      "mcp_server_sign_in",
      {
        title: "Sign in to an MCP server",
        description:
          "For a server that signs in with OAuth: the address of its sign-in page. Open it in a browser within 15 minutes and allow Thermite; the page sends the browser back to control, which seals the sign-in and renews it. The owner's token only.",
        inputSchema: { name: z.string().min(1) },
      },
      audited("mcp_server_sign_in", async (a: { name: string }) =>
        mcp.startSignIn(
          a.name,
          redirectUriOf(opts.publicUrl, opts.requestUrl ?? "http://localhost"),
          actor,
        ),
      ),
    );
    server.registerTool(
      "mcp_server_delete",
      {
        title: "Delete an MCP server",
        description:
          "Control forgets the server and its secrets. Nothing changes on the server. Refused while a kit names it: take it out of those kits first. The owner's token only.",
        inputSchema: { name: z.string().min(1) },
      },
      audited("mcp_server_delete", (a: { name: string }) => {
        const r = mcp.delete(a.name, actor);
        if (r === "missing") throw new Error(`Settings has no server named ${a.name}.`);
        if (r !== "deleted")
          throw new Error(`${r.named_by.join(" and ")} name it. Take it out of those kits first.`);
        return { deleted: true };
      }),
    );
  }
}
