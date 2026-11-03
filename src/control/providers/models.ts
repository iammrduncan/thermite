import { CHATGPT_API } from "../../core/agents.ts";
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from "../../core/compaction.ts";
import type { ModelPrice } from "../../core/usage.ts";
import type { ProviderModel, ProviderType } from "../store/index.ts";

/**
 * A model provider's own model list, as other systems read it: an OpenAI-compatible provider's
 * GET {base}/models, or Anthropic's GET {base}/v1/models. Errors say what went wrong in a few
 * words and never carry the key.
 */

/** Anthropic's API, when its base URL is left empty. */
export const ANTHROPIC_BASE = "https://api.anthropic.com";
/** OpenCode's own models (its free ones need no key), when its base URL is left empty. */
export const OPENCODE_BASE = "https://opencode.ai/zen/v1";

/**
 * A Claude subscription's models, as the owner picks them (`claude-code:<id>`), and the name
 * Claude Code takes for each. The list is fixed here: control never calls Anthropic with a
 * subscription's token, because only Claude Code may use it. Opus 5.5 has its 1M-token window
 * already, so "[1m]" names the same model.
 */
export const CLAUDE_MODELS: { id: string; claude: string; context_window: number }[] = [
  { id: "opus-5.5", claude: "claude-opus-5-5", context_window: 1_000_000 },
  { id: "opus-5.5[1m]", claude: "claude-opus-5-5", context_window: 1_000_000 },
  { id: "sonnet-5.5", claude: "claude-sonnet-5-5", context_window: 1_000_000 },
  { id: "haiku-5.5", claude: "claude-haiku-5-5", context_window: 200_000 },
  { id: "fable-5.1", claude: "claude-fable-5-1", context_window: 1_000_000 },
];

/** Claude Code's name for a subscription model id (an unknown id passes as it is). */
export const claudeModelName = (id: string) => CLAUDE_MODELS.find((m) => m.id === id)?.claude ?? id;

/**
 * Whether the model a rig reports is the one control gave it. Claude Code reports a subscription's
 * model by its own name (`claude-sonnet-5-5` for `sonnet-5.5`), so either name counts.
 */
export const sameModel = (reported: string | null | undefined, given: string): boolean =>
  reported != null && (reported === given || reported === claudeModelName(given));

/**
 * A cap on the context window of a rig's model (goal 070): at least this many tokens, and at most
 * what a model route carries (a campaign's own window has the same limits).
 */
export const CONTEXT_CAP_MIN = CONTEXT_WINDOW_MIN;
export const CONTEXT_CAP_MAX = CONTEXT_WINDOW_MAX;

/** Tokens as people read them: 131,072. */
const tokens = (n: number) => n.toLocaleString("en-US");

/**
 * The context window a rig's route carries: the owner's cap when it is lower than the provider's
 * window, else the provider's. With no provider window (0: unknown), the cap as given.
 */
export const cappedWindow = (listed: number, cap: number | undefined): number =>
  cap && (listed <= 0 || cap < listed) ? cap : listed;

/** Why a cap is refused for a model whose provider lists `listed` tokens (0: unknown), if it is. */
export function contextCapRefusal(model: string, listed: number, cap: number): string | undefined {
  if (!Number.isInteger(cap) || cap < CONTEXT_CAP_MIN || cap > CONTEXT_CAP_MAX)
    return `A context window is a whole number of tokens from ${tokens(CONTEXT_CAP_MIN)} to ${tokens(CONTEXT_CAP_MAX)}.`;
  if (listed > 0 && cap > listed) return `${model} takes at most ${tokens(listed)} tokens.`;
  return undefined;
}

/**
 * A capped window in words, such as "131,072 tokens (capped; the provider allows 204,800)";
 * undefined when nothing caps the provider's window.
 */
export function capWords(listed: number, cap: number | undefined): string | undefined {
  const window = cappedWindow(listed, cap);
  if (!cap || window !== cap || cap === listed) return undefined;
  return `${tokens(cap)} tokens (capped; ${listed > 0 ? `the provider allows ${tokens(listed)}` : "the provider lists no window"})`;
}

/**
 * Whether a provider is OpenCode's own: its type says so, or its base URL is OpenCode's. Under
 * the OpenCode harness such a provider runs through OpenCode's built-in provider, which its free
 * models require (and which ignores any other endpoint, so no proxy can add a key to it).
 */
export function isOpencodeOwn(p: { type: ProviderType; base_url: string }): boolean {
  if (p.type === "opencode") return true;
  try {
    const u = new URL(p.base_url);
    return u.hostname === "opencode.ai" && u.pathname.startsWith("/zen");
  } catch {
    return false;
  }
}

/**
 * A provider's base URL as its API client takes it. A pasted endpoint URL is trimmed back to its
 * base: an OpenAI-compatible one loses /models or /chat/completions; Anthropic's has no /v1 (the
 * client adds it).
 */
export function providerBase(type: ProviderType, base: string): string {
  const b = base
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(models|chat\/completions|messages|completions)$/, "");
  if (type === "anthropic") return (b || ANTHROPIC_BASE).replace(/\/v1$/, "");
  // A Claude subscription has no endpoint of its own here: Claude Code knows where it goes.
  if (type === "claude") return ANTHROPIC_BASE;
  // A ChatGPT sign-in reaches only OpenAI's Responses API.
  if (type === "chatgpt") return CHATGPT_API;
  if (type === "opencode") return b || OPENCODE_BASE;
  return b;
}

/** A number from the first of these fields that has one: providers name the context differently. */
function contextOf(m: Record<string, unknown>): number | undefined {
  for (const k of ["context_length", "context_window", "max_context_length", "max_input_tokens"]) {
    const v = m[k];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  }
  const top = m.top_provider as Record<string, unknown> | undefined;
  const v = top?.context_length;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * A model's maximum output from its list entry (goal 079): the field each provider names it by.
 * Anthropic's list gives `max_tokens` (the output cap; `max_input_tokens` is its window);
 * OpenRouter's gives `top_provider.max_completion_tokens`; others `max_output_tokens`,
 * `max_completion_tokens` or `output_token_limit`. A list that names none gives none.
 */
export function outputOf(m: Record<string, unknown>, type: ProviderType): number | undefined {
  const num = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 10_000_000 ? v : undefined;
  for (const k of ["max_output_tokens", "max_completion_tokens", "output_token_limit"]) {
    const v = num(m[k]);
    if (v) return v;
  }
  if (type === "anthropic") {
    const v = num(m.max_tokens);
    if (v) return v;
  }
  return num((m.top_provider as Record<string, unknown> | undefined)?.max_completion_tokens);
}

/**
 * A model's price from its list entry (goal 075), in US dollars per million tokens: the `pricing`
 * object OpenRouter's list gives, as Nous Portal's does too, in US dollars per token, as text
 * (`prompt`, `completion`, `input_cache_read`). OpenAI's own list, Anthropic's and OpenCode Zen's
 * give none. A price that is not a number of 0 or more (OpenRouter's -1 for a router) is none.
 */
export function listedPrice(m: Record<string, unknown>): ModelPrice | undefined {
  const p = m.pricing as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return undefined;
  const perMillion = (v: unknown) => {
    const n =
      typeof v === "string" && v.trim() ? Number(v) : typeof v === "number" ? v : Number.NaN;
    return Number.isFinite(n) && n >= 0 && n < 1 ? Math.round(n * 1e12) / 1e6 : undefined;
  };
  const input = perMillion(p.prompt);
  const output = perMillion(p.completion);
  if (input === undefined || output === undefined) return undefined;
  return { input, cached_input: perMillion(p.input_cache_read) ?? null, output };
}

export async function listModels(
  type: ProviderType,
  base: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModel[] | { error: string }> {
  // A ChatGPT login is listed by its own code (control renews its token first).
  if (type === "chatgpt") return { error: "a ChatGPT subscription lists its models on its own" };
  // A Claude subscription's list is fixed: no call to Anthropic with its token.
  if (type === "claude")
    return CLAUDE_MODELS.map((m) => ({ id: m.id, context_window: m.context_window }));
  const root = providerBase(type, base);
  // OpenCode's own list needs no key (its free models need none).
  const headers: Record<string, string> =
    type === "anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : key
        ? { authorization: `Bearer ${key}` }
        : {};
  const out: ProviderModel[] = [];
  let after: string | undefined;
  // Anthropic pages its list; OpenAI-compatible providers answer in one.
  for (let page = 0; page < 20; page++) {
    const url =
      type === "anthropic"
        ? `${root}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`
        : `${root}/models`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      return {
        error:
          e.name === "TimeoutError"
            ? "could not list its models: no answer in 15 s"
            : `could not reach it to list its models${e.cause?.code ? ` (${e.cause.code})` : ""}`,
      };
    }
    if (!res.ok)
      return {
        error: `could not list its models: HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (is the key right?)" : res.status === 404 ? " (is the base URL right?)" : ""}`,
      };
    let body: { data?: unknown; has_more?: unknown; last_id?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { error: "could not list its models: the answer was not JSON" };
    }
    if (!Array.isArray(body.data))
      return { error: "could not list its models: the answer had no model list" };
    for (const m of body.data as Record<string, unknown>[]) {
      if (typeof m?.id !== "string" || !m.id || m.id.length > 200) continue;
      const price = listedPrice(m);
      const output = outputOf(m, type);
      out.push({
        id: m.id,
        context_window: contextOf(m),
        ...(price ? { price } : {}),
        ...(output ? { max_output: output } : {}),
      });
    }
    if (type !== "anthropic" || body.has_more !== true || typeof body.last_id !== "string") break;
    after = body.last_id;
  }
  const seen = new Set<string>();
  return out
    .filter((m) => !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
