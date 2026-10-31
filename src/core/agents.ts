/**
 * The agents' words (goal 125, T1): where an agent runs, how hard its model thinks, and the kinds
 * of model provider, one list each for control, the harness and the supervisor; and which program
 * reaches which kind of provider (T7).
 */

/**
 * Where a rig's agents run: Pi, OpenCode v2, Claude Code (the only one a Claude subscription
 * allows) or the Codex CLI (a ChatGPT sign-in or an OpenAI-compatible key: OpenAI's Responses API).
 */
export const HARNESSES = ["pi", "opencode", "claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

/** How hard an agent's model thinks: Claude Code's levels (other providers take up to high). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * A model provider's kind; "claude" is a Claude subscription (its token from `claude setup-token`),
 * "chatgpt" a ChatGPT subscription (its login from Sign in with ChatGPT, renewed by control).
 */
export const PROVIDER_TYPES = ["openai", "anthropic", "opencode", "claude", "chatgpt"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** Where a ChatGPT sign-in's access token is used: OpenAI's Responses API (and its model list). */
export const CHATGPT_API = "https://api.openai.com/v1";

/** The kinds reached with an API key; the others are subscriptions, reached with a sign-in. */
export const KEY_PROVIDER_TYPES: readonly ProviderType[] = ["openai", "anthropic", "opencode"];
export const PLAN_PROVIDER_TYPES: readonly ProviderType[] = ["claude", "chatgpt"];

/**
 * Each kind of provider (goal 125, T7): the agent programs that reach it, and whether the
 * harness's model proxy carries its calls, adding the key so that none reaches an agent. A Claude
 * subscription runs only in Claude Code, which runs on nothing else; the Codex CLI speaks only
 * OpenAI's Responses API (an OpenAI-compatible provider or a ChatGPT sign-in); OpenCode's own
 * models need no key and run only in OpenCode.
 */
const ROUTES: Record<ProviderType, { programs: readonly Harness[]; proxy: boolean }> = {
  openai: { programs: ["pi", "opencode", "codex"], proxy: true },
  anthropic: { programs: ["pi", "opencode"], proxy: true },
  opencode: { programs: ["opencode"], proxy: false },
  claude: { programs: ["claude-code"], proxy: false },
  chatgpt: { programs: ["pi", "opencode", "codex"], proxy: true },
};

/** A provider's row; none named is an OpenAI-compatible one. */
const routeOf = (type: ProviderType | undefined) => ROUTES[type ?? "openai"];

/** Whether a program reaches a provider of this kind. */
export const reaches = (harness: Harness, type: ProviderType | undefined): boolean =>
  routeOf(type).programs.includes(harness);

/**
 * The one program that reaches a provider of this kind, when only one does: Claude Code for a
 * Claude subscription, OpenCode for OpenCode's own models.
 */
export function programForApi(type: ProviderType | undefined): Harness | undefined {
  const programs = routeOf(type).programs;
  return programs.length === 1 ? programs[0] : undefined;
}

/** Whether the harness's model proxy carries the calls to a provider of this kind. */
export const throughProxy = (type: ProviderType | undefined): boolean => routeOf(type).proxy;

/**
 * The program whose limit refuses a route that runs `harness` on a provider of this kind;
 * undefined when the program reaches it. That is the provider's one program when it reaches
 * nothing else (a Claude subscription and Claude Code go only together), else the route's own
 * (Codex on Anthropic's API, Claude Code on any provider but its subscription). Each caller says it
 * in its own words.
 */
export function routeRefusal(
  type: ProviderType | undefined,
  harness: Harness,
): Harness | undefined {
  if (reaches(harness, type)) return undefined;
  const only = programForApi(type);
  if (only && PROVIDER_TYPES.filter((t) => reaches(only, t)).length === 1) return only;
  return harness;
}

/** The advisors' roles, as messages, answers and field notes name them (goal 074's names). */
export const ADVISOR_ROLES = ["teachers", "auditor", "review_panel"] as const;
export type AdvisorRole = (typeof ADVISOR_ROLES)[number];

/**
 * How an owner's message reached a trial's agent, as its read receipt says (goal 169):
 * - `brief`: in the trial's first message;
 * - `next-call`: in Pi, as a turn of its own before the agent's next model call;
 * - `after-tool`: in Claude Code, Codex or OpenCode, inside the agent's turn, after the tool that
 *   ran: Claude Code's and Codex's PostToolUse hook, or Thermite's OpenCode plugin;
 * - `turn-end`: in Claude Code or Codex, at the end of the agent's turn: its Stop hook sends the
 *   agent on with the message;
 * - `continuation`: in Claude Code, Codex or OpenCode, in the prompt that continues the session
 *   after a run of the program ended.
 */
export const MESSAGE_HOW = [
  "brief",
  "next-call",
  "after-tool",
  "turn-end",
  "continuation",
] as const;
export type MessageHow = (typeof MESSAGE_HOW)[number];

/** Where a program's hook or plugin takes an owner's message inside the agent's turn. */
export const IN_TURN = ["after-tool", "turn-end"] as const satisfies readonly MessageHow[];
export type InTurn = (typeof IN_TURN)[number];
