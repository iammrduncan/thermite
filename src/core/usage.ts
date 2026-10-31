import { z } from "zod";
import { currentAgent } from "./names.ts";

/**
 * Model usage (goal 075): what each model call of a run's agents used, and the sums control shows.
 * Code records every call where it is made, never an agent: the harness for the workers and the
 * planner, the supervisor for the advisors. A record covers one call, or, where the harness says
 * no more, one run of its program (Claude Code's result, a Codex turn). A figure the harness does
 * not report is null ("not reported"), never 0. Each record is one `model_call` event of its run,
 * so it reaches control with the rig's other events and stays in the run's exports.
 */

/**
 * The agents a record names: `merged_by` is the teachers' merged by model, `review_panel` the
 * review panel (goal 074's names), `synthesizer` the writer of a research run's answer cards
 * (goal 117) and `final_writer` the writer of its paper (goal 112), each recorded under its own
 * name (goal 166), on its own model, else the first teacher's. Records from before v0.1.1 named the first two
 * `combiner` and `panel`; core/names.ts reads them under these names.
 */
export const USAGE_AGENTS = [
  "workers",
  "planner",
  "teachers",
  "merged_by",
  "auditor",
  "review_panel",
  "synthesizer",
  "final_writer",
] as const;
export const UsageAgent = z.enum(USAGE_AGENTS);
export type UsageAgent = z.infer<typeof UsageAgent>;

/** The agents in the supervisor: what the supervisor may record. */
export const ADVISOR_AGENTS = [
  "teachers",
  "merged_by",
  "auditor",
  "review_panel",
  "synthesizer",
  "final_writer",
] as const;
export const AdvisorAgent = z.enum(ADVISOR_AGENTS);
export type AdvisorAgent = z.infer<typeof AdvisorAgent>;

/** Each agent in words, as the pages and screens name it (goal 074). */
export const AGENT_WORDS: Record<UsageAgent, string> = {
  workers: "Workers",
  planner: "Planner",
  teachers: "Teachers",
  merged_by: "Teachers (merged by)",
  auditor: "Auditor",
  review_panel: "Review panel",
  synthesizer: "Synthesizer",
  final_writer: "Final writer",
};

/** The programs an agent's calls run in. */
export const USAGE_HARNESSES = ["pi", "opencode", "codex", "claude-code"] as const;
export const UsageHarness = z.enum(USAGE_HARNESSES);
export type UsageHarness = z.infer<typeof UsageHarness>;

const count = z.number().int().min(0).max(1e13);
/** A time in milliseconds, at most a week. */
const ms = z
  .number()
  .int()
  .min(0)
  .max(7 * 24 * 3_600_000);

/**
 * What a harness measured of one model call, or of one run of its program where it reports no
 * finer. Tokens in count every input token, cached or not; out counts every output token,
 * reasoning included.
 */
export const CallUsage = z
  .strictObject({
    /** The model calls it covers: 1 for one call; null when the harness does not say. */
    calls: z.number().int().min(1).max(1_000_000).nullable(),
    /** When it started (the request, or the program's run). */
    at: z.iso.datetime(),
    tokens_in: count,
    /** Input tokens read from the provider's cache; null: not reported. */
    cached_in: count.nullable(),
    /** Input tokens not read from the cache (tokens_in less cached_in); null with cached_in. */
    uncached_in: count.nullable(),
    tokens_out: count,
    /** Output tokens spent on reasoning (part of tokens_out); null: not reported. */
    reasoning: count.nullable(),
    /** From the request to the first token of its (first) call; null: not reported. */
    first_token_ms: ms.nullable(),
    /**
     * Its time in calls: from the request to the last token, summed over its calls; null: not
     * reported.
     */
    call_ms: ms.nullable(),
  })
  .refine(
    (u) =>
      u.cached_in === null
        ? u.uncached_in === null
        : u.cached_in <= u.tokens_in && u.uncached_in === u.tokens_in - u.cached_in,
    { message: "cached_in and uncached_in must add up to tokens_in" },
  )
  .refine((u) => u.reasoning === null || u.reasoning <= u.tokens_out, {
    message: "reasoning is part of tokens_out",
  });
export type CallUsage = z.infer<typeof CallUsage>;

/** Who made the calls, and where: what code adds to a harness's measure. */
export const CallContext = z.strictObject({
  trial: z.string().min(1).max(100).nullable(),
  /** The planner's round (`epoch <n>`), or an advisor's (`teachers <time>`, `audit <attempt>`, `review <id>`). */
  round: z.string().min(1).max(200).nullable(),
  agent: UsageAgent,
  harness: UsageHarness,
  /**
   * The provider's name in control's Providers; null: the rig's own settings, or an advisors file
   * that names none.
   */
  provider: z.string().min(1).max(100).nullable(),
  model: z.string().min(1).max(200),
});
export type CallContext = z.infer<typeof CallContext>;

/** One record: its run, its context and its measure. */
export type ModelCall = { run: string } & CallContext & CallUsage;

/** Where an agent's calls go: its harness, its provider (null: none named) and its model. */
export interface UsageRoute {
  harness: UsageHarness;
  provider: string | null;
  model: string;
}

/** The event kind of a record, whose subject is the run. */
export const MODEL_CALL_EVENT = "model_call";

/** A `model_call` event's body as control reads it (fields it does not know are left out). */
export const ModelCallBody = z.object({
  trial: z.string().max(100).nullable(),
  round: z.string().max(200).nullable(),
  // A record from before v0.1.1 names its agent as it was then (core/names.ts).
  agent: z.preprocess((a) => (typeof a === "string" ? currentAgent(a) : a), UsageAgent),
  harness: UsageHarness,
  provider: z.string().max(100).nullable(),
  model: z.string().min(1).max(200),
  calls: z.number().int().min(1).nullable(),
  at: z.iso.datetime(),
  tokens_in: count,
  cached_in: count.nullable(),
  uncached_in: count.nullable(),
  tokens_out: count,
  reasoning: count.nullable(),
  first_token_ms: ms.nullable(),
  call_ms: ms.nullable(),
});

const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const known = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? whole(n) : null;

/**
 * A harness's measure as a record: whole numbers, nothing below 0, cached input no more than the
 * input and the rest of it not cached, reasoning no more than the output, times under a week.
 */
export function callUsage(u: {
  at: number | string | Date;
  calls?: number | null | undefined;
  tokensIn: number;
  cachedIn?: number | null | undefined;
  tokensOut: number;
  reasoning?: number | null | undefined;
  firstTokenMs?: number | null | undefined;
  callMs?: number | null | undefined;
}): CallUsage {
  const tokensIn = whole(u.tokensIn);
  const tokensOut = whole(u.tokensOut);
  const cached = known(u.cachedIn);
  const reasoning = known(u.reasoning);
  const time = (n: number | null | undefined) => {
    const k = known(n);
    return k === null || k > 7 * 24 * 3_600_000 ? null : k;
  };
  const calls = known(u.calls);
  return {
    calls: calls === null || calls < 1 ? null : calls,
    at: new Date(u.at).toISOString(),
    tokens_in: tokensIn,
    cached_in: cached === null ? null : Math.min(cached, tokensIn),
    uncached_in: cached === null ? null : tokensIn - Math.min(cached, tokensIn),
    tokens_out: tokensOut,
    reasoning: reasoning === null ? null : Math.min(reasoning, tokensOut),
    first_token_ms: time(u.firstTokenMs),
    call_ms: time(u.callMs),
  };
}

// ------------------------------------------------------------------------------------ sums

/**
 * The periods the sums are read for: since midnight (UTC, or in a time zone the reader gives),
 * the last 7 days, or all.
 */
export const USAGE_PERIODS = ["today", "7d", "all"] as const;
export const UsagePeriod = z.enum(USAGE_PERIODS);
export type UsagePeriod = z.infer<typeof UsagePeriod>;

/** Whether this runtime knows a time zone by that name (an IANA name such as Europe/Paris, or UTC). */
export function knownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A time zone's wall clock less UTC at an instant, in milliseconds. */
function zoneOffset(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const part = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The midnight that starts the day an instant falls on, in a time zone, in milliseconds. The
 * offset at midnight is read again: it differs from the instant's on a day the clocks change.
 */
export function startOfDay(at: number, tz = "UTC"): number {
  const wall = new Date(at + zoneOffset(tz, at));
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const guess = midnight - zoneOffset(tz, at);
  return midnight - zoneOffset(tz, guess);
}

/** Where a period starts (ISO); null: all. Today starts at midnight in the time zone given. */
export function usageSince(period: UsagePeriod, now = new Date(), tz = "UTC"): string | null {
  if (period === "all") return null;
  if (period === "7d") return new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
  return new Date(startOfDay(now.getTime(), tz)).toISOString();
}

/** A model's price in US dollars per million tokens: input, cached input and output. */
export const ModelPrice = z.strictObject({
  input: z.number().min(0).max(1_000_000),
  /** The price of input read from the cache; null: the input price. */
  cached_input: z.number().min(0).max(1_000_000).nullable(),
  output: z.number().min(0).max(1_000_000),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/**
 * How a record is priced: at its model's price (from the provider's model list, or set by the
 * owner), on a subscription's plan, or with no price known. Never 0 for what is not known.
 */
export type Pricing =
  | { kind: "priced"; price: ModelPrice; source: "list" | "owner" }
  | { kind: "plan" }
  | { kind: "none" };

/** What a record's tokens cost at a price, in US dollars, by part. */
export function costOf(
  r: Pick<UsageRow, "tokens_in" | "cached_in" | "tokens_out">,
  p: ModelPrice,
): { input: number; cached_input: number; output: number } {
  const cached = r.cached_in ?? 0;
  return {
    input: ((r.tokens_in - cached) * p.input) / 1e6,
    cached_input: (cached * (p.cached_input ?? p.input)) / 1e6,
    output: (r.tokens_out * p.output) / 1e6,
  };
}

/**
 * A GPU cloud pod's spend, in US dollars, as control counted it while it followed the pod: the
 * spend since its last count, with the run its rig was running then (null: none), and its time.
 */
export interface PodSpendRow {
  rig: string;
  run: string | null;
  campaign: string | null;
  at: string;
  usd: number;
}

/** One record as the sums read it: the record, with its rig and its run's campaign. */
export interface UsageRow {
  rig: string;
  run: string;
  campaign: string | null;
  /** The worker's trial it was made in; null or none: not a trial's. */
  trial?: string | null | undefined;
  agent: string;
  harness: string;
  provider: string | null;
  model: string;
  calls: number | null;
  at: string;
  tokens_in: number;
  cached_in: number | null;
  tokens_out: number;
  reasoning: number | null;
  first_token_ms: number | null;
  call_ms: number | null;
  /** How it is priced (control resolves it); none given: no price known. */
  pricing?: Pricing | undefined;
}

/** The cost of some records, and of the pods their runs ran on, in US dollars. */
export interface UsageCost {
  /** The priced records' cost and the pods' spend; null when there is neither. */
  usd: number | null;
  /** The priced records' cost, by part: input not cached, cached input, output. */
  input_usd: number;
  cached_input_usd: number;
  output_usd: number;
  /** The GPU cloud pods' spend for these runs; null: none. */
  pod_usd: number | null;
  /** Records with a price, on a subscription's plan, and with no price known. */
  priced: number;
  on_plan: number;
  no_price: number;
  /** Priced records whose model is free: its price is 0 in every part. */
  free: number;
  /** The tokens, in and out, of the records on a plan, with no price, and free. */
  on_plan_tokens: number;
  no_price_tokens: number;
  free_tokens: number;
  /**
   * Input tokens priced as not cached because their records do not report the cache, where the
   * model's cached price differs from its input price.
   */
  priced_as_not_cached: number;
}

/** Whether a price is 0 in every part: a free model. */
export const isFree = (p: ModelPrice) =>
  p.input === 0 && p.output === 0 && (p.cached_input ?? 0) === 0;

/** The sums of some records. Each figure a record may not report says how many did not. */
export interface UsageSums {
  /** The records summed. */
  records: number;
  /** The model calls the records say they cover. */
  calls: number;
  /** Records that do not say how many calls they cover (a Codex turn). */
  calls_not_reported: number;
  tokens_in: number;
  /** Input tokens read from the cache, over the records that report it; null: none does. */
  cached_in: number | null;
  /** Input tokens not read from the cache, over the same records; null: none reports it. */
  uncached_in: number | null;
  /** cached_in over the input of the records that report it; null: none does. */
  cached_share: number | null;
  tokens_out: number;
  /** Reasoning tokens, over the records that report them; null: none does. */
  reasoning: number | null;
  /**
   * Output tokens a second: each record's output over its time in calls, for the records with a
   * time and some output; the median and the 10th and 90th percentiles. Null: none has a time.
   */
  out_per_s: { median: number; p10: number; p90: number } | null;
  /** Time in calls, in milliseconds, over the records that report it; null: none does. */
  call_ms: number | null;
  /** The median time to the first token, in milliseconds; null: none reports it. */
  first_token_ms: number | null;
  /** How many records do not report each figure. */
  not_reported: { cached: number; reasoning: number; time: number; first_token: number };
  cost: UsageCost;
}

/**
 * The q-quantile of sorted numbers, interpolating between the two nearest ranks (R's type 7, the
 * usual one): the median is q 0.5. Undefined for none.
 */
export function quantile(sorted: readonly number[], q: number): number | undefined {
  if (!sorted.length) return undefined;
  const h = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const a = sorted[lo] as number;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)] as number;
  return a + (h - lo) * (b - a);
}

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** The cost of some records at their prices, with the pods' spend. */
export function sumCost(rows: readonly UsageRow[], pods: readonly PodSpendRow[] = []): UsageCost {
  let input = 0;
  let cachedInput = 0;
  let output = 0;
  let priced = 0;
  let onPlan = 0;
  let free = 0;
  const tokens = { plan: 0, none: 0, free: 0 };
  let asNotCached = 0;
  for (const r of rows) {
    const p = r.pricing;
    const all = r.tokens_in + r.tokens_out;
    if (p?.kind === "plan") {
      onPlan++;
      tokens.plan += all;
    }
    if (p === undefined || p.kind === "none") tokens.none += all;
    if (p?.kind !== "priced") continue;
    priced++;
    if (isFree(p.price)) {
      free++;
      tokens.free += all;
    } else if (
      r.cached_in === null &&
      p.price.cached_input !== null &&
      p.price.cached_input !== p.price.input
    )
      asNotCached += r.tokens_in;
    const c = costOf(r, p.price);
    input += c.input;
    cachedInput += c.cached_input;
    output += c.output;
  }
  const pod = pods.reduce((n, x) => n + x.usd, 0);
  const usd = (n: number) => round(n, 6);
  return {
    usd: priced || pods.length ? usd(input + cachedInput + output + pod) : null,
    input_usd: usd(input),
    cached_input_usd: usd(cachedInput),
    output_usd: usd(output),
    pod_usd: pods.length ? usd(pod) : null,
    priced,
    on_plan: onPlan,
    no_price: rows.length - priced - onPlan,
    free,
    on_plan_tokens: tokens.plan,
    no_price_tokens: tokens.none,
    free_tokens: tokens.free,
    priced_as_not_cached: asNotCached,
  };
}

export function sumUsage(rows: readonly UsageRow[], pods: readonly PodSpendRow[] = []): UsageSums {
  let calls = 0;
  let callsNotReported = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cached = 0;
  let cachedOf = 0;
  let cachedRecords = 0;
  let reasoning = 0;
  let reasoningRecords = 0;
  let callMs = 0;
  let timed = 0;
  const speeds: number[] = [];
  const firsts: number[] = [];
  for (const r of rows) {
    if (r.calls === null) callsNotReported++;
    else calls += r.calls;
    tokensIn += r.tokens_in;
    tokensOut += r.tokens_out;
    if (r.cached_in !== null) {
      cached += r.cached_in;
      cachedOf += r.tokens_in;
      cachedRecords++;
    }
    if (r.reasoning !== null) {
      reasoning += r.reasoning;
      reasoningRecords++;
    }
    if (r.call_ms !== null) {
      callMs += r.call_ms;
      timed++;
      if (r.call_ms > 0 && r.tokens_out > 0) speeds.push(r.tokens_out / (r.call_ms / 1000));
    }
    if (r.first_token_ms !== null) firsts.push(r.first_token_ms);
  }
  speeds.sort((a, b) => a - b);
  firsts.sort((a, b) => a - b);
  const speed = (q: number) => round(quantile(speeds, q) as number, 1);
  return {
    records: rows.length,
    calls,
    calls_not_reported: callsNotReported,
    tokens_in: tokensIn,
    cached_in: cachedRecords ? cached : null,
    uncached_in: cachedRecords ? cachedOf - cached : null,
    cached_share: cachedRecords && cachedOf > 0 ? round(cached / cachedOf, 4) : null,
    tokens_out: tokensOut,
    reasoning: reasoningRecords ? reasoning : null,
    out_per_s: speeds.length ? { median: speed(0.5), p10: speed(0.1), p90: speed(0.9) } : null,
    call_ms: timed ? callMs : null,
    first_token_ms: firsts.length ? Math.round(quantile(firsts, 0.5) as number) : null,
    not_reported: {
      cached: rows.length - cachedRecords,
      reasoning: rows.length - reasoningRecords,
      time: rows.length - timed,
      first_token: rows.length - firsts.length,
    },
    cost: sumCost(rows, pods),
  };
}

/** Which records a report sums: a run, by its name alone (goal 170), a campaign's runs, or all. */
export type UsageScope =
  | { kind: "run"; run: string }
  | { kind: "campaign"; campaign: string }
  | { kind: "system" };

export interface UsageReport {
  scope: UsageScope;
  period: UsagePeriod;
  /** The time zone whose midnight starts today (an IANA name; UTC when the reader gives none). */
  tz: string;
  /** Where the period starts; null: all. */
  since: string | null;
  total: UsageSums;
  /** Each agent with records, in the agents' order. */
  by_agent: ({ agent: string; name: string } & UsageSums)[];
  /** Each model, by the harness it ran in and its provider, most tokens first. */
  by_model: ({ harness: string; provider: string | null; model: string } & UsageSums)[];
  /**
   * Each agent's calls to each model (by harness and provider), in the agents' order, then most
   * tokens first: the lines of a run page's table.
   */
  by_agent_model: ({
    agent: string;
    name: string;
    harness: string;
    provider: string | null;
    model: string;
  } & UsageSums)[];
  /** A campaign's runs, each with its share of the tokens (in and out), most first. */
  by_run?: ({ rig: string; run: string; share: number } & UsageSums)[] | undefined;
  /** The whole system's campaigns, each with its share of the tokens, most first. */
  by_campaign?: ({ campaign: string | null; share: number } & UsageSums)[] | undefined;
}

function groups<K>(
  rows: readonly UsageRow[],
  key: (r: UsageRow) => string,
  of: (r: UsageRow) => K,
) {
  const by = new Map<string, { key: K; rows: UsageRow[] }>();
  for (const r of rows) {
    const k = key(r);
    const g = by.get(k) ?? { key: of(r), rows: [] };
    g.rows.push(r);
    by.set(k, g);
  }
  return [...by.values()];
}

const tokensOf = (s: UsageSums) => s.tokens_in + s.tokens_out;

/**
 * The sums of some records, and of the pods their runs ran on, in total and by agent, model, run
 * (a campaign) or campaign (all). A pod's spend belongs to no agent or model.
 */
export function usageReport(
  rows: readonly UsageRow[],
  scope: UsageScope,
  period: UsagePeriod,
  since: string | null,
  pods: readonly PodSpendRow[] = [],
  tz = "UTC",
): UsageReport {
  const total = sumUsage(rows, pods);
  const share = (s: UsageSums) =>
    tokensOf(total) > 0 ? round(tokensOf(s) / tokensOf(total), 4) : 0;
  const order = (a: string) => {
    const i = (USAGE_AGENTS as readonly string[]).indexOf(a);
    return i < 0 ? USAGE_AGENTS.length : i;
  };
  const byAgent = groups(
    rows,
    (r) => r.agent,
    (r) => r.agent,
  )
    .sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key))
    .map((g) => ({
      agent: g.key,
      name: AGENT_WORDS[g.key as UsageAgent] ?? g.key,
      ...sumUsage(g.rows),
    }));
  const byModel = groups(
    rows,
    (r) => JSON.stringify([r.harness, r.provider, r.model]),
    (r) => ({ harness: r.harness, provider: r.provider, model: r.model }),
  )
    .map((g) => ({ ...g.key, ...sumUsage(g.rows) }))
    .sort((a, b) => tokensOf(b) - tokensOf(a) || a.model.localeCompare(b.model));
  const byAgentModel = groups(
    rows,
    (r) => JSON.stringify([r.agent, r.harness, r.provider, r.model]),
    (r) => ({
      agent: r.agent,
      name: AGENT_WORDS[r.agent as UsageAgent] ?? r.agent,
      harness: r.harness,
      provider: r.provider,
      model: r.model,
    }),
  )
    .map((g) => ({ ...g.key, ...sumUsage(g.rows) }))
    .sort(
      (a, b) =>
        order(a.agent) - order(b.agent) ||
        a.agent.localeCompare(b.agent) ||
        tokensOf(b) - tokensOf(a) ||
        a.model.localeCompare(b.model),
    );
  const report: UsageReport = {
    scope,
    period,
    tz,
    since,
    total,
    by_agent: byAgent,
    by_model: byModel,
    by_agent_model: byAgentModel,
  };
  if (scope.kind === "campaign") {
    const runKey = (x: { rig: string; run: string | null }) => JSON.stringify([x.rig, x.run]);
    const runs = new Map<string, { rig: string; run: string }>();
    for (const x of [...rows, ...pods])
      if (x.run !== null) runs.set(runKey(x), { rig: x.rig, run: x.run });
    report.by_run = [...runs.entries()]
      .map(([k, key]) => {
        const s = sumUsage(
          rows.filter((r) => runKey(r) === k),
          pods.filter((x) => runKey(x) === k),
        );
        return { ...key, share: share(s), ...s };
      })
      .sort((a, b) => tokensOf(b) - tokensOf(a) || a.run.localeCompare(b.run));
  }
  if (scope.kind === "system") {
    const campaigns = new Map<string, string | null>();
    for (const x of [...rows, ...pods])
      if (x.run !== null) campaigns.set(String(x.campaign), x.campaign);
    report.by_campaign = [...campaigns.entries()]
      .map(([k, campaign]) => {
        const s = sumUsage(
          rows.filter((r) => String(r.campaign) === k),
          pods.filter((x) => x.run !== null && String(x.campaign) === k),
        );
        return { campaign, share: share(s), ...s };
      })
      .sort(
        (a, b) => tokensOf(b) - tokensOf(a) || String(a.campaign).localeCompare(String(b.campaign)),
      );
  }
  return report;
}
