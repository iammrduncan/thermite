import { z } from "zod";

/**
 * What a Gemini API call costs, as control counts it for the spend cap (index.ts): a dated table of
 * Google's published prices, the worst case of a call before it is sent, and its cost from the
 * usage Google reported. Money is whole micro-dollars (a millionth of a US dollar), rounded up: a
 * price in US dollars per million tokens times a number of tokens is micro-dollars.
 *
 * A model the table does not hold has no price and is refused. The owner's settings may raise a
 * price, never lower it: a lower price would understate the spend the cap counts.
 */

/** Where the table's prices were read, and the day they were read (UTC). */
export const GEMINI_PRICE_SOURCE = "https://aistudio.google.com/docs/pricing";
export const GEMINI_PRICE_CHECKED = "2026-11-16";

/**
 * How many days the prices count after they were last checked: by the table's own date, or by
 * the owner's later review of them against Google's page. After that no call is sent until the
 * owner reviews them again: an old table is no evidence of today's bill.
 */
export const GEMINI_PRICE_VALID_DAYS = 30;

/** US dollars per million tokens: input, output (thinking included) and input read from the cache. */
export interface GeminiRates {
  input: number;
  output: number;
  cached: number;
}

/** A model's prices from a day on (UTC), with the prices of a prompt over `long.above` tokens. */
interface TariffStep {
  /** The first day (YYYY-MM-DD) Google's page gives these prices for. */
  from: string;
  rates: GeminiRates;
  long?: { above: number; rates: GeminiRates };
}

const flat = (from: string, input: number, output: number, cached: number): TariffStep => ({
  from,
  rates: { input, output, cached },
});

/**
 * The Standard paid tier's text prices of the models the page lists without a pending change of
 * model: `gemini-2.5-pro` and `gemini-2.5-flash` are left out, since Google's page says their
 * requests go to other models, at those models' prices, from 1 December 2026. The Batch, Flex and
 * Priority tiers, audio and image input, explicit caches and Google's own tools have other prices:
 * the bridge accepts none of them (core GoogleGenerateBody).
 */
const TARIFFS: Readonly<Record<string, readonly TariffStep[]>> = {
  "gemini-4-carbon": [flat("2026-01-01", 2, 10, 0.1), flat("2026-12-01", 4, 20, 0.2)],
  "gemini-4-argon": [flat("2026-01-01", 2, 10, 0.1), flat("2026-12-01", 4, 20, 0.2)],
  "gemini-4-hydrogen": [flat("2026-01-01", 1.5, 7.5, 0.075)],
  "gemini-3.8-flash": [flat("2026-01-01", 0.75, 3.75, 0.075), flat("2027-01-01", 1.5, 7.5, 0.15)],
  "gemini-3.6-flash": [flat("2026-01-01", 0.75, 3.75, 0.075), flat("2027-01-01", 1.5, 7.5, 0.15)],
  "gemini-3.5-flash-lite": [flat("2026-01-01", 0.3, 2.5, 0.03)],
  "gemini-3.1-flash-lite": [flat("2026-01-01", 0.25, 1.5, 0.025)],
  "gemini-3.1-pro-preview": [
    {
      from: "2026-01-01",
      rates: { input: 2, output: 12, cached: 0.2 },
      long: { above: 200_000, rates: { input: 4, output: 18, cached: 0.4 } },
    },
  ],
  "gemini-3-flash-preview": [flat("2026-01-01", 0.5, 3, 0.05)],
  "gemini-2.5-flash-lite": [flat("2026-01-01", 0.1, 0.4, 0.01)],
};

/** The models the table prices, in its order. */
export const GEMINI_PRICED_MODELS: readonly string[] = Object.keys(TARIFFS);

/**
 * The most output tokens, thinking included, one streamed request returns on any model of the
 * table (Google's per-request cap). Control sends every call a limit at or under it, so a call's
 * output is bounded before it is sent.
 */
export const GEMINI_OUTPUT_CEILING = 65_536;

/**
 * Tokens added to a call's size in bytes for its worst-case input: what Google may add around the
 * request's own text. A token is at least one byte of the request, so its bytes bound its tokens.
 */
export const GEMINI_INPUT_ALLOWANCE = 8192;

/** A dated price counts a day before and a day after its date: no time zone's reading comes first. */
const DAY_MS = 24 * 3_600_000;

/**
 * The moment (ms) until which the prices count: GEMINI_PRICE_VALID_DAYS after the later of the
 * table's own date and the owner's review, a day (YYYY-MM-DD, UTC). A review that is unreadable,
 * or dated after `now`, counts for nothing.
 */
export function geminiPricesValidUntil(reviewed: string | undefined, now: Date): number {
  let from = Date.parse(`${GEMINI_PRICE_CHECKED}T00:00:00Z`);
  if (reviewed !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(reviewed)) {
    const at = Date.parse(`${reviewed}T00:00:00Z`);
    if (Number.isFinite(at) && at <= now.getTime() && at > from) from = at;
  }
  return from + GEMINI_PRICE_VALID_DAYS * DAY_MS;
}

/** Whether the prices still count at `now`; never for a clock that gives no time. */
export function geminiPricesFresh(reviewed: string | undefined, now: Date): boolean {
  const at = now.getTime();
  return Number.isFinite(at) && at < geminiPricesValidUntil(reviewed, now);
}

const price = z.number().finite().min(0).max(1_000_000);
/** The owner's raised prices, by model: each figure counts only where it is above the table's. */
export const GeminiPriceOverrides = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/),
  z.strictObject({ input: price, output: price, cached: price }),
);
export type GeminiPriceOverrides = z.infer<typeof GeminiPriceOverrides>;

/** A model's prices at one time: for a prompt up to `long.above` tokens, and for a longer one. */
export interface GeminiTariff {
  rates: GeminiRates;
  long?: { above: number; rates: GeminiRates } | undefined;
}

const higher = (a: GeminiRates, b: GeminiRates): GeminiRates => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  cached: Math.max(a.cached, b.cached),
});

/** The step in effect at `at` (ms): the last one whose day has begun in UTC; else the first. */
function stepAt(steps: readonly TariffStep[], at: number): TariffStep | undefined {
  let found = steps[0];
  for (const s of steps) if (Date.parse(`${s.from}T00:00:00Z`) <= at) found = s;
  return found;
}

/**
 * A model's prices at `now`, or undefined for a model the table does not hold. Each figure is the
 * highest of the table's a day before, now and a day after, and of the owner's raised price.
 */
export function geminiTariff(
  model: string,
  now: Date,
  overrides: GeminiPriceOverrides = {},
): GeminiTariff | undefined {
  // An own entry only: a model may be named as a property every object inherits.
  const steps = Object.hasOwn(TARIFFS, model) ? TARIFFS[model] : undefined;
  if (!steps) return undefined;
  const at = now.getTime();
  if (!Number.isFinite(at)) return undefined;
  const near = [at - DAY_MS, at, at + DAY_MS]
    .map((t) => stepAt(steps, t))
    .filter((s) => s !== undefined);
  const first = near[0];
  if (!first) return undefined;
  const raised = Object.hasOwn(overrides, model) ? overrides[model] : undefined;
  const top = (pick: (s: TariffStep) => GeminiRates | undefined): GeminiRates | undefined => {
    let out: GeminiRates | undefined;
    for (const s of near) {
      const r = pick(s);
      if (r) out = out ? higher(out, r) : r;
    }
    return out && raised ? higher(out, raised) : out;
  };
  const rates = top((s) => s.rates);
  if (!rates) return undefined;
  const longRates = top((s) => s.long?.rates);
  const above = Math.min(...near.map((s) => s.long?.above ?? Number.POSITIVE_INFINITY));
  // A longer prompt never costs less than a shorter one, whatever the owner raised.
  return longRates && Number.isFinite(above)
    ? { rates, long: { above, rates: higher(longRates, rates) } }
    : { rates };
}

/** Micro-dollars for tokens at a price per million tokens, rounded up. */
const micros = (tokens: number, perMillion: number) => Math.ceil(tokens * perMillion - 1e-9);

/** The prices a prompt of `promptTokens` pays. */
const ratesFor = (t: GeminiTariff, promptTokens: number): GeminiRates =>
  t.long && promptTokens > t.long.above ? t.long.rates : t.rates;

/**
 * The most a call can cost, in micro-dollars: every input token at the full input price (no cache
 * discount), and every token of its output limit at the output price, at the long prompt's prices
 * when its input could pass their threshold.
 */
export function geminiWorstCase(t: GeminiTariff, inputBound: number, outputLimit: number): number {
  const r = ratesFor(t, inputBound);
  // Raised cache or input prices may exceed output: unknown output categories use the
  // highest rate, so both reservation components must cover those raised rates too.
  return (
    micros(inputBound, Math.max(r.input, r.cached)) +
    micros(outputLimit, Math.max(r.input, r.output, r.cached))
  );
}

/** The token counts of Google's usage metadata that the cost is counted from. */
export interface GeminiUsage {
  prompt: number;
  cached: number;
  candidates: number;
  thoughts: number;
  toolUse: number;
  total: number;
}

const tokens = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e12 ? v : undefined;

/**
 * A response's usage, or undefined when it does not say what the call used: the prompt's tokens
 * and the total must be there, and each other count there must be a whole number. A count left
 * out is 0, and the total covers it (geminiCost). Counts that contradict each other are no usage
 * either: more cached tokens than the prompt has, or a total under the prompt, the response and
 * its thinking together.
 */
export function geminiUsage(metadata: unknown): GeminiUsage | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const m = metadata as Record<string, unknown>;
  const prompt = tokens(m.promptTokenCount);
  const total = tokens(m.totalTokenCount);
  if (prompt === undefined || total === undefined) return undefined;
  const part = (v: unknown) => (v === undefined || v === null ? 0 : tokens(v));
  const cached = part(m.cachedContentTokenCount);
  const candidates = part(m.candidatesTokenCount);
  const thoughts = part(m.thoughtsTokenCount);
  const toolUse = part(m.toolUsePromptTokenCount);
  if (
    cached === undefined ||
    candidates === undefined ||
    thoughts === undefined ||
    toolUse === undefined ||
    cached > prompt ||
    total < prompt + candidates + thoughts
  )
    return undefined;
  return { prompt, cached, candidates, thoughts, toolUse, total };
}

/**
 * What a finished call cost, in micro-dollars: input not read from the cache and tool-use input at
 * the input price, cached input at its price, and the response and its thinking at the output
 * price. Tokens the total counts beyond those are priced as output, the dearest.
 */
export function geminiCost(t: GeminiTariff, u: GeminiUsage): number {
  const r = ratesFor(t, u.prompt + u.toolUse);
  const cached = Math.min(u.cached, u.prompt);
  const counted = u.prompt + u.toolUse + u.candidates + u.thoughts;
  const unnamed = Math.max(0, u.total - counted);
  return (
    micros(u.prompt - cached + u.toolUse, r.input) +
    micros(cached, r.cached) +
    micros(u.candidates + u.thoughts, r.output) +
    micros(unnamed, Math.max(r.input, r.output, r.cached))
  );
}
