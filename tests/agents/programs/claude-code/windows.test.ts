import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mergeUsage, windowsOf } from "../../../../src/agents/programs/claude-code/windows.ts";

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
