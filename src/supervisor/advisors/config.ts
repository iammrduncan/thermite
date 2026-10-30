import { z } from "zod";
import { windowFit } from "../../agents/roles/index.ts";
import { LOCAL_HTTP_HOSTS, mcpUrlProblem } from "../../common/mcp-client.ts";
import { EFFORTS } from "../../core/agents.ts";
import {
  type AgentsContext,
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  contextApplied,
} from "../../core/compaction.ts";
import type { UsageRoute } from "../../core/usage.ts";

/**
 * The model provider's name, as control's Providers names it, for the advisors' model usage (goal
 * 075): a model control gives a role carries it. Optional in a file.
 */
const ProviderName = z.string().min(1).max(100).optional();

const Runtime = z.discriminatedUnion("runtime", [
  z.strictObject({
    name: z.string().min(1).max(60),
    runtime: z.literal("openai"),
    /**
     * The provider's API: Anthropic's Messages, a ChatGPT sign-in (OpenAI's Responses API, with
     * a one-hour access token from control), or OpenAI-compatible (the default).
     */
    api: z.enum(["openai", "anthropic", "chatgpt"]).optional(),
    base_url: z.url(),
    model: z.string().min(1),
    /** The key: a file (configured), or in memory (a route control gave the role). */
    api_key_file: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
    /** Sent as reasoning_effort when set. */
    reasoning: z.enum(["low", "medium", "high"]).optional(),
    context_window: z.number().int().positive().default(200_000),
    /**
     * The share of the window, in percent, at which the call's conversation is compacted and goes
     * on (goal 070). Unset: COMPACT_AT_DEFAULT.
     */
    compact_at: z.number().int().min(COMPACT_AT_MIN).max(COMPACT_AT_MAX).optional(),
    /** The most tokens one reply may take. Unset: none is sent; the provider's own applies (goal 079). */
    max_tokens: z.number().int().positive().optional(),
    /** The most model turns one call may take. Unset: none (goal 079). */
    max_turns: z.number().int().positive().max(100).optional(),
    /** Wall-clock limit for one call. Unset: none (goal 079). */
    timeout_s: z.number().int().positive().max(7200).optional(),
    /** Prices per million tokens, for the cost reported to control. */
    usd_per_mtok_in: z.number().nonnegative().default(0),
    usd_per_mtok_out: z.number().nonnegative().default(0),
    provider: ProviderName,
  }),
  z.strictObject({
    name: z.string().min(1).max(60),
    runtime: z.literal("cli"),
    /**
     * The command; the prompt goes to its stdin; its last JSON object is the answer. It runs as
     * the supervisor's user, which can read the supervisor's keys and tokens, so it must be
     * invoked with its own tool restrictions (no shell, no file access): `restricted: true`
     * states that the argv does that. Thermite cannot check another program's flags.
     */
    argv: z.array(z.string().min(1)).min(1),
    restricted: z.literal(true),
    /** Wall-clock limit for one call. Unset: none (goal 079). */
    timeout_s: z.number().int().positive().max(7200).optional(),
  }),
  z.strictObject({
    name: z.string().min(1).max(60),
    /** Claude Code with a Claude subscription's token (from control): no tools, no settings. */
    runtime: z.literal("claude-code"),
    model: z.string().min(1),
    token: z.string().min(1),
    effort: z.enum(EFFORTS).optional(),
    /**
     * The window Claude Code compacts within, in tokens, and its compaction point in percent
     * (goal 070): Claude Code's own settings. Unset: Claude Code's window, and COMPACT_AT_DEFAULT.
     */
    context_window: z.number().int().positive().optional(),
    compact_at: z.number().int().min(COMPACT_AT_MIN).max(COMPACT_AT_MAX).optional(),
    /** Wall-clock limit for one call. Unset: none (goal 079). */
    timeout_s: z.number().int().positive().max(7200).optional(),
    provider: ProviderName,
  }),
  z.strictObject({
    name: z.string().min(1).max(60),
    /**
     * OpenCode v2 (goal 073): none of its own tools, only the advisor's MCP tools; the provider
     * through a proxy for the call, which adds the key. OpenCode's own models need no key and no
     * base address.
     */
    runtime: z.literal("opencode"),
    api: z.enum(["openai", "anthropic", "chatgpt", "opencode"]).optional(),
    base_url: z.url().optional(),
    model: z.string().min(1),
    api_key_file: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
    /** The model's window in tokens, for OpenCode's own compaction; 0: unknown. */
    context_window: z.number().int().nonnegative().default(0),
    /**
     * The compaction point in percent (goal 070), as the workers' OpenCode gets it
     * (`compaction.buffer`: the window less the point). Unset: COMPACT_AT_DEFAULT.
     */
    compact_at: z.number().int().min(COMPACT_AT_MIN).max(COMPACT_AT_MAX).optional(),
    /** Wall-clock limit for one call. Unset: none (goal 079). */
    timeout_s: z.number().int().positive().max(7200).optional(),
    provider: ProviderName,
  }),
  z.strictObject({
    name: z.string().min(1).max(60),
    /**
     * The Codex CLI (goal 073): its read-only sandbox, none of its own tools, only the advisor's
     * MCP tools; OpenAI's Responses API only (a ChatGPT sign-in or an OpenAI-compatible
     * provider), through a proxy for the call, which adds the key.
     */
    runtime: z.literal("codex"),
    api: z.enum(["openai", "chatgpt"]).optional(),
    base_url: z.url(),
    model: z.string().min(1),
    api_key_file: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
    reasoning: z.enum(["low", "medium", "high"]).optional(),
    /** The model's window in tokens, for Codex's own compaction; 0: unknown. */
    context_window: z.number().int().nonnegative().default(0),
    /**
     * The compaction point in percent (goal 070), as the workers' Codex gets it
     * (`model_auto_compact_token_limit`). Unset: COMPACT_AT_DEFAULT.
     */
    compact_at: z.number().int().min(COMPACT_AT_MIN).max(COMPACT_AT_MAX).optional(),
    /** Wall-clock limit for one call. Unset: none (goal 079). */
    timeout_s: z.number().int().positive().max(7200).optional(),
    provider: ProviderName,
  }),
]);
export type AdvisorRuntime = z.infer<typeof Runtime>;

/**
 * Where an advisor's calls go, for its model usage (goal 075); none for a command-line agent,
 * which says nothing of them.
 */
export function advisorRoute(rt: AdvisorRuntime): UsageRoute | undefined {
  if (rt.runtime === "cli") return undefined;
  return {
    harness: rt.runtime === "openai" ? "pi" : rt.runtime,
    provider: rt.provider ?? null,
    model: rt.model,
  };
}

/**
 * One advisor of the rig's advisors file, as the supervisor reports it to control (goal 074), so
 * that Edit rig can say what an advisor with no model from control uses: where it runs, its model,
 * its provider's name and kind, its window and its compaction point. Never a key, a token, a key
 * file's path, a base address or a command line: none of them is read here. A value that holds
 * an address (`://`) is left out too, so that a model or provider name with credentials in it
 * never leaves the supervisor.
 */
export interface AdvisorSetup {
  /** Where it runs: pi (the `openai` runtime), claude-code, opencode, codex, or cli. */
  harness: "pi" | "claude-code" | "opencode" | "codex" | "cli";
  /** The model id; null for a command-line agent, which names none. */
  model: string | null;
  /** The provider's name, as the file gives it; null: none given. */
  provider: string | null;
  /** The provider's kind: its API (openai, anthropic, chatgpt, opencode), or claude. */
  api: string | null;
  /** The context window in tokens; null: none (the program's own, or unknown). */
  context_window: number | null;
  /** The compaction point in percent; null: the default (COMPACT_AT_DEFAULT). */
  compact_at: number | null;
}

/** What the advisors file sets up for each role; empty or null where it names none. */
export interface AdvisorsFileReport {
  teachers: AdvisorSetup[];
  merged_by: AdvisorSetup | null;
  auditor: AdvisorSetup | null;
  review_panel: AdvisorSetup[];
}

/** A short name the report may carry: no address, no control characters, at most 200 chars. */
const plainName = (v: string | undefined): string | null =>
  v &&
  v.length <= 200 &&
  !v.includes("://") &&
  ![...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
    ? v
    : null;

/** One advisor of the file, as the report gives it. */
export function advisorSetup(rt: AdvisorRuntime): AdvisorSetup {
  if (rt.runtime === "cli")
    return {
      harness: "cli",
      model: null,
      provider: null,
      api: null,
      context_window: null,
      compact_at: null,
    };
  const window = rt.context_window ?? 0;
  return {
    harness: rt.runtime === "openai" ? "pi" : rt.runtime,
    model: plainName(rt.model),
    provider: plainName(rt.provider),
    api: rt.runtime === "claude-code" ? "claude" : (rt.api ?? "openai"),
    context_window: window > 0 ? window : null,
    compact_at: rt.compact_at ?? null,
  };
}

/** What the rig's advisors file sets up, by role (no file: none). */
export function advisorsFileReport(file: AdvisorsConfig | undefined): AdvisorsFileReport {
  return {
    teachers: (file?.teachers ?? []).map(advisorSetup),
    merged_by: file?.merged_by ? advisorSetup(file.merged_by) : null,
    auditor: file?.auditor ? advisorSetup(file.auditor) : null,
    review_panel: (file?.review_panel ?? []).map(advisorSetup),
  };
}

/** Why the file's `kb` address is refused, in words. */
const KB_URL_REFUSED = `Use https, or http to this machine only (${LOCAL_HTTP_HOSTS.join(", ")}), with no user, password, fragment or secret in the address: the token goes in token_file.`;

/**
 * The advisors file's fields, with goal 074's names: one or two teachers, the model that merges
 * the advice of two (`merged_by`), the auditor and the review panel. AdvisorsConfig is what the
 * supervisor runs; AdvisorsFile is the file it reads, which may not hold a key or a token.
 */
export const AdvisorsConfig = z.strictObject({
  teachers: z.array(Runtime).max(2).default([]),
  merged_by: Runtime.optional(),
  auditor: Runtime.optional(),
  review_panel: z.array(Runtime).max(5).default([]),
  /** Minutes between teacher reviews of one run (hourly by default). */
  teacher_minutes: z.number().positive().default(60),
  /**
   * Domains advisors may fetch from (papers, upstream code). Empty: no web fetch. "*": any public
   * domain, and then no knowledge-base search in the same call, so private notes and an open
   * fetch never meet in one injected agent. The auditor fetches only from listed domains.
   */
  fetch_domains: z.array(z.string().min(1)).default([]),
  /**
   * Spending limit per day for all advisors of the rig (USD; from the runtimes' prices). None
   * unless the owner sets one: Thermite sets no limits of its own.
   */
  max_usd_per_day: z.number().nonnegative().optional(),
  /**
   * An optional knowledge-base MCP server the advisors may search (read only): https, or http to
   * this machine only (mcpUrlProblem's rule), with its token in a file, never in the address.
   */
  kb: z
    .strictObject({
      mcp_url: z.url().refine((url) => mcpUrlProblem(url) === null, KB_URL_REFUSED),
      token_file: z.string().min(1),
      tool: z.string().min(1).default("search"),
    })
    .optional(),
});
export type AdvisorsConfig = z.output<typeof AdvisorsConfig>;

/**
 * The fields that hold a key or a token, which the file on disk may not: each one's words say
 * where it comes from instead. In memory, control's models carry them.
 */
const NOT_IN_FILE = {
  api_key:
    "Write no key into the advisors file: name a file that holds it with api_key_file, or give the role a model on Edit rig, which control sends with its key.",
  token:
    "Write no token into the advisors file: a Claude subscription's token comes only from control. Give the role a Claude subscription on Edit rig.",
} as const;

/** Each runtime the raw file gives, with its path in the file. */
function runtimesIn(raw: unknown): [(string | number)[], Record<string, unknown>][] {
  if (!raw || typeof raw !== "object") return [];
  const file = raw as Record<string, unknown>;
  const out: [(string | number)[], Record<string, unknown>][] = [];
  const one = (path: (string | number)[], v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v))
      out.push([path, v as Record<string, unknown>]);
  };
  for (const role of ["teachers", "review_panel"] as const) {
    const list = file[role];
    if (Array.isArray(list)) for (const [i, v] of list.entries()) one([role, i], v);
  }
  for (const role of ["merged_by", "auditor"] as const) one([role], file[role]);
  return out;
}

/**
 * The advisors file as the supervisor reads it from disk: AdvisorsConfig, with no key or token
 * written into it. A `claude-code` runtime needs a token, so the file can't give one.
 */
export const AdvisorsFile = z.preprocess((raw, ctx) => {
  for (const [path, rt] of runtimesIn(raw))
    for (const field of ["api_key", "token"] as const)
      if (Object.hasOwn(rt, field) || (field === "token" && rt.runtime === "claude-code"))
        ctx.addIssue({ code: "custom", path: [...path, field], message: NOT_IN_FILE[field] });
  return raw;
}, AdvisorsConfig);

/**
 * What the supervisor runs: the advisors file, with the synthesizer's and the final writer's own
 * models when control gives them (goal 166). The file has no place for those two: with none of
 * its own, each uses the first teacher's model.
 */
export type RunningAdvisors = AdvisorsConfig & {
  synthesizer?: AdvisorRuntime | undefined;
  final_writer?: AdvisorRuntime | undefined;
};

/**
 * An advisor's window in tokens, where Thermite knows it: an API route's, the one control gives
 * Claude Code, or the one control or the advisors file gives OpenCode or Codex; 0 when unknown,
 * as for a command-line agent.
 */
export function advisorWindow(rt: AdvisorRuntime): number {
  return rt.runtime === "cli" ? 0 : (rt.context_window ?? 0);
}

/**
 * An advisor's runtime in a run of a campaign with its own context settings (the contract's
 * `agents_context`): the lower window (the campaign's when the runtime has none) and the
 * campaign's compaction point. A command-line agent has neither.
 */
export function withRunContext(
  rt: AdvisorRuntime,
  campaign: AgentsContext | undefined,
): AdvisorRuntime {
  if (!campaign || rt.runtime === "cli") return rt;
  const a = contextApplied(
    { contextWindow: advisorWindow(rt), compactAt: rt.compact_at },
    campaign,
  );
  return {
    ...rt,
    ...(a.contextWindow > 0 ? { context_window: a.contextWindow } : {}),
    ...(a.compactAt !== undefined ? { compact_at: a.compactAt } : {}),
  };
}

/**
 * The most characters of a one-call package (a brief, an audit's or a review's) that fit an
 * advisor's window: the compaction point less 30% of the window (half the window at the default
 * point), so the call has room to work before it compacts (windowFit, the same rule as a worker's
 * and a planner's first message). Undefined when the window is unknown.
 */
export function packageFit(rt: AdvisorRuntime): number | undefined {
  return windowFit(advisorWindow(rt), rt.runtime === "cli" ? undefined : rt.compact_at);
}
