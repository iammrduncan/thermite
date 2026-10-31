import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_ERROR_MAX } from "../core/api/harness/supervisor.ts";
import { redact } from "./env.ts";

/**
 * One connection to an MCP server, as control (its checks), the harness (workers and the
 * planner) and the supervisor (the advisors) use it: the tool list and tool calls. The sign-in
 * goes in the request headers only, never in a URL, and every error's words are cleaned of it
 * before anything logs or records them. Streamable HTTP first; a server that refuses it (an
 * older one) is tried over SSE.
 */

/** A tool as a server lists it. */
export interface McpListedTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } | undefined;
}

/** A tool's answer, as the protocol gives it. */
export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean | undefined;
}

export interface McpSession {
  listTools(): Promise<McpListedTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export type McpConnect = (url: string, headers: Record<string, string>) => Promise<McpSession>;

/** Longest a connection, a list or a call may take before it counts as a failure. */
export const MCP_TIMEOUT_MS = { connect: 30_000, list: 30_000, call: 120_000 };

/** The tools a server lists, at most: far more than any server has. */
const MAX_TOOLS = 1000;

const VERSION = "1.0.0";

/** Streamable HTTP, or SSE for a server that refuses it, with these headers on every request. */
export function mcpConnect(fetchImpl?: typeof fetch, name = "thermite"): McpConnect {
  return async (url, headers) => {
    const target = new URL(url);
    const open = async (sse: boolean) => {
      const client = new Client({ name, version: VERSION });
      const withHeaders: typeof fetch = (input, init) =>
        (fetchImpl ?? fetch)(input, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers },
        });
      await client.connect(
        sse
          ? new SSEClientTransport(target, { fetch: withHeaders })
          : new StreamableHTTPClientTransport(target, {
              requestInit: { headers },
              ...(fetchImpl ? { fetch: fetchImpl } : {}),
            }),
        { timeout: MCP_TIMEOUT_MS.connect },
      );
      return client;
    };
    let client: Client;
    try {
      client = await open(false);
    } catch (err) {
      // An SSE-only server answers a streamable HTTP POST with 404 or 405.
      const code = (err as { code?: unknown }).code;
      if (code !== 404 && code !== 405 && !/\b(404|405)\b/.test(String(err))) throw err;
      client = await open(true);
    }
    return {
      listTools: async () => {
        const out: McpListedTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 50 && out.length < MAX_TOOLS; page++) {
          const r = await client.listTools(cursor ? { cursor } : undefined, {
            timeout: MCP_TIMEOUT_MS.list,
          });
          out.push(...(r.tools as McpListedTool[]));
          cursor = r.nextCursor;
          if (!cursor) break;
        }
        return out.slice(0, MAX_TOOLS);
      },
      callTool: async (tool, args) =>
        (await client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: MCP_TIMEOUT_MS.call,
        })) as McpCallResult,
      close: () => client.close(),
    };
  };
}

/**
 * An error's words with each secret taken out (whatever a server or a library echoed), and any
 * bearer token or known key shape too, at most MCP_ERROR_MAX characters (what a run's history
 * keeps of a server's failure).
 */
export function cleanMcpError(err: unknown, secrets: readonly string[] = []): string {
  const e = err as { message?: string; cause?: { code?: string } };
  let text = e?.message ?? String(err);
  if (e?.cause?.code) text = `${text} (${e.cause.code})`;
  for (const s of secrets) if (s && s.length >= 4) text = text.split(s).join("***");
  return redact(text).replace(/\s+/g, " ").trim().slice(0, MCP_ERROR_MAX);
}

/** The secret values among a server's headers: what an error's words must never carry. */
export const headerSecrets = (headers: Record<string, string>) =>
  Object.values(headers).flatMap((v) => [v, ...v.split(/\s+/).filter((w) => w.length >= 8)]);

/** The text of a tool's answer, for a model that reads text, at most n characters. */
export function resultText(r: McpCallResult, n = 30_000): string {
  const parts = (Array.isArray(r.content) ? r.content : []).map((c) => {
    const x = c as { type?: string; text?: string; resource?: { text?: string; uri?: string } };
    if (x?.type === "text" && typeof x.text === "string") return x.text;
    if (x?.type === "resource" && x.resource)
      return x.resource.text ?? `(a resource: ${x.resource.uri ?? "no address"})`;
    return `(${x?.type ?? "content"} left out: only text is passed on)`;
  });
  if (!parts.length && r.structuredContent !== undefined)
    parts.push(JSON.stringify(r.structuredContent));
  const text = parts.join("\n");
  return text.length > n ? `${text.slice(0, n)}\n(the answer was cut at ${n} characters)` : text;
}

/** The hosts an MCP server's URL may name over http: this machine itself, as `URL.hostname` gives them. */
export const LOCAL_HTTP_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/**
 * A URL control may give a server's sign-in to: https (http only for this machine itself), with
 * no user, password or fragment in it, and no query parameter that carries a secret. Null when
 * it is fine, else why not, in words.
 */
export function mcpUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "The MCP URL is not a URL.";
  }
  if (!/^https?:$/.test(u.protocol)) return "The MCP URL starts with https://.";
  if (u.protocol === "http:" && !LOCAL_HTTP_HOSTS.includes(u.hostname))
    return "Use https. Over http, the sign-in or key crosses the network in plain text, so control refuses it (http only for localhost).";
  if (u.username || u.password || u.hash)
    return "Put no user, password or fragment in the MCP URL: the sign-in has its own field.";
  for (const k of u.searchParams.keys())
    if (/token|key|secret|password|auth|sig/i.test(k))
      return "Put no secret in the URL. Use Sign-in for it.";
  return null;
}
