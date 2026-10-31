import { redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { ControlStore, ModelProvider } from "../store/index.ts";

/**
 * A subscription's usage windows (goal 151): how much of each is used and when it resets, for
 * Settings › Providers and the `providers` tool.
 *
 * - A Claude subscription: as Claude Code on a rig last reported them (its 5-hour and weekly
 *   windows). Control never calls Anthropic with the subscription's token.
 * - A ChatGPT subscription: control asks ChatGPT's usage endpoint, the one the Codex CLI reads for
 *   its own sign-in, with the subscription's access token, at most once in 5 minutes. It is not
 *   documented for apps: a refusal or an answer in another shape gives its reason, never an error.
 */

/** Where ChatGPT says how much of a plan is used. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** ChatGPT's own page with the plan's usage, for the owner. */
export const CHATGPT_USAGE_PAGE = "https://chatgpt.com/#settings/Usage";
const ASK_EVERY_MS = 5 * 60_000;
const WEEK_MIN = 7 * 24 * 60;

export interface PlanWindow {
  /** five_hour, seven_day (Claude) or primary, secondary (ChatGPT). */
  id: string;
  label: string;
  /** Its length, when known. */
  minutes: number | null;
  /** 0 to 100. */
  used_percent: number;
  /** When it resets (ISO), when known. */
  resets_at: string | null;
}

export interface PlanUsage {
  /** Claude Code on a rig, or OpenAI's answer to control. */
  source: "claude-code" | "openai";
  windows: PlanWindow[];
  /** The rig whose Claude Code reported them. */
  rig?: string | undefined;
  /** The plan's name, when OpenAI gives it. */
  plan?: string | null | undefined;
  /** When they were reported or asked (ISO). */
  at: string;
  /** Why there are none, in words. */
  error?: string | undefined;
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));
const label = (minutes: number | null) =>
  minutes === null
    ? "Window"
    : minutes >= 28 * 24 * 60
      ? "Monthly"
      : minutes >= WEEK_MIN
        ? "Weekly"
        : `${Math.round(minutes / 60)}-hour`;

/** A Claude subscription's windows, from the rigs' newest report of them; undefined: none yet. */
export function claudeUsage(
  name: string,
  rigs: { id: string; summary: unknown }[],
): PlanUsage | undefined {
  type W = { utilization?: unknown; resets_at?: unknown } | undefined;
  type R = { provider?: string; at?: string; five_hour?: W; seven_day?: W };
  let best: { r: R; rig: string } | undefined;
  for (const u of rigs) {
    const r = (u.summary as { subscription_usage?: R } | null)?.subscription_usage;
    if (r?.provider === name && r.at && (!best || r.at > (best.r.at ?? "")))
      best = { r, rig: u.id };
  }
  if (!best?.r.at) return undefined;
  const windows: PlanWindow[] = [];
  for (const [id, minutes, w] of [
    ["five_hour", 300, best.r.five_hour],
    ["seven_day", WEEK_MIN, best.r.seven_day],
  ] as const) {
    if (typeof w?.utilization === "number")
      windows.push({
        id,
        label: label(minutes),
        minutes,
        used_percent: clamp(w.utilization * 100),
        resets_at: typeof w.resets_at === "string" ? w.resets_at : null,
      });
  }
  return { source: "claude-code", windows, rig: best.rig, at: best.r.at };
}

/**
 * ChatGPT's answer: `rate_limit.primary_window` and `secondary_window`, each with `used_percent`,
 * `limit_window_seconds` and `reset_at` (seconds) or `reset_after_seconds`; also the Codex app
 * server's names (`primary`, `usedPercent`, `windowDurationMins`, `resetsAt`). Undefined: neither.
 */
export function chatgptWindows(
  body: unknown,
  now = Date.now(),
): { plan: string | null; windows: PlanWindow[] } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const rl = (b.rate_limit ?? b.rateLimits ?? b) as Record<string, unknown> | null;
  if (typeof rl !== "object" || rl === null) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const windows: PlanWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const w = (rl[`${id}_window`] ?? rl[id]) as Record<string, unknown> | null | undefined;
    const used = num(w?.used_percent) ?? num(w?.usedPercent);
    if (!w || used === undefined) continue;
    const seconds = num(w.limit_window_seconds);
    const minutes = seconds !== undefined ? seconds / 60 : (num(w.windowDurationMins) ?? null);
    const at = num(w.reset_at) ?? num(w.resetsAt);
    const after = num(w.reset_after_seconds);
    const resets =
      at !== undefined ? at * 1000 : after !== undefined ? now + after * 1000 : undefined;
    windows.push({
      id,
      label: label(minutes),
      minutes,
      used_percent: clamp(used),
      resets_at: resets !== undefined ? new Date(resets).toISOString() : null,
    });
  }
  const plan = b.plan_type ?? b.planType;
  return windows.length || "rate_limit" in b
    ? { plan: typeof plan === "string" ? plan : null, windows }
    : undefined;
}

/** Control's model providers as the `providers` tool gives them (never a key), with their usage. */
export function providersWithUsage(
  store: ControlStore,
  usage: ((p: ModelProvider) => Promise<PlanUsage | undefined>) | undefined,
) {
  return Promise.all(
    store.modelProviders.list().map(async (p) => ({
      name: p.name,
      type: p.type,
      base_url: redact(p.base_url),
      models: p.models.map((m) => m.id),
      models_at: p.models_at,
      models_error: p.models_error,
      usage: (await usage?.(p)) ?? null,
    })),
  );
}

/** Each subscription's usage: Claude's from the rigs' reports, ChatGPT's asked and kept 5 minutes. */
export class PlanUsageReader {
  private readonly kept = new Map<string, { at: number; value: Promise<PlanUsage> }>();
  private readonly store: ControlStore;
  private readonly askChatgpt: (p: ModelProvider) => Promise<PlanUsage>;
  private readonly now: () => number;

  constructor(
    store: ControlStore,
    askChatgpt: (p: ModelProvider) => Promise<PlanUsage>,
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.askChatgpt = askChatgpt;
    this.now = now;
  }

  /**
   * A subscription's usage, or undefined for another provider (or a Claude subscription no rig
   * reported yet). ChatGPT's is waited for `waitMs` at most; after that it is undefined this time,
   * and the answer is kept for the next read.
   */
  async of(p: ModelProvider, waitMs = 4000): Promise<PlanUsage | undefined> {
    if (p.type === "claude")
      return claudeUsage(
        p.name,
        this.store.reportedRigs.list().map((r) => ({ id: r.id, summary: r.summary })),
      );
    if (p.type !== "chatgpt") return undefined;
    let k = this.kept.get(p.name);
    if (!k || this.now() - k.at >= ASK_EVERY_MS) {
      const value = this.askChatgpt(p).catch(
        (err): PlanUsage => ({
          source: "openai",
          windows: [],
          at: new Date(this.now()).toISOString(),
          error: `could not ask OpenAI: ${errorText(err)}`,
        }),
      );
      k = { at: this.now(), value };
      this.kept.set(p.name, k);
    }
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), waitMs);
    });
    return Promise.race([k.value, late]).finally(() => clearTimeout(timer));
  }
}
