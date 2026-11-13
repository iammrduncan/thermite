import { z } from "zod";
import {
  knownTimeZone,
  type ModelPrice,
  type PodSpendRow,
  type Pricing,
  UsagePeriod,
  type UsageReport,
  type UsageRow,
  type UsageScope,
  usageReport,
  usageSince,
  withConfigured,
} from "../core/usage.ts";
import { sameModel } from "./providers/index.ts";
import type { ControlStore } from "./store/index.ts";
import { configuredAgents } from "./usage-agents.ts";

/**
 * The agents' model usage as control sums it (goal 075): for one run, for a campaign (all its runs
 * on every rig) or for the whole system, over a period, with its cost. REST (`GET /v1/usage`) and
 * MCP (`model_usage`) give the same report.
 *
 * Cost: each record's tokens at its model's current price, the price taken from the provider's
 * model list when it gives one, else the one the owner set (`POST /v1/model-prices`, MCP's
 * `set_model_price`); a subscription's calls are on its plan; a model with no price known has
 * none, never 0. A GPU cloud pod's spend goes to the run its rig was running when control counted
 * it (every 30 seconds), so to that run's campaign; a pod's idle spend only to the system's.
 *
 * Today starts at midnight UTC, or in the time zone the reader gives (`tz`): the dashboard's
 * Metrics page gives the viewer's own.
 */

const TZ_WORDS = "The time zone is a name such as Europe/Paris, America/Chicago or UTC.";

/**
 * What a reader asks for: a run, by its name alone (goal 170), a campaign, or neither (the
 * system).
 */
export const UsageQuery = z
  .strictObject({
    run: z.string().trim().min(1).max(100).optional(),
    campaign: z.string().trim().min(1).max(200).optional(),
    period: UsagePeriod.default("all"),
    /** The time zone whose midnight starts today: an IANA name, such as Europe/Paris. */
    tz: z.string().trim().min(1).max(64).refine(knownTimeZone, { message: TZ_WORDS }).optional(),
  })
  .refine((q) => !(q.run && q.campaign), { message: "Give a run or a campaign, not both." });
export type UsageQuery = z.input<typeof UsageQuery>;

/** A query's problem in words, or undefined when it reads. */
export function usageQueryRefusal(raw: unknown): string | undefined {
  const q = UsageQuery.safeParse(raw);
  if (q.success) return undefined;
  const issue = q.error.issues[0];
  if (issue?.code === "unrecognized_keys")
    return `It takes run, campaign, period and tz, not ${issue.keys.join(", ")}.`;
  if (issue?.code === "custom") return issue.message;
  const field = String(issue?.path[0] ?? "");
  if (field === "period") return "The period is today, 7d or all.";
  if (field === "tz") return TZ_WORDS;
  return `A ${field} is 1 to ${field === "campaign" ? 200 : 100} characters.`;
}

/**
 * How control prices a record, from what it holds now: a subscription's (a Claude or ChatGPT
 * provider's, and every Claude Code call: Claude Code runs only on a subscription) are on its
 * plan; else the provider's listed price for the model, else the owner's; else none.
 */
export async function pricingOf(
  store: ControlStore,
): Promise<(provider: string | null, model: string, harness: string) => Pricing> {
  const providers = new Map((await store.modelProviders.list()).map((p) => [p.name, p]));
  const owner = new Map(
    (await store.usage.prices()).map((x) => [`${x.provider}\n${x.model}`, x.price]),
  );
  return (provider, model, harness) => {
    const p = provider ? providers.get(provider) : undefined;
    if (p?.type === "claude" || p?.type === "chatgpt" || harness === "claude-code")
      return { kind: "plan" };
    if (!p) return { kind: "none" };
    const listed = p.models.find((m) => m.id === model)?.price;
    if (listed) return { kind: "priced", price: listed, source: "list" };
    const set = owner.get(`${p.name}\n${model}`);
    return set ? { kind: "priced", price: set, source: "owner" } : { kind: "none" };
  };
}

/** The report for a query; a query that does not read throws its problem in words. */
export async function modelUsage(
  store: ControlStore,
  raw: unknown,
  now = new Date(),
): Promise<UsageReport> {
  return (await usageData(store, raw, now)).report;
}

/**
 * The report for a query, with the records it sums (each priced) and the pods' spend: what the
 * dashboard's screens draw their bars from. A query that does not read throws its problem.
 */
export async function usageData(
  store: ControlStore,
  raw: unknown,
  now = new Date(),
): Promise<{ report: UsageReport; rows: UsageRow[]; pods: PodSpendRow[] }> {
  const refused = usageQueryRefusal(raw);
  if (refused) throw new Error(refused);
  const q = UsageQuery.parse(raw);
  const scope: UsageScope = q.run
    ? { kind: "run", run: q.run }
    : q.campaign
      ? { kind: "campaign", campaign: q.campaign }
      : { kind: "system" };
  const tz = q.tz ?? "UTC";
  const since = usageSince(q.period, now, tz);
  const price = await pricingOf(store);
  const rows = (await store.usage.rows(scope, since)).map((r) => ({
    ...r,
    pricing: price(r.provider, r.model, r.harness),
  }));
  const pods = await store.usage.podSpend(scope, since);
  const report = usageReport(rows, scope, q.period, since, pods, tz);
  // One run over all its time (goal 193): a line for each agent its rig gives a model to, with
  // none of its records too. Not for part of its time: an agent may have worked before it.
  const rig = q.run && q.period === "all" ? (await store.runRegistry.rigsOf(q.run))[0] : undefined;
  return {
    report:
      rig && q.run
        ? withConfigured(report, await configuredAgents(store, rig, q.run), sameModel)
        : report,
    rows,
    pods,
  };
}

// --------------------------------------------------------------------------- prices

/** The owner's price for a provider's model, or its removal (`clear`). */
export const PriceRequest = z.strictObject({
  provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  input: z.number().min(0).max(1_000_000).optional(),
  cached_input: z.number().min(0).max(1_000_000).nullable().optional(),
  cache_write: z.number().min(0).max(1_000_000).nullable().optional(),
  output: z.number().min(0).max(1_000_000).optional(),
  clear: z.literal(true).optional(),
});
export type PriceRequest = z.infer<typeof PriceRequest>;

/** A provider model's price as model usage uses it, and where it comes from. */
export interface PriceView {
  provider: string;
  model: string;
  price: ModelPrice;
  source: "list" | "owner";
}

/** Every price model usage uses: the providers' listed ones, then the owner's. */
export async function modelPrices(store: ControlStore): Promise<PriceView[]> {
  const out: PriceView[] = [];
  for (const p of await store.modelProviders.list())
    for (const m of p.models)
      if (m.price) out.push({ provider: p.name, model: m.id, price: m.price, source: "list" });
  for (const x of await store.usage.prices())
    if (!out.some((o) => o.provider === x.provider && o.model === x.model))
      out.push({ provider: x.provider, model: x.model, price: x.price, source: "owner" });
  return out;
}

const dollars = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} USD`;

/**
 * Sets or clears the owner's price for a provider's model; refuses in words. The price counts for
 * every call of the model in model usage, the earlier ones too, until the provider lists one.
 */
export async function setModelPrice(
  store: ControlStore,
  raw: unknown,
  by: string,
): Promise<
  | {
      ok: true;
      answer: { provider: string; model: string; price: ModelPrice | null; said: string };
    }
  | { ok: false; status: 400 | 404 | 409; error: string }
> {
  const r = PriceRequest.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    return {
      ok: false,
      status: 400,
      error:
        issue?.code === "unrecognized_keys"
          ? `It takes provider, model, input, cached_input, cache_write, output and clear, not ${issue.keys.join(", ")}.`
          : `${String(issue?.path[0] ?? "the request")}: ${
              issue?.path[0] === "provider" || issue?.path[0] === "model"
                ? "a name, given"
                : "a number of US dollars per million tokens, 0 to 1,000,000"
            }.`,
    };
  }
  const q = r.data;
  const p = await store.modelProviders.get(q.provider);
  if (!p) return { ok: false, status: 404, error: `Providers has no provider ${q.provider}.` };
  if (p.type === "claude" || p.type === "chatgpt")
    return {
      ok: false,
      status: 409,
      error: `${p.name} is a subscription: its calls are on its plan, with no price per token.`,
    };
  const m = p.models.find((x) => x.id === q.model);
  if (!m)
    return {
      ok: false,
      status: 404,
      error: `${p.name} has no model ${q.model}: add it to the provider in Providers first.`,
    };
  if (m.price)
    return {
      ok: false,
      status: 409,
      error: `${p.name}'s model list gives ${q.model} its price, and model usage uses that one.`,
    };
  if (q.clear) {
    if (
      q.input !== undefined ||
      q.output !== undefined ||
      q.cached_input !== undefined ||
      q.cache_write !== undefined
    )
      return { ok: false, status: 400, error: "Give clear: true alone, or a price." };
    await store.usage.setPrice(p.name, q.model, null, by);
    return {
      ok: true,
      answer: {
        provider: p.name,
        model: q.model,
        price: null,
        said: `${q.model} of ${p.name} has no price now. Model usage shows its calls with no price.`,
      },
    };
  }
  if (q.input === undefined || q.output === undefined)
    return {
      ok: false,
      status: 400,
      error: "Give input and output, in US dollars per million tokens, or clear: true.",
    };
  const price: ModelPrice = {
    input: q.input,
    cached_input: q.cached_input ?? null,
    cache_write: q.cache_write ?? null,
    output: q.output,
  };
  const cached = price.cached_input === null ? "" : `, ${dollars(price.cached_input)} cached`;
  const write =
    price.cache_write === null || price.cache_write === undefined
      ? ""
      : `, ${dollars(price.cache_write)} a cache write`;
  await store.usage.setPrice(p.name, q.model, price, by);
  return {
    ok: true,
    answer: {
      provider: p.name,
      model: q.model,
      price,
      said: `${q.model} of ${p.name} costs ${dollars(price.input)} per million tokens in${cached}${write} and ${dollars(price.output)} out. Model usage prices all its calls at it.`,
    },
  };
}
