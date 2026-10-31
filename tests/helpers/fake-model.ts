import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted OpenAI-compatible chat completions server for tests (streaming SSE, tool calls).
 * The script sees the request's messages and tools and returns either text or tool calls.
 */

export interface ScriptedTurn {
  /** Streamed first as reasoning (reasoning_content), as thinking models do. */
  thinking?: string;
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
  /** Ends the reply as cut off at the output limit (finish_reason "length"). */
  cutOff?: boolean;
  /** Fails the request with this HTTP status instead of answering. */
  fail?: number;
  /** The failure's message (default "scripted failure <status>"). */
  failMessage?: string;
  /**
   * Token usage reported for the reply (default 100 in, 20 out). `cached` and `reasoning`, when
   * given, are reported as OpenAI does (prompt_tokens_details, completion_tokens_details); else
   * left out, as many servers do.
   */
  usage?: { prompt: number; completion: number; cached?: number; reasoning?: number };
  /** Waits this long before the reply's first token (ms). */
  delayMs?: number;
  /**
   * A stream that goes silent: `open` answers 200 and its event stream's headers, then sends
   * nothing; `keep_alive` sends only comment lines (`: PROCESSING`), as a gateway does while the
   * model behind it sends nothing; `no_answer` never answers at all. None of them ever ends.
   */
  silent?: "open" | "keep_alive" | "no_answer";
}

export type Script = (req: {
  messages: { role: string; content?: unknown; tool_calls?: unknown; name?: string }[];
  tools: { function: { name: string } }[];
  /** The request's reasoning_effort, when one was sent. */
  reasoning_effort?: string | undefined;
}) => ScriptedTurn;

export interface FakeModel {
  url: string;
  requests: number;
  /** Requests whose connection the client closed before the reply ended. */
  closedEarly: number;
  close(): Promise<void>;
}

export async function startFakeModel(script: Script): Promise<FakeModel> {
  const state = { requests: 0, closedEarly: 0 };
  const timers = new Set<ReturnType<typeof setInterval>>();
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      state.requests++;
      const parsed = JSON.parse(body) as Parameters<Script>[0] & { model: string };
      const turn = script({
        messages: parsed.messages,
        tools: parsed.tools ?? [],
        reasoning_effort: parsed.reasoning_effort,
      });
      if (turn.fail) {
        res.writeHead(turn.fail, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: turn.failMessage ?? `scripted failure ${turn.fail}` },
          }),
        );
        return;
      }
      res.on("close", () => {
        if (!res.writableEnded) state.closedEarly++;
      });
      if (turn.silent === "no_answer") return;
      const id = `chatcmpl-${++n}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (turn.silent === "open") {
        res.flushHeaders();
        return;
      }
      if (turn.silent === "keep_alive") {
        const ping = () => res.write(": PROCESSING\n\n");
        ping();
        const t = setInterval(ping, 50);
        timers.add(t);
        res.on("close", () => {
          clearInterval(t);
          timers.delete(t);
        });
        return;
      }
      if (turn.delayMs) setTimeout(() => answer(res, turn, id, parsed.model), turn.delayMs);
      else answer(res, turn, id, parsed.model);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    get closedEarly() {
      return state.closedEarly;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const t of timers) clearInterval(t);
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Streams one scripted reply, its usage last. */
function answer(res: ServerResponse, turn: ScriptedTurn, id: string, model: string): void {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  if (turn.thinking)
    res.write(chunk({ role: "assistant", reasoning_content: turn.thinking }, null));
  res.write(chunk({ role: "assistant", content: turn.text ?? "" }, null));
  (turn.toolCalls ?? []).forEach((t, i) => {
    res.write(
      chunk(
        {
          tool_calls: [
            {
              index: i,
              id: `call_${id}_${i}`,
              type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            },
          ],
        },
        null,
      ),
    );
  });
  res.write(chunk({}, turn.cutOff ? "length" : turn.toolCalls?.length ? "tool_calls" : "stop"));
  const prompt = turn.usage?.prompt ?? 100;
  const completion = turn.usage?.completion ?? 20;
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(turn.usage?.cached !== undefined
      ? { prompt_tokens_details: { cached_tokens: turn.usage.cached } }
      : {}),
    ...(turn.usage?.reasoning !== undefined
      ? { completion_tokens_details: { reasoning_tokens: turn.usage.reasoning } }
      : {}),
  };
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [], usage })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}
