import { CHATGPT_LIMIT_CODE, CHATGPT_LIMIT_WAIT_MS } from "./index.ts";

/**
 * What OpenAI accepts from a ChatGPT sign-in (its "ChatGPT plan usage" preview), applied by the
 * harness's model proxy so every agent's requests fit, whatever program sends them: only the
 * Responses API (POST /responses) and the account's model list (GET /models), and for a teacher
 * the Codex CLI's own web search (POST /alpha/search, goal 232); each Responses request with
 * `store: false`, `stream: true` and its whole history in `input`; no system messages (the
 * developer role instead); none of the fields the route refuses. And how a full plan is told to
 * the Codex CLI (codexUsageLimit).
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

/** The Codex CLI's standalone web search, relative to the provider's base address (goal 232). */
export const CHATGPT_SEARCH_PATH = "alpha/search";

/** A path without its slashes at either end. */
export const chatgptPath = (path: string): string => path.replace(/^\/+|\/+$/g, "");

/**
 * Whether the route takes this call at all; `webSearch`: the caller may search the web through
 * the Codex CLI's own search (a teacher's call, goal 232).
 */
export function chatgptRouteAllowed(method: string, path: string, webSearch = false): boolean {
  const p = chatgptPath(path);
  return (
    (method === "POST" && p === "responses") ||
    (method === "GET" && p === "models") ||
    (webSearch && method === "POST" && p === CHATGPT_SEARCH_PATH)
  );
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

/**
 * A full ChatGPT plan, as the model proxy answers the Codex CLI (goal 169): OpenAI refuses with its
 * own code (CHATGPT_LIMIT_CODE) and no reset, which Codex 0.162.1 does not read as a usage limit,
 * so its turn would end with an error. Answered instead in the form Codex reads as its usage limit
 * (a 429 whose error is `usage_limit_reached`, with the seconds to its reset): Codex says "You've
 * hit your usage limit", its rollout records the limit, and its trial waits for the reset as the
 * other programs' do. The reset is the one the harness waits for a full plan, which gives none:
 * CHATGPT_LIMIT_WAIT_MS. Whoever runs the proxy still hears OpenAI's own answer.
 */
export function codexUsageLimit(): Response {
  const seconds = Math.round(CHATGPT_LIMIT_WAIT_MS / 1000);
  return Response.json(
    {
      error: {
        type: "usage_limit_reached",
        message: `The ChatGPT plan's usage is full (${CHATGPT_LIMIT_CODE}): try again in ${seconds / 60} minutes`,
        resets_in_seconds: seconds,
      },
    },
    { status: 429, headers: { "retry-after": String(seconds) } },
  );
}
