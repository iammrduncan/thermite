import {
  type ProviderErrorAnswer,
  retryAtFrom,
  usageLimitRetry,
} from "../../agents/model/index.ts";

/**
 * A full usage window that an advisor's call met and did not wait out (the owner's decisions of
 * 2026-10-27, goal 169's questions 5 and 8): not a failed try. The advisor waits for the reset,
 * its open audits and reviews with it, and Live says so. A headless call ends at any full window;
 * a call in its program's own terminal or its Pi view waits a window out inside itself, and ends
 * only at one more than a day away, a weekly window (agents/cli/usage-window.ts).
 */
export interface AdvisorLimit {
  /** When the window resets (ISO), at most a week and a day away (ADVISOR_WAIT_MAX_MS). */
  until: string;
  /** The provider's or the program's words, cut to 1,000 characters. */
  words: string;
}

/** Words that name a usage or rate limit, as a provider or a program says it. */
const LIMIT_WORDS =
  /usage[ _]limit|rate[ _]?limit|limit reached|too many requests|resource[ _]exhausted/i;

/**
 * The furthest reset an advisor waits for: a week and a day, past a weekly window's longest. A
 * reset further off is not believed: the call is a failed try, as before.
 */
export const ADVISOR_WAIT_MAX_MS = 8 * 24 * 3_600_000;

/** A limit whose reset is known and at most ADVISOR_WAIT_MAX_MS away; undefined otherwise. */
export function limitUntil(
  until: string,
  words: string,
  now = Date.now(),
): AdvisorLimit | undefined {
  const at = Date.parse(until);
  if (Number.isNaN(at) || at <= now || at - now > ADVISOR_WAIT_MAX_MS) return undefined;
  return { until: new Date(at).toISOString(), words: words.slice(0, 1000) };
}

/**
 * A limit in a call's error words: they name a usage or rate limit and say when it resets (a full
 * ChatGPT plan's code says neither, and waits CHATGPT_LIMIT_WAIT_MS). Only the call's errors are
 * read, never the model's own text, which could say anything.
 */
export function limitIn(words: string | undefined, now = Date.now()): AdvisorLimit | undefined {
  if (!words) return undefined;
  const plan = usageLimitRetry(words, now);
  if (!plan && !LIMIT_WORDS.test(words)) return undefined;
  const until = plan ?? retryAtFrom(words, undefined, now);
  return until ? limitUntil(until, words, now) : undefined;
}

/**
 * A limit in the provider's error answer that the call's model proxy saw (an advisor in OpenCode
 * or Codex): a 429 or a limit's words, with the reset its headers or words give, as the harness
 * reads a trial's (a full ChatGPT plan: CHATGPT_LIMIT_WAIT_MS).
 */
export function limitInAnswer(a: ProviderErrorAnswer, now = Date.now()): AdvisorLimit | undefined {
  if (a.status !== 429 && !LIMIT_WORDS.test(a.body) && !usageLimitRetry(a.body, now))
    return undefined;
  const until = retryAtFrom(a.body, a.headers, now) ?? usageLimitRetry(a.body, now);
  return until ? limitUntil(until, a.body, now) : undefined;
}
