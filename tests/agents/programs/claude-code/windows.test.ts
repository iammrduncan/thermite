import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claudeProgram } from "../../../../src/agents/cli/index.ts";
import { readClaudeEvents } from "../../../../src/agents/programs/claude-code/events.ts";
import { newClaudeTally } from "../../../../src/agents/programs/claude-code/index.ts";
import { claudeTranscript } from "../../../../src/agents/programs/claude-code/transcript.ts";
import {
  creditsOn,
  mergeUsage,
  windowsOf,
  windowsOfStatus,
} from "../../../../src/agents/programs/claude-code/windows.ts";

const AT = 1_793_000_000;
const iso = (s: number) => new Date(s * 1000).toISOString();

describe("a Claude subscription's windows from Claude Code's events (goal 151)", () => {
  test("each event names one window; the other keeps its value", () => {
    const five = windowsOf(
      { status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: AT },
      undefined,
    );
    assert.deepEqual(five, { five_hour: { utilization: 0.42, resets_at: iso(AT) } });
    const both = windowsOf(
      {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.81,
        resetsAt: AT + 9,
      },
      five,
    );
    assert.deepEqual(both, {
      five_hour: { utilization: 0.42, resets_at: iso(AT) },
      seven_day: { utilization: 0.81, resets_at: iso(AT + 9) },
    });
    // A window Thermite doesn't show, or an event without a figure, changes nothing.
    assert.deepEqual(
      windowsOf({ rateLimitType: "overage", utilization: 1, resetsAt: AT }, both),
      both,
    );
    assert.deepEqual(windowsOf({ status: "rejected", rateLimitType: "five_hour" }, both), both);
  });

  test("an older event's unifiedWindows still reads", () => {
    const w = windowsOf(
      {
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: AT,
        unifiedWindows: {
          five_hour: { utilization: 0.34, resetsAt: AT },
          seven_day: { utilization: 0.61, resetsAt: AT + 86_400 },
        },
      },
      undefined,
    );
    assert.equal(w.five_hour?.utilization, 0.34);
    assert.equal(w.seven_day?.resets_at, iso(AT + 86_400));
  });

  test("the rig's report keeps a window a later trial hasn't reported yet", () => {
    const kept = mergeUsage(undefined, {
      five_hour: { utilization: 0.1, resets_at: iso(AT) },
      seven_day: { utilization: 0.5, resets_at: iso(AT + 1) },
    });
    const next = mergeUsage(kept, { five_hour: { utilization: 0.2, resets_at: iso(AT + 2) } });
    assert.equal(next.five_hour?.utilization, 0.2);
    assert.equal(next.seven_day?.utilization, 0.5);
    assert.ok(!Number.isNaN(Date.parse(next.at)));
  });
});

describe("a Claude subscription's usage credits, from Claude Code to the rig's report (goal 169)", () => {
  test("its overageStatus: allowed or allowed_warning on, rejected off, anything else says nothing", () => {
    assert.equal(creditsOn("allowed"), true);
    assert.equal(creditsOn("allowed_warning"), true);
    assert.equal(creditsOn("rejected"), false);
    assert.equal(creditsOn(undefined), undefined);
    assert.equal(creditsOn("something new"), undefined);
  });

  test("headless: a rate_limit_event's overageStatus reaches the tally's windows", () => {
    const t = newClaudeTally();
    const event = (overageStatus: string) =>
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 0.5,
          resetsAt: AT,
          overageStatus,
        },
      });
    readClaudeEvents([event("allowed")], t);
    assert.deepEqual(t.usage?.credits, { on: true, since: null });
    readClaudeEvents([event("rejected")], t);
    assert.deepEqual(t.usage?.credits, { on: false, since: null });
  });

  test("in its terminal: its transcript's record of a usage limit gives them, through the session log", () => {
    // As Claude Code 2.1.308 records a full window: quotaLimits with its overageStatus.
    const record = JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-01T14:02:00.000Z",
      message: {
        id: "limit-1",
        model: "<synthetic>",
        role: "assistant",
        type: "message",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: "text", text: "You've hit your weekly limit · resets Mon 6pm (UTC)" }],
      },
      apiError: "usage_limit_reached",
      apiErrorParams: {
        rate_limit_info: { resetsAt: AT, rateLimitType: "seven_day", overageStatus: "allowed" },
      },
      error: "rate_limit",
      isApiErrorMessage: true,
      sessionId: "s-1",
    });
    const events = claudeTranscript.read([record], claudeTranscript.newState());
    const limit = events.find((e) => e.type === "limit");
    assert.equal(limit?.type === "limit" ? limit.overage : undefined, "allowed");
    const t = newClaudeTally();
    for (const e of events) claudeProgram.terminal?.take?.(e, t, 0);
    assert.deepEqual(claudeProgram.windows?.(t)?.credits, { on: true, since: null });
  });

  test("the rig keeps since when they are so: none from the first report, a time from each change", () => {
    const first = mergeUsage(undefined, { credits: { on: true, since: null } });
    assert.deepEqual(first.credits, { on: true, since: null });
    // The same again, or a report without them, keeps them as they were.
    assert.deepEqual(
      mergeUsage(first, { credits: { on: true, since: null } }).credits,
      first.credits,
    );
    assert.deepEqual(mergeUsage(first, {}).credits, first.credits);
    // Off, then on again: each change starts its own time.
    const off = mergeUsage(first, { credits: { on: false, since: null } });
    assert.equal(off.credits?.on, false);
    assert.ok(off.credits?.since);
    const again = mergeUsage(off, { credits: { on: true, since: null } });
    assert.equal(again.credits?.on, true);
    assert.ok((again.credits?.since ?? "") >= (off.credits?.since ?? ""));
    // A report that never gave them has none.
    assert.equal(mergeUsage(undefined, {}).credits, undefined);
  });
});

test("in its own terminal, the windows come from its status line's rate_limits, a percent and seconds (goal 183)", () => {
  const was = { seven_day: { utilization: 0.1, resets_at: iso(AT + 86_400) } };
  const w = windowsOfStatus(
    { rate_limits: { five_hour: { used_percentage: 42, resets_at: AT } } },
    was,
  );
  assert.deepEqual(w, {
    five_hour: { utilization: 0.42, resets_at: iso(AT) },
    seven_day: was.seven_day,
  });
  assert.deepEqual(windowsOfStatus({}, undefined), {});
  assert.deepEqual(
    windowsOfStatus(
      { rate_limits: { five_hour: { used_percentage: "x", resets_at: AT } } },
      undefined,
    ),
    {},
  );
});
