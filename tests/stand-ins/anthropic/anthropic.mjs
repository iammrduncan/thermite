// Test only (scripts/acceptance/claude-real.mjs): a stand-in for Anthropic's Messages API, which
// the real Claude Code calls (POST /v1/messages, streamed as server-sent events, as Claude Code
// asks). It plays the model from the prompt alone:
//   - "run exactly this command: X" (the model check's words): a Bash call of X, then the
//     command's output as the answer;
//   - each "call the TOOL tool with input {...}END", in order: one call each, then "done: " and
//     the last tool's output;
//   - "ADVISOR-CHECK": the JSON answer an advisor gives;
//   - "COMPACT-CHECK": two Bash calls, the second of which says the conversation is large, so
//     Claude Code compacts; the compaction's summary request, which carries the line of
//     Thermite's PreCompact hook, is answered with a summary that names the kept file (goal 070);
//   - anything else (Claude Code's own side requests): "ok".
// It answers only a request signed in with the token it was given (Authorization: Bearer, as
// Claude Code sends a subscription's token), and counts the others. It keeps no token and no
// prompt, only counts.

import { createServer } from "node:http";

export const PORT = 8739;

const textOf = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b.type === "text" ? b.text : "")).join("\n")
      : "";
const resultText = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : "";

/** The model's next reply to a request: content blocks and why it stops. */
export function reply(body) {
  const messages = body.messages ?? [];
  const user = messages.filter((m) => m.role === "user");
  const prompt = user.map((m) => textOf(m.content)).join("\n");
  const results = user.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
  );
  const offered = new Set((body.tools ?? []).map((t) => t.name));
  // Goal 070: a compaction's summary request that carries the line Thermite's PreCompact hook
  // added to Claude Code's instructions. The summary names the file, as the line asks.
  const kept = /Thermite keeps the whole conversation before this compaction in (\S+\.md)/.exec(
    prompt,
  )?.[1];
  if (kept)
    return {
      content: [
        {
          type: "text",
          text: `<summary>\nThe value is checked. The whole conversation is kept in ${kept}.\n</summary>`,
        },
      ],
      stop: "end_turn",
    };
  // "COMPACT-CHECK": a trial that compacts, in two rounds of one Bash call each. The second reply
  // says the conversation is already large, so Claude Code compacts it before its next request.
  // Two rounds, because Claude Code 2.1.305 (its window from CLAUDE_CODE_AUTO_COMPACT_WINDOW)
  // keeps the newest round whole and summarizes only earlier rounds with a reply in them: with
  // one round it has nothing to summarize ("no assistant messages in summarize set, bailing").
  // After the compaction, it is done.
  if (
    /COMPACT-CHECK/.test(prompt) &&
    !/The whole conversation is kept in/.test(prompt) &&
    results.length < 2 &&
    offered.has("Bash")
  )
    return {
      content: [
        {
          type: "tool_use",
          id: `toolu_compact_${results.length + 1}`,
          name: "Bash",
          input: { command: `echo compact-check-${results.length + 1}` },
        },
      ],
      stop: "tool_use",
      ...(results.length === 1 ? { usage: { input_tokens: 60_000 } } : {}),
    };
  const steps = [...prompt.matchAll(/call the (\w+) tool with input (\{.*?\})END/gs)].map((m) => ({
    name: m[1],
    input: JSON.parse(m[2]),
  }));
  const command = /run exactly this command: ([^\n]+)/.exec(prompt)?.[1]?.trim();
  if (command && offered.has("Bash")) steps.push({ name: "Bash", input: { command } });
  const next = steps[results.length];
  if (next && offered.has(next.name))
    return {
      content: [
        { type: "tool_use", id: `toolu_${results.length + 1}`, name: next.name, input: next.input },
      ],
      stop: "tool_use",
    };
  const last = results.at(-1);
  if (last) {
    const out = resultText(last.content).trim();
    return { content: [{ type: "text", text: command ? out : `done: ${out}` }], stop: "end_turn" };
  }
  if (/ADVISOR-CHECK/.test(prompt))
    return {
      content: [{ type: "text", text: '{"decision": "clear", "by": "the stand-in"}' }],
      stop: "end_turn",
    };
  return { content: [{ type: "text", text: "ok" }], stop: "end_turn" };
}

/** Starts the stand-in on 127.0.0.1:PORT; `seen` counts the requests by how they signed in. */
export function startAnthropicStandIn(o) {
  const seen = { signedIn: 0, other: 0, withTools: 0 };
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const fail = (status, message) =>
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ type: "error", error: { type: "error", message } }));
      if (req.headers.authorization !== `Bearer ${o.token}`) {
        seen.other++;
        return fail(401, "not signed in");
      }
      seen.signedIn++;
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return fail(400, "not JSON");
      }
      const path = (req.url ?? "").split("?")[0];
      if (path === "/v1/messages/count_tokens")
        return res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ input_tokens: 10 }));
      if (req.method !== "POST" || path !== "/v1/messages") return fail(404, "not here");
      if (body.tools?.length) seen.withTools++;
      const r = reply(body);
      const id = `msg_${++n}`;
      const model = body.model ?? "claude-stand-in";
      if (!body.stream)
        return res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id,
            type: "message",
            role: "assistant",
            model,
            content: r.content,
            stop_reason: r.stop,
            stop_sequence: null,
            usage: { input_tokens: r.usage?.input_tokens ?? 10, output_tokens: 5 },
          }),
        );
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (type, data) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: r.usage?.input_tokens ?? 10, output_tokens: 1 },
        },
      });
      r.content.forEach((b, index) => {
        if (b.type === "text") {
          ev("content_block_start", { index, content_block: { type: "text", text: "" } });
          ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
        } else {
          ev("content_block_start", {
            index,
            content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
          });
          ev("content_block_delta", {
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
          });
        }
        ev("content_block_stop", { index });
      });
      ev("message_delta", {
        delta: { stop_reason: r.stop, stop_sequence: null },
        usage: { output_tokens: 5, ...(r.usage ? { input_tokens: r.usage.input_tokens } : {}) },
      });
      ev("message_stop", {});
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () =>
      resolve({ seen, close: () => new Promise((r) => server.close(() => r())) }),
    );
  });
}
