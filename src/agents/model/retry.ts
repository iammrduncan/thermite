import { CHATGPT_LIMIT_CODE, CHATGPT_LIMIT_WAIT_MS } from "./index.ts";

/**
 * When a model provider said to try again, from its answer (goal 079): what the harness's agents
 * and the supervisor's advisors read alike, a trial's and a call's wait for a full usage window in
 * a program's own terminal among them (src/agents/cli/usage-window.ts). How each kind of a
 * provider's error is answered is the harness's (src/harness/agents/provider-errors.ts).
 */

/** What a provider's answer showed besides its text: its status and its headers. */
export interface ProviderAnswer {
  status?: number | undefined;
  headers?: Record<string, string | undefined> | undefined;
}

/** A duration such as "20s", "1m30s", "6m0s", "250ms" or "1.5h", in milliseconds. */
export function durationMs(raw: string): number | undefined {
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
  };
  let total = 0;
  let any = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hr|h)(?![a-z])/gi;
  for (const m of s.matchAll(re)) {
    const unit = units[(m[2] as string).toLowerCase()];
    if (unit === undefined) continue;
    total += Number(m[1]) * unit;
    any = true;
  }
  return any ? Math.round(total) : undefined;
}

function header(h: ProviderAnswer["headers"], name: string): string | undefined {
  if (!h) return undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * When the provider said to try again, from its answer's headers (Retry-After in seconds or as a
 * date, retry-after-ms, OpenAI's x-ratelimit-reset-*, Anthropic's anthropic-ratelimit-*-reset, an
 * epoch in x-ratelimit-reset) or its words ("try again in 20s", "retry after 30 seconds", "resets
 * at 2026-10-22T03:00:00Z"). The latest time any of them names: the limit that was hit is not said.
 */
export function retryAtFrom(
  text: string,
  headers?: ProviderAnswer["headers"],
  now = Date.now(),
): string | undefined {
  const times: number[] = [];
  const ra = header(headers, "retry-after");
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra.trim())) times.push(now + Number(ra) * 1000);
    else if (!Number.isNaN(Date.parse(ra))) times.push(Date.parse(ra));
  }
  const ms = header(headers, "retry-after-ms");
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) times.push(now + Number(ms));
  if (!times.length) {
    for (const k of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
      const v = header(headers, k);
      const d = v ? durationMs(v) : undefined;
      if (d !== undefined) times.push(now + d);
    }
    for (const k of [
      "anthropic-ratelimit-requests-reset",
      "anthropic-ratelimit-tokens-reset",
      "anthropic-ratelimit-input-tokens-reset",
      "anthropic-ratelimit-output-tokens-reset",
    ]) {
      const v = header(headers, k);
      const t = v ? Date.parse(v) : Number.NaN;
      if (!Number.isNaN(t) && t > now) times.push(t);
    }
    const epoch = header(headers, "x-ratelimit-reset");
    if (epoch && /^\d{10,13}$/.test(epoch.trim())) {
      const n = Number(epoch);
      const t = n < 1e12 ? n * 1000 : n;
      if (t > now) times.push(t);
    }
  }
  if (!times.length) {
    const said =
      /(?:try again|retry|retrying|wait)\s*(?:in|after|for)\s*((?:\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hr|h)(?![a-z])\s*)+)/i.exec(
        text,
      );
    const d = said ? durationMs(said[1] as string) : undefined;
    if (d !== undefined) times.push(now + d);
    const at =
      /\breset(?:s)?\s*(?:at|on)?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(
        text,
      );
    const t = at ? Date.parse(at[1] as string) : Number.NaN;
    if (!Number.isNaN(t) && t > now) times.push(t);
  }
  if (text.includes(CHATGPT_LIMIT_CODE) && !times.length) times.push(now + CHATGPT_LIMIT_WAIT_MS);
  if (!times.length) return undefined;
  return new Date(Math.max(...times)).toISOString();
}
