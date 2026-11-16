import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Google's Gemini API on loopback, for tests: the model list and the streamed
 * content call, each answered from a script. It makes no call anywhere, takes any key, and keeps
 * what it was asked. `fetch` is what a test gives control: it carries a call for Google's address
 * to this server, and refuses and records a call to any other address.
 */

/** Google's address, as control calls it. */
const GOOGLE = "https://generativelanguage.googleapis.com";

/** How the stand-in answers a content call. */
export type ContentAnswer =
  /** An event stream of these chunks, then its end. */
  | { kind: "stream"; chunks: unknown[] }
  /** The chunks, then nothing more: the stream stays open until the caller breaks off. */
  | { kind: "hold"; chunks: unknown[] }
  /** The chunks, then the connection is destroyed. */
  | { kind: "cut"; chunks: unknown[] }
  /** An error status with a JSON body. */
  | { kind: "status"; status: number; body?: unknown }
  /** A redirect to another address. */
  | { kind: "redirect"; to: string };

/** One request the stand-in received. */
export interface StandInCall {
  method: string;
  path: string;
  search: string;
  /** The x-goog-api-key header it carried. */
  key: string | undefined;
  body: unknown;
}

/** A final chunk as Google's stream ends: text, a finish reason and the call's usage. */
export function finalChunk(usage: Record<string, number>, text = "done"): unknown {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: usage,
  };
}

export async function startGeminiStandIn() {
  const calls: StandInCall[] = [];
  /** Addresses other than Google's that control tried to call. */
  const elsewhere: string[] = [];
  /** The answers to the next content calls, in order; with none left, a short finished stream. */
  const answers: ContentAnswer[] = [];
  /** The model list's rows, and the status the list answers with. */
  const list = {
    status: 200,
    models: [] as unknown[],
  };
  /** Resolved each time a content call's connection closes. */
  const closed: (() => void)[] = [];
  const held = new Set<ServerResponse>();

  const read = async (req: IncomingMessage): Promise<unknown> => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    const text = Buffer.concat(parts).toString("utf8");
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return text;
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stand-in");
    const key = req.headers["x-goog-api-key"];
    const call: StandInCall = {
      method: req.method ?? "",
      path: url.pathname,
      search: url.search,
      key: typeof key === "string" ? key : undefined,
      body: await read(req),
    };
    calls.push(call);
    if (call.method === "GET" && call.path === "/v1beta/models") {
      res.writeHead(list.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          list.status === 200
            ? { models: list.models }
            : { error: { code: list.status, message: "stand-in refusal", status: "REFUSED" } },
        ),
      );
      return;
    }
    if (call.method !== "POST" || !/:streamGenerateContent$/u.test(call.path)) {
      res.writeHead(404).end();
      return;
    }
    res.on("close", () => {
      held.delete(res);
      for (const done of closed.splice(0)) done();
    });
    const answer = answers.shift() ?? {
      kind: "stream",
      chunks: [finalChunk({ promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 })],
    };
    if (answer.kind === "status") {
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body ?? { error: { code: answer.status } }));
      return;
    }
    if (answer.kind === "redirect") {
      res.writeHead(307, { location: answer.to }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of answer.chunks) res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
    if (answer.kind === "stream") res.end();
    else if (answer.kind === "cut") res.destroy();
    else held.add(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== GOOGLE) {
      elsewhere.push(url.origin);
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }
    return await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };

  return {
    fetch: fetchImpl,
    calls,
    elsewhere,
    answers,
    list,
    /** The content calls it received. */
    content: () => calls.filter((c) => c.method === "POST"),
    /** Waits until a content call's connection has closed. */
    connectionClosed: () => new Promise<void>((resolve) => closed.push(resolve)),
    async close() {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type GeminiStandIn = Awaited<ReturnType<typeof startGeminiStandIn>>;
