/**
 * What OpenAI accepts from a ChatGPT sign-in (its "ChatGPT plan usage" preview), applied by the
 * harness's model proxy so every agent's requests fit, whatever program sends them: only the
 * Responses API (POST /responses) and the account's model list (GET /models); each request with
 * `store: false`, `stream: true` and its whole history in `input`; no system messages (the
 * developer role instead); none of the fields the route refuses.
 */

/** Request fields the route refuses (OpenAI's preview limitations page). */
const REFUSED = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/** Whether the route takes this call at all. */
export function chatgptRouteAllowed(method: string, path: string): boolean {
  const p = path.replace(/^\/+|\/+$/g, "");
  return (method === "POST" && p === "responses") || (method === "GET" && p === "models");
}

/** A Responses request made to fit the route; an error when it is not a JSON object. */
export function chatgptRequest(body: Buffer): Buffer {
  let req: unknown;
  try {
    req = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("a Responses request must be JSON");
  }
  if (!req || typeof req !== "object" || Array.isArray(req))
    throw new Error("a Responses request must be a JSON object");
  const r = req as Record<string, unknown>;
  for (const k of REFUSED) delete r[k];
  r.store = false;
  r.stream = true;
  if (typeof r.input === "string") r.input = [{ role: "user", content: r.input }];
  if (Array.isArray(r.input))
    r.input = r.input.map((item: unknown) => {
      if (!item || typeof item !== "object") return item;
      const i = item as Record<string, unknown>;
      const message = i.type === undefined || i.type === "message";
      return message && i.role === "system" ? { ...i, role: "developer" } : i;
    });
  return Buffer.from(JSON.stringify(r));
}
