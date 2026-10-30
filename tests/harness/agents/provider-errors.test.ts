import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHATGPT_LIMIT_CODE } from "../../../src/agents/model/index.ts";
import {
  afterProgramFailure,
  classifyProviderError,
  durationMs,
  FAILING_STOP_MS,
  type FailureCount,
  failingOf,
  nextStep,
  programErrorKind,
  retryAtFrom,
  statusIn,
  stopsAgents,
} from "../../../src/harness/agents/provider-errors.ts";

const NOW = Date.parse("2026-10-22T03:00:00.000Z");
const kind = (text: string, answer?: Parameters<typeof classifyProviderError>[1]) =>
  classifyProviderError(text, answer, NOW).kind;

describe("provider errors by kind (goal 079)", () => {
  test("no credits, a refused key and an unserved model stop the agents", () => {
    // The case the audit found: a 404 that says no credits.
    assert.equal(kind("404 insufficient_credits_for_paid_model"), "credits");
    // OpenAI says no quota with a 429: credits, not a rate limit.
    assert.equal(
      kind("429 You exceeded your current quota, please check your plan and billing details."),
      "credits",
    );
    assert.equal(kind("Your credit balance is too low to access the Anthropic API."), "credits");
    assert.equal(kind("payment needed", { status: 402 }), "credits");
    assert.equal(kind("401 Incorrect API key provided: sk-…"), "auth");
    assert.equal(kind("forbidden", { status: 403 }), "auth");
    assert.equal(
      kind("404 The model `gpt-9` does not exist or you do not have access to it."),
      "route",
    );
    assert.equal(kind("model_not_found"), "route");
    for (const k of ["credits", "auth", "route"] as const) assert.ok(stopsAgents(k));
    for (const k of ["rate_limit", "server", "model", "context"] as const)
      assert.ok(!stopsAgents(k));
  });

  test("rate limits, passing faults, a full context and the model's own errors", () => {
    assert.equal(kind("429 Rate limit reached for requests"), "rate_limit");
    assert.equal(kind("Too Many Requests"), "rate_limit");
    assert.equal(kind("RESOURCE_EXHAUSTED: quota per minute"), "rate_limit");
    assert.equal(kind(`{"error":{"code":"${CHATGPT_LIMIT_CODE}"}}`), "rate_limit");
    assert.equal(kind("503 Service Unavailable"), "server");
    assert.equal(kind("529 overloaded_error"), "server");
    assert.equal(kind("read ECONNRESET"), "server");
    assert.equal(kind("fetch failed"), "server");
    assert.equal(kind("context deadline exceeded"), "server");
    assert.equal(kind("400 This model's maximum context length is 32768 tokens"), "context");
    assert.equal(kind("prompt is too long: 210000 tokens > 200000 maximum"), "context");
    assert.equal(kind("400 Invalid tool call arguments"), "model");
    assert.equal(kind(""), "model");
  });

  test("the status comes from the answer, or from the error's words", () => {
    assert.equal(statusIn("429 Too Many Requests"), 429);
    assert.equal(statusIn("Error: 503 upstream"), 503);
    assert.equal(statusIn("request failed with status code 502"), 502);
    assert.equal(statusIn("HTTP 401"), 401);
    assert.equal(statusIn("in 2026 the model"), undefined);
    assert.equal(classifyProviderError("x", { status: 429 }, NOW).status, 429);
  });

  test("a rate limit's time: Retry-After, the reset headers, or the provider's words", () => {
    const at = (iso: string | undefined) => (iso ? Date.parse(iso) - NOW : undefined);
    assert.equal(at(retryAtFrom("", { "retry-after": "20" }, NOW)), 20_000);
    assert.equal(
      at(retryAtFrom("", { "retry-after": "Thu, 22 Oct 2026 03:01:00 GMT" }, NOW)),
      60_000,
    );
    assert.equal(at(retryAtFrom("", { "retry-after-ms": "1500" }, NOW)), 1500);
    // OpenAI's resets: the later of the two, as the limit that was hit is not said.
    assert.equal(
      at(
        retryAtFrom(
          "",
          { "x-ratelimit-reset-requests": "1s", "x-ratelimit-reset-tokens": "6m0s" },
          NOW,
        ),
      ),
      360_000,
    );
    assert.equal(
      at(retryAtFrom("", { "anthropic-ratelimit-tokens-reset": "2026-10-22T03:00:30Z" }, NOW)),
      30_000,
    );
    assert.equal(at(retryAtFrom("Please try again in 1m30s.", undefined, NOW)), 90_000);
    assert.equal(at(retryAtFrom("retry after 45 seconds", undefined, NOW)), 45_000);
    assert.equal(
      at(retryAtFrom("limit resets at 2026-10-22T04:00:00Z", undefined, NOW)),
      3_600_000,
    );
    assert.equal(retryAtFrom("429 Too Many Requests", undefined, NOW), undefined);
    // A full ChatGPT plan names no time: a fixed wait.
    assert.equal(at(retryAtFrom(CHATGPT_LIMIT_CODE, undefined, NOW)), 15 * 60_000);
    assert.equal(durationMs("250ms"), 250);
    assert.equal(durationMs("1h2m3s"), 3_723_000);
    assert.equal(durationMs("soon"), undefined);
  });

  test("the next step: stop kinds end the trial; others wait and go on, with no limit unless set", () => {
    const count = { failures: 0, rateWaits: 0 };
    const credits = classifyProviderError("402 out of credits", undefined, NOW);
    assert.deepEqual(nextStep(credits, count, undefined, NOW), {
      end: true,
      error: "402 out of credits",
    });
    const server = classifyProviderError("503 down", undefined, NOW);
    const pauses = Array.from({ length: 8 }, () => {
      const s = nextStep(server, count, undefined, NOW);
      assert.equal(s.end, false);
      return s.end ? 0 : s.waitMs;
    });
    assert.deepEqual(pauses, [5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
    // A rate limit never counts as a failure.
    const rate = classifyProviderError("429 slow down", { headers: { "retry-after": "3" } }, NOW);
    const r = nextStep(rate, count, 2, NOW);
    assert.ok(!r.end && r.waitMs === 3000 && r.kind === "rate_limit");
    assert.equal(count.failures, 8);
    // The campaign's limit: the next failure in a row is the last.
    const c2 = { failures: 0, rateWaits: 0 };
    assert.equal(nextStep(server, c2, 2, NOW).end, false);
    const last = nextStep(server, c2, 2, NOW);
    assert.ok(last.end && /failed 2 times in a row/.test(last.error));
    // A rate limit that names no time: 30 s, doubling to 10 minutes.
    const vague = classifyProviderError("429", undefined, NOW);
    const c3 = { failures: 0, rateWaits: 0 };
    const waits = [1, 2, 3, 4, 5, 6].map(() => {
      const s = nextStep(vague, c3, undefined, NOW);
      return s.end ? 0 : s.waitMs;
    });
    assert.deepEqual(waits, [30_000, 60_000, 120_000, 240_000, 480_000, 600_000]);
  });

  test("a program's failed run: the proxy's answer gives the kind; the trial goes on, ends, or stops at its own end", async () => {
    const count = { failures: 0, rateWaits: 0 };
    const told: string[] = [];
    // The program only said "Bad Request"; the proxy saw the provider's 402 and its words.
    const end = await afterProgramFailure({
      error: "Bad Request",
      answer: { status: 402, body: '{"error":"insufficient credits"}' },
      count,
      deadline: Number.POSITIVE_INFINITY,
      waiting: (w) => void told.push(w.kind),
    });
    assert.deepEqual(end, {
      end: { error: 'Bad Request ({"error":"insufficient credits"})', kind: "credits" },
    });
    assert.equal(told.length, 0);
    // A rate limit of one second: it waits, says so, and goes on.
    const started = Date.now();
    const on = await afterProgramFailure({
      error: "rate limited",
      answer: { status: 429, headers: { "retry-after": "1" } },
      count,
      deadline: Number.POSITIVE_INFINITY,
      waiting: (w) => void told.push(w.kind),
    });
    // It goes on with the provider's words, which the agent's role puts to it (goal 166).
    assert.ok("goOn" in on && /rate limited/.test(on.goOn));
    assert.ok(Date.now() - started >= 900);
    assert.deepEqual(told, ["rate_limit"]);
    // A wait past the trial's own end stops at its end.
    const wall = await afterProgramFailure({
      error: "503",
      count,
      deadline: Date.now() + 50,
    });
    assert.deepEqual(wall, { wall: true });
    // A stop meanwhile: interrupted.
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const stopped = await afterProgramFailure({
      error: "503",
      count,
      deadline: Number.POSITIVE_INFINITY,
      signal: ctrl.signal,
    });
    assert.deepEqual(stopped, { interrupted: true });
  });

  test("through the model proxy, a stop kind comes only from the provider's answer the proxy saw, never the program's words alone", async () => {
    const proxied = (error: string, answer?: { status: number; body?: string }) =>
      programErrorKind(error, answer, true).kind;
    // Words that say no credits or a refused key, with no answer from the provider: not a stop.
    assert.equal(proxied("402 insufficient credits"), "model");
    assert.equal(proxied("401 invalid api key"), "model");
    assert.equal(proxied("model_not_found"), "model");
    // The provider's own answer stops them, whatever the program said.
    assert.equal(proxied("Bad Request", { status: 402, body: "{}" }), "credits");
    assert.equal(proxied("oops", { status: 401, body: '{"error":"invalid x-api-key"}' }), "auth");
    // Words that say no credits beside a provider's rate limit: the provider's kind.
    const rate = programErrorKind("insufficient credits", { status: 429, body: "slow down" }, true);
    assert.equal(rate.kind, "rate_limit");
    // A kind that stops nothing is the words' own, as before; without the proxy, the words count.
    assert.equal(proxied("503 Service Unavailable"), "server");
    assert.equal(programErrorKind("402 insufficient credits", undefined, false).kind, "credits");
    // The trial loop's answer: no stop, so it waits and goes on in the same session.
    const step = await afterProgramFailure({
      error: "insufficient credits",
      proxied: true,
      count: { failures: 0, rateWaits: 0 },
      deadline: Date.now() + 50,
    });
    assert.deepEqual(step, { wall: true });
  });

  test("a quota 429 the provider marks a rate limit is one; OpenAI's insufficient_quota and a 402 stay no credits", () => {
    const quota =
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.";
    // Google's per-minute quota: a 429 with RESOURCE_EXHAUSTED, in the words of a quota.
    assert.equal(
      kind(`429: {"error":{"code":429,"message":"${quota}","status":"RESOURCE_EXHAUSTED"}}`),
      "rate_limit",
    );
    // A 429 with a time to try again in its headers: a rate limit, and its time is kept.
    const timed = classifyProviderError(
      quota,
      { status: 429, headers: { "retry-after": "20" } },
      NOW,
    );
    assert.equal(timed.kind, "rate_limit");
    assert.equal(Date.parse(String(timed.retryAt)) - NOW, 20_000);
    assert.equal(
      kind(quota, { status: 429, headers: { "x-ratelimit-reset-requests": "1s" } }),
      "rate_limit",
    );
    // OpenAI's no credits, in the same words: its code says so, even with reset headers.
    assert.equal(
      kind(
        '429: {"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}',
        { status: 429, headers: { "x-ratelimit-reset-requests": "1s" } },
      ),
      "credits",
    );
    assert.equal(kind(quota, { status: 402, headers: { "retry-after": "20" } }), "credits");
    // The same words with nothing that marks a rate limit: still no credits.
    assert.equal(kind(`429 ${quota}`), "credits");
  });

  test("a passing fault or the model's error with no call that worked for 30 minutes ends the trial; a rate limit between does not reset it (goal 079)", () => {
    const count: FailureCount = { failures: 0, rateWaits: 0 };
    const server = classifyProviderError("503 Service Unavailable", undefined, NOW);
    const at = (min: number) => NOW + min * 60_000;
    assert.equal(nextStep(server, count, undefined, at(0)).end, false);
    assert.equal(failingOf(count)?.since, new Date(NOW).toISOString());
    assert.equal(nextStep(server, count, undefined, at(10)).end, false);
    // A rate limit between the failures: it waits, and the count goes on.
    const rate = classifyProviderError("429", { headers: { "retry-after": "60" } }, at(15));
    assert.equal(nextStep(rate, count, undefined, at(15)).end, false);
    const model = classifyProviderError("400 Invalid tool call arguments", undefined, at(29));
    assert.equal(nextStep(model, count, undefined, at(29)).end, false);
    const last = nextStep(model, count, undefined, at(30));
    assert.ok(last.end, "30 minutes with no call that worked: the trial ends");
    assert.match(
      last.error,
      /^no model call worked for 30 minutes \(the provider refused the request\): 400 Invalid tool call arguments/,
    );
    assert.deepEqual(failingOf(count), {
      since: new Date(NOW).toISOString(),
      kind: "model",
      words: "400 Invalid tool call arguments",
    });
    assert.equal(FAILING_STOP_MS, 30 * 60_000);
    // A call that worked clears it (the trial's loop does): the count starts again.
    count.failing = undefined;
    assert.equal(nextStep(server, count, undefined, at(31)).end, false);
    assert.equal(failingOf(count)?.since, new Date(at(31)).toISOString());
  });

  test("a program's run that keeps failing for 30 minutes ends with the kind; the trial's failing calls are kept", async () => {
    const count: FailureCount = {
      failures: 3,
      rateWaits: 0,
      failing: { since: Date.now() - FAILING_STOP_MS, kind: "server", words: "503" },
    };
    const end = await afterProgramFailure({
      error: "502 Bad Gateway",
      count,
      deadline: Number.POSITIVE_INFINITY,
    });
    assert.ok("end" in end);
    assert.equal(end.end.kind, "server");
    assert.match(
      end.end.error,
      /no model call worked for 30 minutes \(the provider failed for now\)/,
    );
    assert.equal(failingOf(count)?.words, "502 Bad Gateway");
  });
});
