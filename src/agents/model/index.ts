import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { readNumber } from "../../common/settings.ts";
import {
  type Effort,
  HARNESSES,
  type Harness,
  PROVIDER_TYPES,
  type ProviderType,
  routeRefusal,
} from "../../core/agents.ts";
import { type AgentsContext, contextApplied } from "../../core/compaction.ts";
import { AGENTS_NUMBERS } from "../settings.ts";
import { logStall, modelStallMs, stallGuard } from "./stall.ts";

/**
 * The model client the harness's agents and the supervisor's advisors share: a route and its
 * settings, and the model Pi calls (this file); a silent stream broken off (stall.ts); one call
 * through a key-adding model proxy (forward.ts), kept to what a ChatGPT sign-in takes
 * (chatgpt.ts), with the tokens each answer reports (tokens.ts); when a provider said to try again
 * (retry.ts); and Pi's model usage (meter.ts).
 */

export {
  type ForwardCall,
  type ForwardStall,
  type ForwardTarget,
  forwardToProvider,
  type ProviderErrorAnswer,
} from "./forward.ts";
export { PiMeter, USAGE_BATCH, UsageSender } from "./meter.ts";
export { durationMs, type ProviderAnswer, retryAtFrom } from "./retry.ts";
export { logStall, modelStallMs, STALL_SETTING, stalledFor, stallWords } from "./stall.ts";
export { type AnswerTokens, TokensSeen } from "./tokens.ts";

/**
 * The harness's model route: an OpenAI-compatible endpoint (for example a LiteLLM or vLLM
 * gateway). Workers and the planner use only this; the model name comes from configuration
 * (THERMITE_MODEL), never from code.
 */

export type ReasoningEffort = "off" | "low" | "medium" | "high";

/** OpenAI's code when a ChatGPT plan's usage is full. Its reset time is not given. */
export const CHATGPT_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
/** How long agents wait before they try a full ChatGPT plan again (OpenAI gives no reset time). */
export const CHATGPT_LIMIT_WAIT_MS = 15 * 60_000;

/** When agents may try again after a provider's error, if it said a ChatGPT plan's usage is full. */
export function usageLimitRetry(error: string | undefined, now = Date.now()): string | undefined {
  return error?.includes(CHATGPT_LIMIT_CODE)
    ? new Date(now + CHATGPT_LIMIT_WAIT_MS).toISOString()
    : undefined;
}

export interface ModelConfig {
  /**
   * The provider's API: OpenAI-compatible chat completions (the default), Anthropic's Messages,
   * OpenCode's own models (only the OpenCode harness reaches those), a Claude subscription
   * (only Claude Code may use it; apiKey is then its token), or a ChatGPT sign-in (OpenAI's
   * Responses API; apiKey is then a one-hour access token that control renews).
   */
  api?: ProviderType | undefined;
  /**
   * The harness the agents run in: Pi, in-process (the default), OpenCode v2, Claude Code or the
   * Codex CLI (OpenAI's Responses API only: a ChatGPT sign-in or an OpenAI-compatible route).
   */
  harness?: Harness | undefined;
  /**
   * The provider's name in control's Providers, for the agents' model usage (goal 075). None: the
   * rig's own settings, which name no provider.
   */
  provider?: string | undefined;
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: number;
  /**
   * The most tokens one reply may take (goal 079): the model's maximum output from the provider's
   * model list. 0: unknown, and none is sent; the provider's own applies. Anthropic's API needs
   * one: there, ANTHROPIC_UNKNOWN_MAX_TOKENS.
   */
  maxTokens: number;
  /**
   * The compaction point (goal 070): the share of `contextWindow`, in percent, at which an agent's
   * conversation is compacted and goes on. Unset: COMPACT_AT_DEFAULT. Never a cap.
   */
  compactAt?: number | undefined;
  /**
   * Sent as `reasoning_effort` ("off" sends "none"). Unset: nothing is sent and the server's
   * default applies. Thinking tokens count toward `maxTokens` on servers that think by default.
   */
  reasoning?: ReasoningEffort | undefined;
  /** Claude Code's effort level, for a Claude subscription (--effort). */
  effort?: Effort | undefined;
  /** The key at the time of each call, when it is renewed while the route stays (a ChatGPT sign-in). */
  keyNow?: (() => string) | undefined;
}

export function reasoningFromEnv(raw: string | undefined): ReasoningEffort | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "none" || raw === "off") return "off";
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new Error(`THERMITE_MODEL_REASONING_EFFORT must be none, low, medium or high, not ${raw}`);
}

/**
 * An agent's model in a run of a campaign with its own context settings (the contract's
 * `agents_context`, goal 070): the lower of the route's window and the campaign's (the
 * campaign's as given when the route lists none), and the campaign's compaction point over the
 * route's. Without campaign settings, or without a model, the same as given.
 */
export function withAgentsContext(
  m: ModelConfig | undefined,
  campaign: AgentsContext | undefined,
): ModelConfig | undefined {
  if (!m || !campaign) return m;
  const a = contextApplied(m, campaign);
  return {
    ...m,
    contextWindow: a.contextWindow,
    ...(a.compactAt !== undefined ? { compactAt: a.compactAt } : {}),
  };
}

/** A compaction point from the environment: unset, or a whole percent in range. */
export function compactAtFromEnv(raw: string | undefined): number | undefined {
  return readNumber({ THERMITE_MODEL_COMPACT_AT: raw }, AGENTS_NUMBERS.compactAt);
}

/**
 * The model route's settings, by their names: THERMITE_MODEL_* (BASE_URL, the model's name as
 * THERMITE_MODEL, API_KEY, CONTEXT_WINDOW, COMPACT_AT, MAX_TOKENS, REASONING_EFFORT, API) and the
 * agents' harness, THERMITE_AGENT_HARNESS.
 */
export const MODEL_SETTINGS = {
  baseUrl: "THERMITE_MODEL_BASE_URL",
  model: "THERMITE_MODEL",
  apiKey: "THERMITE_MODEL_API_KEY",
  contextWindow: "THERMITE_MODEL_CONTEXT_WINDOW",
  compactAt: "THERMITE_MODEL_COMPACT_AT",
  maxTokens: "THERMITE_MODEL_MAX_TOKENS",
  reasoning: "THERMITE_MODEL_REASONING_EFFORT",
  api: "THERMITE_MODEL_API",
  harness: "THERMITE_AGENT_HARNESS",
} as const;

/** Every variable name the model route is read from. */
export const MODEL_ENV_NAMES: string[] = Object.values(MODEL_SETTINGS);

/** A setting's value; empty counts as not set. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig | undefined {
  const baseUrl = setting(env, MODEL_SETTINGS.baseUrl);
  const model = setting(env, MODEL_SETTINGS.model);
  const apiKey = setting(env, MODEL_SETTINGS.apiKey);
  if (!baseUrl || !model || !apiKey) return undefined;
  const rawApi = setting(env, MODEL_SETTINGS.api);
  const api = PROVIDER_TYPES.find((t) => t === rawApi);
  if (rawApi !== undefined && !api)
    throw new Error(
      `THERMITE_MODEL_API must be openai, anthropic, opencode, claude or chatgpt, not ${rawApi}`,
    );
  const rawHarness = setting(env, MODEL_SETTINGS.harness);
  const harness = HARNESSES.find((h) => h === rawHarness);
  if (rawHarness !== undefined && !harness)
    throw new Error(
      `THERMITE_AGENT_HARNESS must be pi, opencode, claude-code or codex, not ${rawHarness}`,
    );
  // A Claude subscription runs only in Claude Code, and Claude Code only on one; the Codex CLI
  // speaks only OpenAI's Responses API. A Pi route of OpenCode's own models is taken: its planner
  // calls go to OpenCode, and its research trials say why they cannot run.
  const refused = routeRefusal(api, harness ?? "pi");
  if (refused === "claude-code")
    throw new Error(
      "a Claude subscription (THERMITE_MODEL_API=claude) runs only with THERMITE_AGENT_HARNESS=claude-code, and that harness only with it",
    );
  if (refused === "codex")
    throw new Error(
      "the Codex CLI speaks only OpenAI's Responses API: THERMITE_AGENT_HARNESS=codex needs THERMITE_MODEL_API chatgpt or openai",
    );
  return {
    // An OpenAI-compatible route and Pi are the defaults, left unnamed.
    api: api === "openai" ? undefined : api,
    harness: harness === "pi" ? undefined : harness,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    apiKey,
    // The model's per-request context. Unset is "unknown" (0): replies are then not clamped to an
    // estimate of the room left, because a wrong guess (it was 131072) shrinks every reply to one
    // token once a conversation nears it.
    contextWindow: readNumber(env, AGENTS_NUMBERS.contextWindow),
    compactAt: compactAtFromEnv(setting(env, MODEL_SETTINGS.compactAt)),
    // Unset: 0, none is sent and the provider's own limit applies (goal 079).
    maxTokens: readNumber(env, AGENTS_NUMBERS.maxTokens),
    reasoning: reasoningFromEnv(setting(env, MODEL_SETTINGS.reasoning)),
  };
}

/** A route as a worker's environment (THERMITE_MODEL_*), for a worker started on it. */
export function modelEnv(cfg: ModelConfig): Record<string, string> {
  return {
    ...(cfg.api && cfg.api !== "openai" ? { THERMITE_MODEL_API: cfg.api } : {}),
    ...(cfg.harness && cfg.harness !== "pi" ? { THERMITE_AGENT_HARNESS: cfg.harness } : {}),
    THERMITE_MODEL_BASE_URL: cfg.baseUrl,
    THERMITE_MODEL: cfg.model,
    THERMITE_MODEL_API_KEY: cfg.apiKey,
    THERMITE_MODEL_CONTEXT_WINDOW: String(cfg.contextWindow),
    ...(cfg.compactAt !== undefined ? { THERMITE_MODEL_COMPACT_AT: String(cfg.compactAt) } : {}),
    THERMITE_MODEL_MAX_TOKENS: String(cfg.maxTokens),
    ...(cfg.reasoning !== undefined
      ? { THERMITE_MODEL_REASONING_EFFORT: cfg.reasoning === "off" ? "none" : cfg.reasoning }
      : {}),
  };
}

/**
 * The reply limit Anthropic's Messages API gets for a model whose maximum output the provider's
 * list does not give (goal 079): that API refuses a request without one.
 */
export const ANTHROPIC_UNKNOWN_MAX_TOKENS = 32_000;

/**
 * pi-ai's figure for a reply limit that is not known: large, and never sent (uncapped below takes
 * it out of each request).
 */
const NOT_SENT = 1_000_000_000;

/** pi-ai's models, with each request's reply limit left out (none known: the provider's applies). */
function uncapped<T extends ReturnType<typeof createModels>>(models: T): T {
  const strip = (p: unknown) => {
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      delete o.max_tokens;
      delete o.max_completion_tokens;
      delete o.max_output_tokens;
    }
    return p;
  };
  type Options = { onPayload?: (p: unknown, m: unknown) => unknown } | undefined;
  const wrap = (o: Options) => ({
    ...o,
    onPayload: async (p: unknown, m: unknown) => strip((await o?.onPayload?.(p, m)) ?? p),
  });
  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple" || key === "completeSimple") {
        const f = Reflect.get(target, key) as (m: unknown, c: unknown, o: Options) => unknown;
        return (m: unknown, c: unknown, o: Options) => f.call(target, m, c, wrap(o));
      }
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * pi-ai's models, with every call's stream watched for silence (goal 079): a call that sends no
 * data for THERMITE_MODEL_STALL_SECONDS is broken off as the provider's `server` error
 * (stall.ts). It wraps whatever fetch the call was given: a trial's watch and meter, or
 * none. Every Pi call goes through buildModel: workers, research workers, the planner, the
 * compactions' summaries, the model checks and the supervisor's advisors.
 */
function stallGuarded<T extends ReturnType<typeof createModels>>(models: T): T {
  const ms = modelStallMs();
  if (ms === undefined) return models;
  type Options = { fetch?: typeof globalThis.fetch } | undefined;
  const guard = (o: Options) => ({
    ...o,
    fetch: stallGuard(o?.fetch ?? globalThis.fetch, ms, (n) => logStall(n)),
  });
  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple" || key === "completeSimple") {
        const f = Reflect.get(target, key) as (m: unknown, c: unknown, o: Options) => unknown;
        return (m: unknown, c: unknown, o: Options) => f.call(target, m, c, guard(o));
      }
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export function buildModel(cfg: ModelConfig) {
  const built = buildUnguarded(cfg);
  return { ...built, models: stallGuarded(built.models) };
}

function buildUnguarded(cfg: ModelConfig) {
  if (cfg.api === "anthropic") return buildAnthropic(cfg);
  if (cfg.api === "chatgpt") return buildChatGPT(cfg);
  const provider = "thermite-openai";
  const model: Model<"openai-completions"> = {
    id: cfg.model,
    name: cfg.model,
    api: "openai-completions",
    provider,
    baseUrl: cfg.baseUrl,
    reasoning: cfg.reasoning !== undefined,
    ...(cfg.reasoning !== undefined ? { thinkingLevelMap: { off: "none" } } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens || NOT_SENT,
    // LiteLLM and vLLM-style servers: no `store`, no `developer` role; reasoning_effort only
    // when configured.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: cfg.reasoning !== undefined,
      maxTokensField: "max_tokens",
    },
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider,
      name: "Harness model route",
      baseUrl: cfg.baseUrl,
      auth: {
        apiKey: {
          name: "Model route key",
          resolve: async () => ({ auth: { apiKey: cfg.apiKey } }),
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  const resolved = models.getModel(provider, cfg.model);
  if (!resolved) throw new Error(`model ${cfg.model} did not register`);
  // The agents' thinking level: "off" sends reasoning_effort "none" when reasoning is configured.
  // With no known reply limit, none is sent (goal 079).
  return {
    models: cfg.maxTokens ? models : uncapped(models),
    model: resolved,
    thinkingLevel: cfg.reasoning ?? ("off" as const),
  };
}

/** An Anthropic route: the Messages API; its base URL has no /v1 (the client adds it). */
function buildAnthropic(cfg: ModelConfig) {
  const provider = "thermite-anthropic";
  const model: Model<"anthropic-messages"> = {
    id: cfg.model,
    name: cfg.model,
    api: "anthropic-messages",
    provider,
    baseUrl: cfg.baseUrl,
    reasoning: cfg.reasoning !== undefined && cfg.reasoning !== "off",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    // Anthropic's API needs a reply limit: the model's maximum output when the provider's list
    // gives one, else ANTHROPIC_UNKNOWN_MAX_TOKENS (goal 079).
    maxTokens: cfg.maxTokens || ANTHROPIC_UNKNOWN_MAX_TOKENS,
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider,
      name: "Harness model route",
      baseUrl: cfg.baseUrl,
      auth: {
        apiKey: {
          name: "Model route key",
          resolve: async () => ({ auth: { apiKey: cfg.apiKey } }),
        },
      },
      models: [model],
      api: anthropicMessagesApi(),
    }),
  );
  const resolved = models.getModel(provider, cfg.model);
  if (!resolved) throw new Error(`model ${cfg.model} did not register`);
  return { models, model: resolved, thinkingLevel: cfg.reasoning ?? ("off" as const) };
}

/**
 * A ChatGPT sign-in: OpenAI's Responses API, as pi-ai's own "openai" provider sends it. Direct to
 * OpenAI, pi-ai leaves out the fields this route refuses (it knows the access token from an API
 * key); through the harness's proxy, the proxy does. Its models reason: the instructions go as a
 * developer message, which the route takes (it refuses system messages), and no reasoning effort
 * is sent unless one is set. The key is read at each call, because control renews it hourly.
 */
function buildChatGPT(cfg: ModelConfig) {
  const provider = "openai";
  const model: Model<"openai-responses"> = {
    id: cfg.model,
    name: cfg.model,
    api: "openai-responses",
    provider,
    baseUrl: cfg.baseUrl,
    reasoning: true,
    thinkingLevelMap: { off: cfg.reasoning === "off" ? "none" : null },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    // This route sends no reply limit (supportsMaxOutputTokens is off).
    maxTokens: cfg.maxTokens || NOT_SENT,
    compat: { supportsMaxOutputTokens: false, supportsLongCacheRetention: false },
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: provider,
      name: "ChatGPT sign-in",
      baseUrl: cfg.baseUrl,
      auth: {
        apiKey: {
          name: "ChatGPT access token",
          resolve: async () => ({ auth: { apiKey: cfg.keyNow?.() ?? cfg.apiKey } }),
        },
      },
      models: [model],
      api: openAIResponsesApi(),
    }),
  );
  const resolved = models.getModel(provider, cfg.model);
  if (!resolved) throw new Error(`model ${cfg.model} did not register`);
  return { models, model: resolved, thinkingLevel: cfg.reasoning ?? ("off" as const) };
}
