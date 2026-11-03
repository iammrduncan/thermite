/**
 * keepGoing: a full context, a stuck model and the provider's errors either end a trial, with their
 * kind, or let it go on.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FailureCount } from "../../../../src/harness/agents/provider-errors.ts";
import { keepGoing } from "../../../../src/harness/agents/worker/index.ts";

describe("worker trial", () => {
  test("keepGoing ends a trial on a full context or a stuck model, never loops on it", async () => {
    // A stand-in agent: each prompt appends the next scripted assistant message (or messages: a
    // run of several turns).
    type Reply = { stopReason: string; output?: number; input?: number; errorMessage?: string };
    const fake = (replies: (Reply | Reply[])[]) => {
      const messages: unknown[] = [];
      const listeners = new Set<(e: unknown) => void>();
      let i = 0;
      const next = () => {
        const step = replies[Math.min(i++, replies.length - 1)] as Reply | Reply[];
        for (const r of Array.isArray(step) ? step : [step]) {
          const message = {
            role: "assistant",
            stopReason: r.stopReason,
            errorMessage: r.errorMessage,
            usage: { input: r.input ?? 1000, output: r.output ?? 2000 },
          };
          messages.push(message);
          for (const l of listeners) l({ type: "turn_end", message, toolResults: [] });
        }
      };
      next();
      return {
        agent: {
          state: { messages },
          prompt: async () => next(),
          subscribe: (l: (e: unknown) => void) => {
            listeners.add(l);
            return () => listeners.delete(l);
          },
        } as never,
        calls: () => i,
      };
    };
    // A compactor: how many compactions keepGoing asked for.
    const compactor = () => {
      const c = { asked: 0, count: 0, force: () => void c.asked++ };
      return c;
    };
    // With compaction (goal 070), a full context is compacted and the trial goes on.
    const once = fake([{ stopReason: "length", output: 1, input: 31_900 }, { stopReason: "stop" }]);
    const c1 = compactor();
    assert.equal(await keepGoing(once.agent, () => false, 32_768, c1), undefined);
    assert.equal(c1.asked, 1);
    assert.equal(once.calls(), 2, "the trial went on after the compaction");
    const error = fake([
      { stopReason: "error", errorMessage: "400 maximum context length is 32768 tokens" },
      // After the compaction: a turn with a tool call, then the context is full again.
      [
        { stopReason: "toolUse" },
        { stopReason: "error", errorMessage: "400 maximum context length is 32768 tokens" },
      ],
      { stopReason: "stop" },
    ]);
    const c2 = compactor();
    assert.equal(await keepGoing(error.agent, () => false, 32_768, c2), undefined);
    assert.equal(c2.asked, 2, "a reply between two full contexts: each one is compacted");
    // Full again right after each of two compactions: compaction cannot help, the trial ends.
    const always = fake([{ stopReason: "length", output: 1, input: 31_900 }]);
    const c3 = compactor();
    const end = await keepGoing(always.agent, () => false, 32_768, c3);
    assert.equal(end?.stopped, "context");
    assert.match(String(end?.error), /again right after a compaction/);
    assert.equal(c3.asked, 2);
    const never = () => false;
    // A one-token cut-off: the context is full.
    const full = fake([{ stopReason: "length", output: 1, input: 31_900 }]);
    assert.equal((await keepGoing(full.agent, never, 32_768))?.stopped, "context");
    assert.equal(full.calls(), 1, "no further call");
    // A prompt at the context window, even with output: full as well.
    const atWindow = fake([{ stopReason: "length", output: 500, input: 31_500 }]);
    assert.equal((await keepGoing(atWindow.agent, never, 32_768))?.stopped, "context");
    // A context-length error from the provider.
    const tooLong = fake([
      { stopReason: "error", errorMessage: "400 maximum context length is 32768 tokens" },
    ]);
    assert.equal((await keepGoing(tooLong.agent, never, 32_768))?.stopped, "context");
    // Cut off 5 times running with real output, under the campaign's cutoffs_in_a_row of 5: the
    // trial ends.
    const stuck = fake([{ stopReason: "length" }]);
    const s5 = await keepGoing(stuck.agent, never, 32_768, undefined, { cutoffsInARow: 5 });
    assert.equal(s5?.stopped, "error");
    assert.match(String(s5?.error), /cut off 5 times in a row .*cutoffs_in_a_row/);
    assert.equal(stuck.calls(), 5);
    // Without a limit (the default, goal 079), cut-offs never end a trial: it goes on until its
    // own end (done).
    const many = fake([{ stopReason: "length" }]);
    let left = 40;
    assert.equal(await keepGoing(many.agent, () => --left <= 0, 32_768), undefined);
    assert.ok(many.calls() >= 19, `went on (${many.calls()} calls)`);
    // Two cut-offs, then a reply that stops of its own accord: back to the caller.
    const ok = fake([{ stopReason: "length" }, { stopReason: "length" }, { stopReason: "stop" }]);
    assert.equal(await keepGoing(ok.agent, never, 32_768), undefined);
    // An unknown window (0) never reads a long prompt as a full context by itself.
    const unknown = fake([
      { stopReason: "length", output: 500, input: 300_000 },
      { stopReason: "stop" },
    ]);
    assert.equal(await keepGoing(unknown.agent, never, 0), undefined);
    // The trial's time running out ends it quietly.
    const late = fake([{ stopReason: "length" }]);
    assert.equal(await keepGoing(late.agent, () => true, 32_768), undefined);

    // Provider errors by kind (goal 079). Waits are recorded, not slept.
    const waits: number[] = [];
    const told: { kind: string; until: string }[] = [];
    const quick = {
      sleep: async (ms: number) => void waits.push(ms),
      onWait: (w: { kind: string; until: string }) => void told.push(w),
    };
    // No credits: the trial ends at once with the kind, and the provider's words.
    const broke = fake([
      { stopReason: "error", errorMessage: "404 insufficient_credits_for_paid_model" },
      { stopReason: "stop" },
    ]);
    const nc = await keepGoing(broke.agent, never, 32_768, undefined, quick);
    assert.deepEqual([nc?.stopped, nc?.kind], ["error", "credits"]);
    assert.match(String(nc?.error), /insufficient_credits_for_paid_model/);
    assert.equal(broke.calls(), 1, "no call after it");
    // A refused key: the same.
    const key = fake([{ stopReason: "error", errorMessage: "401 Incorrect API key provided" }]);
    assert.equal((await keepGoing(key.agent, never, 32_768, undefined, quick))?.kind, "auth");
    // A rate limit: the trial waits for the provider's time (its Retry-After, as Pi's watch saw
    // it) and goes on in the same conversation; it never counts as a failure.
    const { ProviderWatch } = await import("../../../../src/harness/agents/provider-errors.ts");
    const watch = new ProviderWatch();
    watch.last = { status: 429, headers: { "retry-after": "7" }, at: Date.now() };
    const limited = fake([
      { stopReason: "error", errorMessage: "429 Rate limit reached" },
      { stopReason: "stop" },
    ]);
    waits.length = 0;
    told.length = 0;
    assert.equal(
      await keepGoing(limited.agent, never, 32_768, undefined, { ...quick, watch }),
      undefined,
    );
    assert.equal(limited.calls(), 2, "it went on after the wait");
    assert.ok(waits[0] !== undefined && waits[0] > 6000 && waits[0] <= 7000, String(waits));
    assert.equal(told[0]?.kind, "rate_limit");
    // Its words give the time when no header does: "try again in 1m30s".
    const said = fake([
      { stopReason: "error", errorMessage: "Rate limit exceeded. Please try again in 1m30s." },
      { stopReason: "stop" },
    ]);
    waits.length = 0;
    await keepGoing(said.agent, never, 32_768, undefined, quick);
    assert.ok(waits[0] !== undefined && waits[0] > 89_000 && waits[0] <= 90_000, String(waits));
    // A provider's 5xx: a growing pause, and the trial goes on, however many in a row (no limit
    // by default).
    const down = fake([{ stopReason: "error", errorMessage: "503 Service Unavailable" }]);
    waits.length = 0;
    let more = 40;
    assert.equal(
      await keepGoing(down.agent, () => --more <= 0, 32_768, undefined, quick),
      undefined,
    );
    assert.deepEqual(waits.slice(0, 5), [5000, 10_000, 20_000, 40_000, 60_000]);
    assert.ok(down.calls() >= 10, "it kept going");
    // With the campaign's failures_in_a_row, that many failures end it.
    const capped = fake([{ stopReason: "error", errorMessage: "503 Service Unavailable" }]);
    const f3 = await keepGoing(capped.agent, never, 32_768, undefined, {
      ...quick,
      failuresInARow: 3,
    });
    assert.equal(f3?.stopped, "error");
    assert.match(String(f3?.error), /failed 3 times in a row .*failures_in_a_row/);
    assert.equal(capped.calls(), 3);
  });

  test("Pi: calls that fail for 30 minutes with no reply that worked end the trial with their kind; a reply between starts the count again (goal 079)", async () => {
    // A stand-in agent whose each prompt appends the next scripted reply (or replies: a run of
    // turns), and a clock that moves a minute for each wait.
    type Reply = { stopReason: string; errorMessage?: string };
    const fake = (replies: (Reply | Reply[])[]) => {
      const messages: unknown[] = [];
      const listeners = new Set<(e: unknown) => void>();
      let i = 0;
      const next = () => {
        const step = replies[Math.min(i++, replies.length - 1)] as Reply | Reply[];
        for (const r of Array.isArray(step) ? step : [step]) {
          const message = { role: "assistant", ...r, usage: { input: 10, output: 10 } };
          messages.push(message);
          for (const l of listeners) l({ type: "turn_end", message, toolResults: [] });
        }
      };
      next();
      return {
        state: { messages },
        prompt: async () => next(),
        subscribe: (l: (e: unknown) => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      } as never;
    };
    let clock = Date.parse("2026-10-22T03:00:00Z");
    const o = {
      sleep: async () => {
        clock += 60_000;
      },
      now: () => clock,
    };
    const down = { stopReason: "error", errorMessage: "503 Service Unavailable" };
    const count: FailureCount = { failures: 0, rateWaits: 0 };
    const end = await keepGoing(fake([down]), () => false, 32_768, undefined, { ...o, count });
    assert.equal(end?.stopped, "error");
    assert.equal(end?.kind, "server");
    assert.match(String(end?.error), /^no model call worked for 30 minutes/);
    assert.equal(clock - Date.parse("2026-10-22T03:00:00Z"), 30 * 60_000);
    assert.deepEqual(
      [count.failing?.since, count.failing?.kind],
      [Date.parse("2026-10-22T03:00:00Z"), "server"],
    );
    // A reply that came through after 20 minutes of failures: the count starts again from the
    // next failure (25 minutes more is not 30), and the trial goes on to the model's own stop.
    clock = Date.parse("2026-10-22T03:00:00Z");
    const replies: (Reply | Reply[])[] = [
      ...Array.from({ length: 20 }, () => down),
      [{ stopReason: "toolUse" }, down],
      ...Array.from({ length: 25 }, () => down),
      { stopReason: "stop" },
    ];
    assert.equal(await keepGoing(fake(replies), () => false, 32_768, undefined, o), undefined);
    assert.ok(clock - Date.parse("2026-10-22T03:00:00Z") >= 45 * 60_000, "it went on");
  });
});
