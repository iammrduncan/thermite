// The scripted model of the compose acceptance tests: an OpenAI-compatible server on this machine
// that answers each chat request with the turn a script gives, streamed as a real provider streams
// it, so the tests need no real model. It lists one model, "scripted", for control's provider
// list. The containers reach it at hostName(), on the port it listens on.
import { createServer } from "node:http";

/**
 * Starts the server. `script(messages, tools)` returns `{ text }` or `{ toolCalls: [{ name,
 * args }] }` for each request, or a promise of one (a turn that takes its time). `observe(messages)`, when given, sees every request's messages
 * first. `other(req)`, when given, sees each request that is neither a chat completion nor the
 * model list, which gets a 404. `keys` holds the Authorization header of every request.
 */
export async function scriptedModel(script, { observe, other } = {}) {
  const keys = new Set();
  let requests = 0;
  const server = createServer((req, res) => {
    keys.add(String(req.headers.authorization ?? ""));
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", async () => {
      // The provider's model list, as control reads it.
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "scripted", context_length: 32768 }] }));
        return;
      }
      if (req.method !== "POST") {
        other?.(req);
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "only chat completions here" } }));
        return;
      }
      requests++;
      const p = JSON.parse(body);
      observe?.(p.messages ?? []);
      const turn = await script(p.messages ?? [], p.tools ?? []);
      const id = `c${requests}`;
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: p.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: turn.text ?? "" }, null));
      for (const [i, t] of (turn.toolCalls ?? []).entries()) {
        res.write(
          chunk(
            {
              tool_calls: [
                {
                  index: i,
                  id: `${id}_${i}`,
                  type: "function",
                  function: { name: t.name, arguments: JSON.stringify(t.args) },
                },
              ],
            },
            null,
          ),
        );
      }
      res.write(chunk({}, turn.toolCalls?.length ? "tool_calls" : "stop"));
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: p.model, choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  // Every address: the containers reach this machine through the engine's own gateway.
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  return {
    port: server.address().port,
    keys,
    get requests() {
      return requests;
    },
    close: () => server.close(),
  };
}

/** This machine's name inside the containers: Docker's, or Podman's. */
export const hostName = (compose = process.env.COMPOSE ?? "podman compose") =>
  compose.startsWith("docker") ? "host.docker.internal" : "host.containers.internal";
