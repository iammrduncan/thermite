import { z } from "zod";
import { CHATGPT_LIMIT_CODE, type ProviderAnswer, retryAtFrom } from "../../agents/model/index.ts";

/** When a provider said to try again, read alike by the advisors (agents/model/retry.ts). */
export { durationMs, type ProviderAnswer, retryAtFrom } from "../../agents/model/index.ts";

/**
 * A model provider's errors, by kind (goal 079). Each kind has its own answer:
 *
 * - `rate_limit`: the provider asks for a pause. The agent waits for the time the provider gives
 *   (Retry-After, a reset header, or "try again in 20s" in its words), else a growing pause, and
 *   goes on in the same conversation.
 * - `credits`, `auth`, `route`: no credits left, a key the provider refuses, or a model it does not
 *   serve on this key. Nothing gets better by trying again: the run's agents stop and the run shows
 *   in Needs you with the provider's own words, until a model check passes again.
 * - `server`: the provider (or the way to it) failed for now, a 5xx, a broken connection, or a
 *   stream that sent no data for THERMITE_MODEL_STALL_SECONDS (agents/model/stall.ts). The agent
 *   waits a growing pause and goes on in the same conversation.
 * - `context`: the request was longer than the model's window: the conversation is compacted.
 * - `model`: anything else, such as a request the provider refused as malformed. The agent is told
 *   the call failed and goes on.
 *
 * None of these ends research. A trial ends after failures in a row only when the campaign sets
 * `lanes.limits.failures_in_a_row`. A `server` or `model` failure that never clears, with no call
 * that worked for FAILING_STOP_MS, stops the run's agents as no credits does, until a model check
 * passes: pacing, so that the owner sees it, not a cap.
 *
 * Only an error that came from a call to the provider is sorted here: the words of a local failure
 * (a workspace that could not be set up, a program that exited) are not the provider's.
 */
export const PROVIDER_ERROR_KINDS = [
  "rate_limit",
  "credits",
  "auth",
  "route",
  "server",
  "context",
  "model",
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export interface ProviderError {
  kind: ProviderErrorKind;
  /** The HTTP status, when the error or the answer gave one. */
  status?: number | undefined;
  /** The provider's own words, shortened. */
  words: string;
  /** When the provider said to try again (ISO), for a rate limit that gave one. */
  retryAt?: string | undefined;
}

/** The kinds after which the run's agents stop until a model check passes. */
export const STOP_KINDS: ReadonlySet<ProviderErrorKind> = new Set(["credits", "auth", "route"]);

/**
 * How long a trial's model calls may keep failing with the provider's passing faults (`server`)
 * or the model's own errors (`model`), with no call that worked between them, before the run's
 * agents stop as they do for no credits (goal 079). It is pacing, not a cap on research: the model
 * is then checked again, after a minute and then less often (at most every 30 minutes), at once
 * when the owner resumes the run, and a passing check lets the agents go on, each lane with a
 * fresh trial. A rate limit between those failures does not end the count: only a call that
 * worked does.
 */
export const FAILING_STOP_MS = 30 * 60_000;

/** What such a stop says, in words. */
export const FAILING_SAID = `no model call worked for ${FAILING_STOP_MS / 60_000} minutes`;

/**
 * A trial's failing model calls when it ended (goal 079): since when they failed with no call that
 * worked between them (ISO), and the newest one's kind and the provider's words.
 */
export const TrialFailing = z.object({
  since: z.string(),
  kind: z.enum(PROVIDER_ERROR_KINDS),
  words: z.string(),
});
export type TrialFailing = z.infer<typeof TrialFailing>;

/** A trial's failed model calls in a row, and since when they have failed (goal 079). */
export interface FailureCount {
  /** Failures in a row that are not rate limits. */
  failures: number;
  /** Rate limits in a row. */
  rateWaits: number;
  /**
   * Since when (ms) the calls have failed with `server` or `model` errors, with no call that
   * worked since, and the newest one's kind and words. A call that worked clears it.
   */
  failing?: { since: number; kind: ProviderErrorKind; words: string } | undefined;
}

/** The failing calls a trial ended with, for its result; none when its last call worked. */
export function failingOf(count: FailureCount): TrialFailing | undefined {
  const f = count.failing;
  return f
    ? { since: new Date(f.since).toISOString(), kind: f.kind, words: f.words.slice(0, 600) }
    : undefined;
}

/** Whether failing calls since `since` (ISO or ms) have lasted FAILING_STOP_MS. */
export function failedTooLong(since: string | number, now = Date.now()): boolean {
  const t = typeof since === "number" ? since : Date.parse(since);
  return !Number.isNaN(t) && now - t >= FAILING_STOP_MS;
}

export function stopsAgents(kind: ProviderErrorKind | undefined): boolean {
  return kind !== undefined && STOP_KINDS.has(kind);
}

/** Each kind in plain words, for the live view, History and Needs you. */
export const KIND_WORDS: Record<ProviderErrorKind, string> = {
  rate_limit: "the provider's rate limit",
  credits: "no credits left at the provider",
  auth: "the provider refuses the key",
  route: "the provider does not serve this model on this key",
  server: "the provider failed for now",
  context: "the conversation is longer than the model's window",
  model: "the provider refused the request",
};

/** No credits, by a code or words that mean nothing else (OpenAI's `insufficient_quota`). */
const CREDITS =
  /insufficient[_ ]?(credits?|quota|balance|funds)|credit balance|out of credits|not enough credits|no credits|add (more )?credits|purchase (more )?credits|payment required|requires? (more )?credits/i;
/**
 * Words a quota error shares with a rate limit: OpenAI's no-credits answer and Google's
 * per-minute quota both say "You exceeded your current quota, please check your plan and billing
 * details". No credits only when nothing marks the answer a rate limit.
 */
const QUOTA = /billing|exceeded your current quota|quota exceeded/i;
const AUTH =
  /invalid[_ ]?(api[_ ]?)?key|incorrect api key|invalid x-api-key|unauthori[sz]ed|authentication|permission[_ ]denied|api key (is )?(invalid|expired|revoked|disabled)|key (has been )?(revoked|disabled)|token (has )?expired|access denied/i;
const ROUTE =
  /model[_ ]not[_ ]found|no such model|unknown model|model .{0,80}(does not exist|not found|is not (available|supported))|does not have access to (the )?model|not available on your plan/i;
const RATE =
  /rate[_ ]?limit|too many requests|resource[_ ]exhausted|slow down|usage limit|requests per (minute|day)|tokens per (minute|day)/i;
const CONTEXT =
  /context[_ ]?(length|window)|too long|maximum (context )?length|prompt is too long|exceeds? (the )?(model'?s? )?(context|maximum)|too many tokens/i;
/**
 * A server error: also a model call broken off because its stream went silent
 * (agents/model/stall.ts).
 */
const SERVER =
  /stream went silent|overloaded|bad gateway|service unavailable|gateway time-?out|internal server error|server error|upstream|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network|could not be reached|connection (error|reset|refused|closed)|timed? ?out|deadline exceeded|terminated|broke off|temporarily unavailable/i;

/** The HTTP status an error's text gives: "429 …", "HTTP 503", "status code 402". */
export function statusIn(text: string): number | undefined {
  const m =
    /^\s*(?:Error:\s*)?(\d{3})\b/.exec(text) ??
    /\b(?:HTTP|status(?: code)?|code)[\s:=]*(\d{3})\b/i.exec(text) ??
    /\b(\d{3}) status code\b/i.exec(text);
  const n = m ? Number(m[1]) : Number.NaN;
  return n >= 400 && n < 600 ? n : undefined;
}

/**
 * The kind of a provider's error, from its words and, when the caller saw it, the provider's
 * answer (its status and headers). No credits comes first: OpenAI says so with a 429. A 429 that
 * marks itself a rate limit (Google's `RESOURCE_EXHAUSTED`, or a time to try again in its
 * headers) is one, even in a quota's words; OpenAI's `insufficient_quota` and a 402 stay no
 * credits.
 */
export function classifyProviderError(
  text: string,
  answer?: ProviderAnswer | undefined,
  now = Date.now(),
): ProviderError {
  const words = text.replace(/\s+/g, " ").trim().slice(0, 600) || "no detail";
  const status = answer?.status ?? statusIn(text);
  const base = { words, ...(status !== undefined ? { status } : {}) };
  const rate = (): ProviderError => ({
    ...base,
    kind: "rate_limit",
    retryAt: retryAtFrom(text, answer?.headers, now),
  });
  if (status === 402 || CREDITS.test(text)) return { ...base, kind: "credits" };
  if (text.includes(CHATGPT_LIMIT_CODE)) return rate();
  if (
    /resource[_ ]exhausted/i.test(text) ||
    (status === 429 && retryAtFrom("", answer?.headers, now) !== undefined)
  )
    return rate();
  if (QUOTA.test(text)) return { ...base, kind: "credits" };
  if (status === 401 || status === 403 || AUTH.test(text)) return { ...base, kind: "auth" };
  if (ROUTE.test(text)) return { ...base, kind: "route" };
  if (status === 429 || RATE.test(text)) return rate();
  if (CONTEXT.test(text) && !/deadline exceeded/i.test(text)) return { ...base, kind: "context" };
  if (status === 404) return { ...base, kind: "route" };
  if ((status !== undefined && (status >= 500 || status === 408)) || SERVER.test(text))
    return { ...base, kind: "server" };
  return { ...base, kind: "model" };
}

/** The pause before trying again after the `n`th failure in a row (1, 2, …): 5 s doubling to 60 s. */
export function failurePauseMs(n: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, n - 1));
}

/**
 * The pause before trying again after the `n`th rate limit in a row that gave no time: 30 s
 * doubling to 10 minutes.
 */
export function ratePauseMs(n: number): number {
  return Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, n - 1));
}

/**
 * A program's run in a trial (OpenCode, Codex, Claude Code) or Pi's model call ended with a
 * provider's error: what the trial does next. `failures` counts failures in a row that are not
 * rate limits; `rateWaits` rate limits in a row; `failing` says since when the calls have failed
 * with no call that worked. A stop kind ends the trial; a limit the campaign set
 * (`failuresInARow`) ends it after that many failures; so does a failure that has lasted
 * FAILING_STOP_MS, and the run's agents then stop (the scheduler reads the trial's `failing`).
 * Anything else waits and goes on.
 */
export function nextStep(
  e: ProviderError,
  count: FailureCount,
  failuresInARow?: number | undefined,
  now = Date.now(),
):
  | { end: true; error: string }
  | { end: false; waitMs: number; until: string; why: string; kind: ProviderErrorKind } {
  if (stopsAgents(e.kind)) return { end: true, error: e.words };
  if (e.kind === "rate_limit") {
    count.rateWaits++;
    const until = e.retryAt ? Date.parse(e.retryAt) : now + ratePauseMs(count.rateWaits);
    const waitMs = Math.max(1000, until - now);
    return {
      end: false,
      waitMs,
      until: new Date(now + waitMs).toISOString(),
      why: `${KIND_WORDS.rate_limit}${e.retryAt ? "" : " (it gave no time)"}`,
      kind: e.kind,
    };
  }
  count.rateWaits = 0;
  count.failures++;
  count.failing = { since: count.failing?.since ?? now, kind: e.kind, words: e.words };
  if (failuresInARow !== undefined && count.failures >= failuresInARow)
    return {
      end: true,
      error: `the model call failed ${count.failures} times in a row (the campaign's failures_in_a_row): ${e.words}`,
    };
  if (failedTooLong(count.failing.since, now))
    return { end: true, error: `${FAILING_SAID} (${KIND_WORDS[e.kind]}): ${e.words}` };
  const waitMs = failurePauseMs(count.failures);
  return {
    end: false,
    waitMs,
    until: new Date(now + waitMs).toISOString(),
    why: KIND_WORDS[e.kind],
    kind: e.kind,
  };
}

/**
 * What a trial in a program of its own does after a provider's error (afterProgramFailure); to go
 * on, with the provider's words, which its role's later turn gives the agent (goal 166).
 */
export type ProgramStep =
  | { end: { error: string; kind: ProviderErrorKind } }
  | { goOn: string }
  | { interrupted: true }
  | { wall: true };

/**
 * The kind of a program's error: from its words and the error answer the harness's model proxy
 * saw. For a program whose calls go through the proxy (`proxied`: OpenCode, Codex), a stop kind
 * comes only from that answer: the program's words alone, which its agent's commands can write,
 * never stop the run's agents, and are the model's own error instead.
 */
export function programErrorKind(
  error: string,
  answer: (ProviderAnswer & { body?: string | undefined }) | undefined,
  proxied: boolean,
): ProviderError {
  const text = answer?.body ? `${error} (${answer.body})` : error;
  const e = classifyProviderError(text, answer);
  if (!proxied || !stopsAgents(e.kind)) return e;
  const seen = answer ? classifyProviderError(answer.body ?? "", answer) : undefined;
  if (stopsAgents(seen?.kind)) return e;
  return seen ? { ...seen, words: e.words } : { ...e, kind: "model" };
}

/**
 * A trial in a program of its own (OpenCode, Codex, Claude Code) ended a run with an error (goal
 * 079): its kind, from the program's words and the error answer the harness's model proxy saw
 * (programErrorKind). A stop kind or the campaign's limit ends the trial. Otherwise the trial waits
 * (the provider's time, or a growing pause, never past its own end) and goes on in the program's
 * same session: `goOn` holds the provider's words, for the agent's turn that goes on.
 */
export async function afterProgramFailure(input: {
  error: string;
  /** The error answer the model proxy saw during the run, if any. */
  answer?: (ProviderAnswer & { body?: string | undefined }) | undefined;
  /** Whether the program's calls go through the model proxy (OpenCode, Codex on a provider's key). */
  proxied?: boolean | undefined;
  count: FailureCount;
  failuresInARow?: number | undefined;
  /** The trial's end (ms), or Infinity. */
  deadline: number;
  signal?: AbortSignal | undefined;
  waiting?: ((w: { until: string; kind: ProviderErrorKind; words: string }) => void) | undefined;
  /** How long a wait really lasts (tests shorten it). */
  pauseMs?: ((ms: number) => number) | undefined;
}): Promise<ProgramStep> {
  const e = programErrorKind(input.error, input.answer, input.proxied === true);
  // A program compacts its own conversation: a context error here is the model's refusal.
  const step = nextStep(
    e.kind === "context" ? { ...e, kind: "model" } : e,
    input.count,
    input.failuresInARow,
  );
  if (step.end) return { end: { error: step.error, kind: e.kind } };
  input.waiting?.({ until: step.until, kind: e.kind, words: e.words });
  const until = Math.min(input.deadline, Date.now() + (input.pauseMs ?? ((ms) => ms))(step.waitMs));
  while (Date.now() < until && !input.signal?.aborted)
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(1, until - Date.now()))));
  if (input.signal?.aborted) return { interrupted: true };
  if (Date.now() >= input.deadline) return { wall: true };
  return { goOn: e.words };
}

/** What a trial in a program of its own learns of its provider through the harness (goal 079). */
export interface ProviderLink {
  /** The newest error answer the harness's model proxy saw for this trial, since `since` (ms). */
  providerAnswer?:
    | ((since: number) => (ProviderAnswer & { body?: string | undefined }) | undefined)
    | undefined;
  /** Told of each wait for the provider, before it. */
  waiting?: ((w: { until: string; kind: ProviderErrorKind; words: string }) => void) | undefined;
  /** How long a wait really lasts (tests shorten it); by default, as long as it says. */
  pauseMs?: ((ms: number) => number) | undefined;
}

/** Lowercase header names and values of a fetch answer, for retryAtFrom. */
export function headersOf(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/**
 * Pi's calls to the provider pass through here: an error answer's status and headers are kept, so
 * the trial reads a rate limit's Retry-After, which pi-ai's error message leaves out.
 */
export class ProviderWatch {
  last: (ProviderAnswer & { at: number }) | undefined;

  /** A fetch that notes each error answer, around another one. */
  wrap(inner: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
    return async (input, init) => {
      const res = await inner(input, init);
      if (res.status >= 400)
        this.last = { status: res.status, headers: headersOf(res.headers), at: Date.now() };
      return res;
    };
  }

  /** The newest error answer, if it came at or after `since` (ms). */
  since(since: number): ProviderAnswer | undefined {
    const l = this.last;
    return l && l.at >= since ? { status: l.status, headers: l.headers } : undefined;
  }

  /** The newest error answer not taken yet, taken. */
  take(): ProviderAnswer | undefined {
    const l = this.last;
    this.last = undefined;
    return l ? { status: l.status, headers: l.headers } : undefined;
  }
}
